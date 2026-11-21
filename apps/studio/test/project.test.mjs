import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createStore} from '../src/project.mjs';
import {portableProject} from '../src/library.mjs';
import {createMusic} from '../src/music.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'vs-project-'));
  const store=createStore(path.join(root,'studio'),{probeMedia:async()=>({kind:'video',hasAudio:true,width:320,height:180,duration:20})});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const p=store.create({mode:'script',title:'工作台回归',profile:{width:320,height:180,fps:30}});
  const file=path.join(root,'clip.mov');await writeFile(file,'local media stub');
  return {root,store,p,file};
}
test('atomic revisions, imported content identity, scene locks and concurrent agent edit',async t=>{
  const {store,p,file}=await fixture(t);
  const [a,b]=await Promise.all([store.addAsset(p.id,file),store.addAsset(p.id,file)]);
  assert.equal(a.id,b.id);assert.equal(store.get(p.id).revision,2);
  const v={id:'v',track:'video',assetId:a.id,start:0,duration:100,sourceIn:16,gain:1};
  const locked=store.apply(p.id,2,[{op:'add',clip:v},{op:'lock',id:'v',locked:true}]);
  assert.throws(()=>store.apply(p.id,locked.revision,[{op:'update',id:'v',changes:{gain:0}}],'codex'),/锁/);
  assert.throws(()=>store.apply(p.id,locked.revision,[{op:'add',clip:{...v,id:'overlap'}}],'codex'),/锁/);
  assert.throws(()=>store.apply(p.id,2,[{op:'remove',id:'v'}]),/新版本/);
  assert.throws(()=>store.apply(p.id,3,[{op:'add',clip:{id:'sub',track:'caption',start:4,duration:20,text:'字幕'}},{op:'remove',id:'missing'}]),/改变/);
  assert.equal(store.get(p.id).timeline.clips.length,1);
  assert.throws(()=>store.setMeta(p.id,{timeline:{clips:[]}}),/编辑接口/);
  store.setMeta(p.id,{threadId:'fixture'});assert.equal(store.get(p.id).revision,3);
});
test('portable project validates hash, re-probes inputs, restores locks and rejects forged duration',async t=>{
  const {store,p,file,root}=await fixture(t);const a=await store.addAsset(p.id,file);
  const edited=store.apply(p.id,2,[{op:'add',clip:{id:'v',track:'video',assetId:a.id,start:0,duration:30}},{op:'lock',id:'v',locked:true}]);
  const manifest=await portableProject(edited,path.join(root,'portable'));
  const opened=await store.importSnapshot(manifest);assert.notEqual(opened.id,p.id);assert.equal(opened.timeline.clips[0].locked,true);
  const m=JSON.parse(await readFile(manifest));m.assets[0].duration=10000;m.timeline.clips[0].duration=3111;
  await writeFile(manifest,JSON.stringify(m));await assert.rejects(store.importSnapshot(manifest),/原片/);
  await writeFile(path.resolve(path.dirname(manifest),m.assets[0].path),'changed');await assert.rejects(store.importSnapshot(manifest),/指纹|内容/);
  assert.equal(store.list().length,2);
});
test('unknown or repeated paid requests cannot silently submit a second order',async t=>{
  const {store,p,file}=await fixture(t);store.configure(p.id,1,{settings:{cloudEnabled:true,cloudBudget:10}});
  let count=0;const music=createMusic(store,async()=>{count++;throw Error('response lost');});music.connect('test-only');
  const input={requestId:'test-receipt',prompt:'light strings',seconds:6};
  await assert.rejects(music.compose(p.id,input),/response lost/);await assert.rejects(music.compose(p.id,input),/记录/);
  await assert.rejects(music.compose(p.id,{...input,requestId:'new-receipt'}),/待核实/);assert.equal(count,1);
  music.reconcile(p.id,{requestId:input.requestId,charged:true});await assert.rejects(music.compose(p.id,{...input,requestId:'new-receipt'}),/预算/);
 const asset=await store.addAsset(p.id,file,{requestId:input.requestId,provider:'ElevenLabs Music'});
 const recovered=await music.check(p.id,input.requestId);
 assert.equal(recovered.status,'done');assert.equal(recovered.assetId,asset.id);assert.equal(count,1);
});
test('authorized local voice can be reused in a second project with its actual reference hash',async t=>{
  const {store,p,file}=await fixture(t);const {voiceLibrary}=await import('../src/voices.mjs');const library=voiceLibrary(store);
  const a=await store.addAsset(p.id,file);
  await assert.rejects(library.enroll(p.id,{name:'测试',assetId:a.id,referenceText:'你好'}),/授权/);
  const voice=await library.enroll(p.id,{name:'测试',assetId:a.id,referenceText:'你好',consent:true});
  const target=store.create({mode:'script'});const result=await library.use(target.id,voice.id,target.revision);
  assert.equal(result.settings.referenceHash,a.sha256);assert.equal(result.settings.voiceConsent,true);assert.notEqual(result.settings.voiceReferenceAssetId,a.id);
  assert.equal((await library.list()).length,1);
});
