// Read a portable existing project and its paired full MP4. All edits and playback
// proxies live in a temporary library. No Codex session or production job is started.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyFile,mkdir,mkdtemp,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {startStudio} from '../src/server.mjs';
import {createStyleLibrary} from '../src/style.mjs';
import {fileHash,probeMedia,frameAt} from '../src/media.mjs';
import {requiredTool} from '../src/media-runtime.mjs';
import {timelineFrames} from '../src/playback-identity.mjs';

const [projectFile,existingCut]=process.argv.slice(2);
if(!projectFile||!existingCut)throw Error('用法：node scripts/verify-timeline-player.mjs 原工程.vstudio.json 对应的成片.mp4');
const exec=promisify(execFile);
const root=await mkdtemp(path.join(os.tmpdir(),'vs-player-webkit-'));
const app=await startStudio({root});
try{
  const p=await app.store.importSnapshot(path.resolve(projectFile),createStyleLibrary(root));
  const count=timelineFrames(p),fps=p.profile.fps,info=await probeMedia(path.resolve(existingCut));
  assert.equal(info.frames,count);assert.equal(info.width,p.profile.width);assert.ok(count>12*fps+4);
  const at=fps*6-3;
  const script=path.join(root,'probe.js'),helper=path.join(root,'webkit-playback');
  await exec('/usr/bin/xcrun',['swiftc',fileURLToPath(new URL('../test/timeline-player-webkit.swift',import.meta.url)),'-o',helper]);
  // Use the actual playback component in an ordinary WKWebView with a native click.
  await writeFile(script,`
    const report=v=>webkit.messageHandlers.transport.postMessage(v);
    try{
      const {createTimelinePlayer}=await import('/timeline-player.js');
      const p=await (await fetch('/api/projects/'+projectId)).json(),v=document.createElement('video'),box=document.createElement('div');
      Object.assign(box.style,{position:'fixed',inset:'0',background:'black',zIndex:9999});box.append(v);document.body.append(box);
      const button=document.createElement('button');button.textContent='播放';Object.assign(button.style,{position:'fixed',left:'0',top:'0',width:'100px',height:'70px',zIndex:99999});document.body.append(button);
      let state={},current=0,crossed=false,clicked=false;const statuses=[],began=performance.now();let firstStillMs,playClickMs,firstPlayMs;
      const player=createTimelinePlayer({project:p,video:v,onFrame:f=>{current=f;if(f>=boundary+4)crossed=true;},onState:s=>{state=s;statuses.push([s.status,s.source,s.frame,Math.round(performance.now()-began)]);if(s.status==='playing'&&firstPlayMs==null)firstPlayMs=Math.round(performance.now()-playClickMs);}});
      const wait=async check=>{const start=performance.now();while(!check()){if(state.status==='error')throw Error(state.error);if(performance.now()-start>70000)throw Error('状态超时 '+JSON.stringify(statuses));await new Promise(r=>setTimeout(r,20));}};
      await wait(()=>state.status==='paused');firstStillMs=Math.round(performance.now()-began);await player.seek(seekStart);
      if(player.frame!==seekStart)throw Error('错帧');button.onclick=()=>{clicked=true;playClickMs=performance.now();player.play();};
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      for(let i=0;i<4&&!clicked;i++){report({click:true});await new Promise(r=>setTimeout(r,180));}
      await wait(()=>clicked&&crossed);await player.pause();await wait(()=>state.status==='paused');
      await player.step(-1);await wait(()=>state.status==='paused');const afterStep=player.frame;
      player.seek(1,{scrub:true});player.seek(5,{scrub:true});await player.seek(boundary+1);
      await wait(()=>state.status==='paused'&&player.frame===boundary+1);
      const played=statuses.filter(s=>s[0]==='playing').map(s=>s[2]);if(!played.includes(boundary))throw Error('没有连续切换预览窗口');
      player.destroy();report({clicked,crossed,played,afterStep,firstStillMs,firstPlayMs,statuses:statuses.slice(-12)});
    }catch(e){report({error:String(e),stack:e.stack});}
  `.replaceAll('projectId',JSON.stringify(p.id)).replaceAll('boundary',String(at+6*fps)).replaceAll('seekStart',String(at)));
  const checked=await exec(helper,[app.url,script],{timeout:106000}).catch(e=>{throw Error(e.stdout||e.stderr||'系统 WebView 未完成验证');});
  const browser=JSON.parse(checked.stdout);
  assert.ok(browser.clicked&&browser.crossed);
  const first=await fetch(app.url,{redirect:'manual'}); // The entry token is single-use; use the service directly below.
  assert.equal(first.status,403);
  const draftDir=path.join(app.store.paths(p.id).cache,'drafts');
  const files=await readdir(draftDir),still=files.find(f=>f.endsWith('-'+at+'-'+(at+1)+'.jpg'));
  assert.ok(still,'resolved initial scrub as a composited project frame');
  const reference=path.join(root,'original-frame.jpg');
  await frameAt(path.resolve(existingCut),at/fps,reference);
  const ffmpeg=await requiredTool('ffmpeg');
  async function sample(file){return (await exec(ffmpeg,['-v','error','-i',file,'-frames:v','1','-vf','scale=80:46','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer'})).stdout;}
  const [actual,original]=await Promise.all([sample(path.join(draftDir,still)),sample(reference)]);
  const meanError=actual.reduce((sum,v,i)=>sum+Math.abs(v-original[i]),0)/actual.length;
  assert.ok(meanError<9,'composited draft differs from its existing full-cut frame: '+meanError);
  // Verify actual media remains eligible across non-pixel changes and a replaced frame invalidates it.
  const dir=path.join(app.store.paths(p.id).outputs,'acceptance-export');
  await mkdir(dir,{recursive:true});const cut=path.join(dir,'video.mp4');await copyFile(existingCut,cut,constants.COPYFILE_FICLONE);
  app.store.saveJob({id:'acceptance-export',projectId:p.id,kind:'render',status:'done',revision:p.revision,snapshot:p,
    files:{video:cut},qa:{artifactSha256:await fileHash(cut),candidatePlayable:true}});
  const {timelinePlayback}=await import('../src/timeline-playback.mjs'),{draftPreviews}=await import('../src/draft-preview.mjs'),media=await import('../src/media.mjs');
  const drafts=draftPreviews(app.store,media),playback=timelinePlayback(app.store,media,drafts);
  try{
    const reused=await playback.describe(p,{revision:p.revision,frame:at,mode:'play'});
    assert.equal(reused.source,'cut');assert.equal(await playback.file(p,reused.name,{revision:p.revision,identity:new URL(reused.url,'http://localhost').searchParams.get('identity')}),await realpath(cut));
    const edit=app.store.apply(p.id,p.revision,[{op:'add',clip:{id:'only-in-this-verification',track:'caption',text:'帧定位',start:at,duration:9}}]);
    const fresh=await playback.describe(edit,{revision:edit.revision,frame:at,mode:'still'});assert.equal(fresh.source,'frame');
    console.log(JSON.stringify({profile:p.profile,frames:count,scrubFrame:at,meanRGBError:Number(meanError.toFixed(3)),fullCut:reused.source,afterEdit:fresh.source,browser},null,2));
  }finally{await drafts.close();}
}finally{await app.close();await rm(root,{recursive:true,force:true});}
