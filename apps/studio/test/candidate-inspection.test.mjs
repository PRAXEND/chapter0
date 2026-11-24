import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as media from '../src/media.mjs';
import {createStore} from '../src/project.mjs';
import {createDirector} from '../src/production.mjs';
import {candidateFeedback,openCandidate} from '../src/candidate-inspection.mjs';

test('final-mix evidence excludes machine transcripts and free-text findings when their sharing is closed',()=>{
  const data={audio:{truePeakDbtp:-.8,finalTranscript:{status:'ok',utterances:[{start:1,text:'私密句子'}]}},
    review:{issues:[{id:'subject',fromFrame:8,message:'画面文字是私密句子'}],path:'/Users/example/private.mov'}};
  const hidden=JSON.stringify(candidateFeedback(data,false)),open=candidateFeedback(data,true);
  assert.match(hidden,/truePeakDbtp/);assert.doesNotMatch(hidden,/私密|finalTranscript|private.mov/);
  assert.equal(open.audio.finalTranscript.utterances[0].text,'私密句子');assert.equal(open.review.path,undefined);
});

test('the director sends the frozen MP4 as native images, can inspect more times after an edit, and detects later user revisions',async t=>{
  const caps=await media.mediaCapabilities();if(!caps.ready)return t.skip('requires FFmpeg and ffprobe');
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-candidate-review-')),store=createStore(root,{probeMedia:media.probeMedia});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  let p=store.create({mode:'script',brief:'解释一项动作。调整 18–24 秒。全片时长 2–3 秒。',profile:{width:160,height:96,fps:12},settings:{shareFrames:true,shareTranscript:false,sourceScope:'project'}});
  const src=path.join(root,'pattern.mp4');
  await promisify(execFile)(caps.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=160x96:rate=12:duration=5','-c:v','libx264','-pix_fmt','yuv420p',src]);
  const a=await store.addAsset(p.id,src),shot={track:'video',id:'shot',assetId:a.id,start:0,duration:30,sourceIn:0,muted:true};
  p=store.apply(p.id,store.get(p.id).revision,[{op:'add',clip:shot},{op:'add',clip:{id:'locked',track:'caption',start:0,duration:6,text:'检验'}},{op:'lock',id:'locked',locked:true}]);
  const first=structuredClone(p),folder=path.join(store.paths(p.id).outputs,'first');
  const render=await media.renderProject(p,{directory:store.paths(p.id).directory,output:path.join(folder,'video.mp4')});
  const qa={candidatePlayable:true,artifactSha256:render.sha256};
  store.saveJob({id:'first',projectId:p.id,revision:p.revision,status:'done',snapshot:first,files:{video:render.videoPath},qa});
  const ref={jobId:'first',revision:p.revision,videoPath:render.videoPath,sha256:render.sha256,feedback:{review:{issues:[{id:'cue',message:'私密句子',fromFrame:9,toFrame:13}]},audio:{truePeakDbtp:-1.1,finalTranscript:{text:'私密句子'}}}};
  let turns=0,accounts=0;
  const client={account:async()=>{accounts++;return {connected:true};},thread:async()=>'thread',findTurn:async()=>({turn:{status:'completed',items:[]},status:{type:'idle'}}),close(){},
    async runTurn({images,prompt,onStart,tool}) {
      turns++;await onStart('turn-one');
      assert.ok(images.length>=7&&images.some(i=>i.frame.frame===29)&&images.some(i=>i.frame.frame===9));
      assert.ok(images.every(i=>i.label.includes('首版 MP4')&&i.label.includes('秒')&&i.url.startsWith('data:image/jpeg;base64,/9j/')));
      assert.match(prompt,/没有给你音频/);assert.match(prompt,/truePeakDbtp/);assert.doesNotMatch(prompt,/私密句子|pattern.mp4/);
      const call=(name,args)=>tool({tool:name,arguments:args});
      const context=JSON.parse((await call('studio_context',{})).contentItems[0].text);
      assert.deepEqual(context.timing.allowedSeconds,{min:2,max:3});assert.equal(context.timing.withinRequestedRange,true);
      const fixedFrame=await call('studio_frame',{source:'candidate',seconds:.75});
      assert.equal(fixedFrame.contentItems[0].imageUrl,images.find(i=>i.frame.frame===9).url);
      await assert.rejects(call('studio_edit',{baseRevision:p.revision,commandsJson:JSON.stringify([{op:'remove',id:'locked'}])}),/锁定/);
      await call('studio_edit',{baseRevision:p.revision,commandsJson:JSON.stringify([{op:'update',id:'shot',changes:{sourceIn:12}}])});
      const seq=await call('studio_frames',{source:'candidate',startSeconds:.75,count:3});
      assert.equal(seq.contentItems[1].imageUrl,fixedFrame.contentItems[0].imageUrl);
      assert.match(seq.contentItems[4].text,/工程帧 11/);
      await assert.rejects(call('studio_frames',{source:'candidate',seconds:[1.75,999]}),/范围/);
      assert.ok(!store.get(p.id).candidateInspection.requests.some(f=>f.frame===21));
      const latest=await call('studio_frame',{source:'timeline',seconds:.75});
      assert.notEqual(latest.contentItems[0].imageUrl,fixedFrame.contentItems[0].imageUrl);
      await assert.rejects(call('studio_frame',{source:'candidate',seconds:12}),/范围/);
      return '已回看并修改实际镜头。';
    }};
  const deps={store,media,audio:{},styleLibrary:{get:async()=>({id:'neutral',rules:[]})},client};
  let retainedTurns=0;
  const retained=createDirector({...deps,client:{...client,async runTurn({onStart,images}){
    retainedTurns++;await onStart('kept');assert.ok(images.length>0);return '画面符合本期说明，保留这版。';
  }}});
  t.after(()=>retained.close());
  const keep={kind:'revise',jobId:'retained-review',reviewCandidate:ref};
  assert.equal((await retained.run(p.id,keep)).changed,false);assert.equal(store.get(p.id).revision,first.revision);
  assert.equal(store.get(p.id).candidateInspection.status,'retained');
  assert.equal((await retained.run(p.id,keep)).changed,false);assert.equal(retainedTurns,1);
  const d=createDirector(deps);t.after(()=>d.close());
  const args={kind:'revise',jobId:'second',message:'审阅首版并自行决定修改。',reviewCandidate:ref};
  const result=await d.run(p.id,args);assert.equal(result.changed,true);
  const after=store.get(p.id);assert.equal(after.timeline.clips.find(c=>c.id==='shot').sourceIn,12);
  assert.equal(after.candidateInspection.status,'revised');assert.equal(after.directorState.observedRevision,after.revision);
  assert.ok(after.candidateInspection.requests.some(f=>f.source==='candidate'&&f.frame===11));
  assert.equal(await media.fileHash(render.videoPath),ref.sha256);
  assert.equal((await d.run(p.id,args)).changed,true);assert.equal(turns,1);
  const external=store.configure(p.id,after.revision,{title:'用户在上轮完成后改了片名'});
  await assert.rejects(d.run(p.id,args),/其他编辑/);assert.equal(turns,1);
  const noImages=store.configure(p.id,external.revision,{settings:{shareFrames:false}});
  const beforeAccounts=accounts;await assert.rejects(d.run(p.id,args),/关闭成片帧分享/);assert.equal(accounts,beforeAccounts);
  const restored=store.configure(p.id,noImages.revision,{settings:{shareFrames:true}});
  const real=await readFile(render.videoPath);
  await writeFile(render.videoPath,Buffer.concat([real,Buffer.from('x')]));
  await assert.rejects(openCandidate(deps,restored,ref),/指纹/);
  const outside=path.join(root,'outside.mp4');await writeFile(outside,real);
  await mkdir(path.join(folder,'nested'));const alias=path.join(folder,'nested','fake.mp4');await symlink(outside,alias);
  await assert.rejects(openCandidate(deps,restored,{...ref,videoPath:alias}),/已登记/);
});
