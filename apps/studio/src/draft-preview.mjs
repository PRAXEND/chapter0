import path from 'node:path';
import {stat,readFile,readdir,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {fault} from './project.mjs';
import {playbackIdentity,timelineFrames} from './playback-identity.mjs';

// Projects can be reopened at the same revision after upgrading the compositor.
const inputs=['./media.mjs','./motion-components.mjs','./motion-dom.mjs','./motion-render.mjs','./motion-font.mjs',
  './motion-jsx.generated.mjs','../scripts/motion-webkit.swift','../www/motion-clock.js',
  './presentation.mjs','../www/clip-automation.js','./clip-mask.mjs','./clip-edit.mjs','./framing.mjs','./news-effects.mjs','./graphic-keys.mjs','./text-tracks.mjs','./polygon.mjs','./viewport.mjs'];
const rendererVersion=Promise.all(inputs.map(name=>readFile(new URL(name,import.meta.url)))).then(parts=>{
  const hash=createHash('sha256').update(os.release());
  for(const bytes of parts)hash.update(bytes);
  return hash.digest('hex');
});
const safeFile=/^[a-f0-9]{16}-\d+-\d+-\d+\.(mp4|jpg)$/;
// Independent QA must never compare an encoded candidate against its own preview.
export async function draftPrefix(p,fromFrozenPicture=false) {
  return createHash('sha256').update(await rendererVersion).update(playbackIdentity(p)).update(fromFrozenPicture?'frozen-picture':'timeline-composition').digest('hex').slice(0,16)+'-'+p.revision+'-';
}
export function draftPreviews(store,media){
  const active=new Map(),lastClean=new Map();
  let stillQueue=Promise.resolve(),windowQueue=Promise.resolve(),closed=false;
  // On a small Mac one scrub and one playback segment may run while an export is in progress.
  // A new drag cancels its predecessor before taking a decoder or native WebKit process.
  function schedule(task,still){
    const prior=still?stillQueue:windowQueue;
    const next=prior.then(task,task);
    if(still)stillQueue=next.catch(()=>{});else windowQueue=next.catch(()=>{});
    return next;
  }
  async function share(file,producer,signal){
    signal?.throwIfAborted();
    if(closed)throw fault('预览服务已关闭。',503);
    if((await stat(file).catch(()=>null))?.size)return;
    signal?.throwIfAborted();
    let entry=active.get(file);
    if(!entry||entry.controller.signal.aborted){
      const controller=new AbortController();
      entry={controller,users:0};
      entry.work=schedule(()=>{controller.signal.throwIfAborted();return producer(controller.signal);},file.endsWith('.jpg'))
        .finally(()=>{if(active.get(file)===entry)active.delete(file);});
      active.set(file,entry);
    }
    entry.users++;let cancel;
    try{
      if(!signal)return await entry.work;
      await Promise.race([entry.work,new Promise((_,reject)=>{
        cancel=()=>reject(signal.reason);signal.addEventListener('abort',cancel,{once:true});
        if(signal.aborted)cancel();
      })]);
    }finally{
      if(cancel)signal.removeEventListener('abort',cancel);
      if(--entry.users===0 && active.get(file)===entry)entry.controller.abort();
    }
  }
  async function trim(directory){
    const now=Date.now();
    if(now-(lastClean.get(directory)||0)<30000)return;
    lastClean.set(directory,now);
    const names=await readdir(directory).catch(()=>[]);
    const rows=(await Promise.all(names.filter(n=>safeFile.test(n)).map(async name=>{
      const file=path.join(directory,name),s=await stat(file).catch(()=>null);
      return s&&{file,time:s.mtimeMs,size:s.size};
    }))).filter(Boolean).sort((a,b)=>a.time-b.time);
    let bytes=rows.reduce((n,f)=>n+f.size,0);
    for(const f of rows){
      if(bytes<=256*1024**2||f.time>now-120000)break;
      if(active.has(f.file))continue;
      await unlink(f.file).catch(()=>{});bytes-=f.size;
      if(f.file.endsWith('.mp4'))await unlink(f.file.slice(0,-4)+'.srt').catch(()=>{});
    }
  }
  async function cachedSegment(project,frame,minAhead=1,fromFrozenPicture=false){
    const folder=path.join(store.paths(project.id).cache,'drafts'),prefix=await draftPrefix(project,fromFrozenPicture),length=timelineFrames(project);
    const names=await readdir(folder).catch(()=>[]);
    let best;
    for(const name of names){
      if(!name.startsWith(prefix)||!name.endsWith('.mp4')||!safeFile.test(name))continue;
      const [fromFrame,toFrame]=name.slice(prefix.length,-4).split('-').map(Number);
      if(fromFrame<=frame && toFrame-frame>=Math.min(minAhead,length-frame) && (!best||toFrame>best.toFrame))
        best={name,revision:project.revision,fromFrame,toFrame};
    }
    return best;
  }
  async function request(project,frame,mode,signal,frozenPicture){
    signal?.throwIfAborted();
    if(!Number.isSafeInteger(frame)||frame<0)throw fault('请选择有效的预览帧。');
    const length=timelineFrames(project);
    if(!length)throw fault('时间线上出现片段后即可预览。',409);
    if(frame>=length&&mode!=='draft')throw fault('播放头已超出时间线。',422);
    const span=6*project.profile.fps,still=mode==='still';
    if(mode==='window'){
      const present=await cachedSegment(project,frame,2*project.profile.fps,Boolean(frozenPicture));
      if(present)return present;
    }
    const grid=Math.floor(frame/span)*span;
    // Starting at the end of a cold grid bucket must not decode six seconds just to
    // play a few frames and stall. Give the next segment a full prefetch interval.
    const fromFrame=still?frame:mode==='draft'?Math.max(0,Math.min(frame,length-span)):frame-grid>span/2?frame:grid;
    const toFrame=Math.min(length,still?frame+1:fromFrame+span);
    const name=(await draftPrefix(project,Boolean(frozenPicture)))+fromFrame+'-'+toFrame+(still?'.jpg':'.mp4');
    const directory=store.paths(project.id).cache,folder=path.join(directory,'drafts'),output=path.join(folder,name);
    await share(output,async signal=>{
      if(still){
        if(frozenPicture&&media.frameAt){
          const seconds=Math.max(0,frame/project.profile.fps-0.000001);
          return media.frameAt(frozenPicture,seconds,output,{signal,maxWidth:960});
        }
        return media.renderProjectFrame(project,{directory,output,frame,signal});
      }
      const render=mode==='window'&&media.renderPreviewWindow||media.renderProject;
      return render(project,{directory,output,preview:true,window:{fromFrame,toFrame},signal,frozenPicture});
    },signal);
    signal?.throwIfAborted();await trim(folder);
    return {name,revision:project.revision,fromFrame,toFrame};
  }
  async function close(){
    closed=true;const pending=[...active.values()];for(const e of pending)e.controller.abort();
    await Promise.allSettled([...pending.map(e=>e.work),stillQueue,windowQueue]);
  }
  return {cachedSegment,open:(p,f=0,s)=>request(p,f,'draft',s),still:(p,f,s,picture)=>request(p,f,'still',s,picture),segment:(p,f,s,picture)=>request(p,f,'window',s,picture),close};
}
