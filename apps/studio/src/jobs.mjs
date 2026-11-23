import {activeStyleMusicCredit} from './style-audio.mjs';
import path from 'node:path';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import {makePublicationPackage} from './publication.mjs';
import {styleAudioPolicy} from './style-audio.mjs';
import { randomUUID } from 'node:crypto';
import { portableProject, publishDelivery } from "./library.mjs";
import { fault } from './project.mjs';
const stamp=()=>new Date().toISOString();
const activeStates=['queued','running','pausing'];
export function createQueue({store, director, media, reviewProject, comparePreview, prepare, deliveryRoot, styles}) {
  const running=new Map();
  let stopping=false, scheduled=false;
  function change(id,patch){return store.saveJob({...store.getJob(id),...patch,updatedAt:stamp()});}
  function event(id,message) {
    const j=store.getJob(id);
    const msg=typeof message==='string'?message:message?.message||message?.text||message?.type;
    if(!msg)return;
    change(id,{events:[...(j.events||[]),{at:stamp(),message:String(msg).slice(0,1400)}].slice(-120)});
  }
  function kick(){
    if(stopping||scheduled)return;
    scheduled=true;
    queueMicrotask(()=>{
      scheduled=false;if(stopping||running.size)return;
      const next=store.listJobs().filter(j=>j.status==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];
      if(next)execute(next).catch(e=>console.error('工作任务登记失败',e.message));
    });
  }
  function enqueue(projectId,kind,input={}) {
    const p=store.get(projectId);
    if(!['produce','revise','preview','render'].includes(kind))throw fault('未知任务。');
    if(['produce','revise'].includes(kind)){
      const engine=input.engine??(p.settings.engine==='local'?'local':'codex');
      if(!['local','codex'].includes(engine))throw fault('创作引擎无效。');
      input={...input,engine};
    }
    const previous=store.listJobs(projectId).find(j=>activeStates.includes(j.status));
    if(previous)throw fault('此工程正在处理任务，可先暂停或等待完成。',409);
    if(input.baseRevision!==undefined&&input.baseRevision!==p.revision)throw fault('工程已改变，请刷新后重新提交。',409);
    const id=randomUUID(), j={id,projectId,kind,input,status:'queued',phase:['produce','revise'].includes(kind)?'creative':'render',
      revision:p.revision,snapshot:['preview','render'].includes(kind)?p:undefined,createdAt:stamp(),updatedAt:stamp(),events:[],repairs:0};
    store.saveJob(j);kick();return j;
  }
  async function execute(initial){
    const ctrl=new AbortController(), signal=ctrl.signal;running.set(initial.id,ctrl);
    const id=initial.id, projectId=initial.projectId;
    change(id,{status:'running',error:null});const note=m=>event(id,m);
    try{
      let j=store.getJob(id);
      if(j.phase==='creative'){
        if(prepare)await prepare(store.get(projectId),{signal,onProgress:note,kind:j.kind,message:j.input?.message});
        note('正在组织素材和剪辑');
        const outcome=await director.run(projectId,{...j.input,jobId:id,kind:j.kind,signal,onEvent:note});
        if(signal.aborted)throw signal.reason;
        const p=store.setMeta(projectId,{lastDirection:{message:String(outcome?.message||''),engine:outcome?.engine,needsReview:outcome?.needsReview||null}});
        change(id,{phase:'render',revision:p.revision,snapshot:p,creativeResult:{message:outcome?.message,engine:outcome?.engine,needsReview:outcome?.needsReview||false}});
        if(!p.timeline.clips.some(c=>c.track==='video'))throw fault(outcome?.message||'草稿缺少可用画面，请导入素材。');
      }
      j=store.getJob(id);
      // Freeze the edit graph; a direct edit during rendering belongs to the next delivery.
      const p=j.snapshot||store.revision(projectId,j.revision);
      const directory=path.join(store.paths(projectId).outputs,j.id,...(j.repairs?['repair-'+j.repairs]:[]));
      await mkdir(directory,{recursive:true,mode:0o700});
      const output=path.join(directory,j.kind==='preview'?'preview.mp4':'video.mp4');
      if(j.phase==='render'){
        note('正在本地渲染');const res=await media.renderProject(p,{directory,output,preview:j.kind==='preview',signal,onProgress:n=>{
          if(typeof n==='number')change(id,{progress:n}); else if(typeof n==='string')note(n);
        }});
        signal.throwIfAborted();
        change(id,{phase:'review',files:{video:res.videoPath,subtitle:res.srtPath}});
      }
      j=store.getJob(id);note('正在核对实际导出文件');
      const styleSpec=styles?.get && p.style ? await styles.get(p.style.id,p.style.version) : undefined;
      const musicPolicy=styleAudioPolicy(styleSpec)?.music;
      const styleMusicResource=musicPolicy&&styles?.getMusicResource?await styles.getMusicResource(p.style.id,p.style.version,musicPolicy):null;
      const qa=await reviewProject(p,{videoPath:j.files.video,srtPath:j.files.subtitle,signal,comparePreview,preview:j.kind==='preview',findings:p.findings||[],styleSpec,styleMusicResource});
      signal.throwIfAborted();
      const remedy=qa.repairs?.[0];
      if(remedy && !qa.deliverable && j.repairs<2 && store.get(projectId).revision===p.revision){
        let next=p;
        if(remedy.kind==='edit'){
          if(remedy.baseRevision!==p.revision)throw fault('修复所依据的工程版本已改变。',409);
          next=store.apply(projectId,p.revision,remedy.commands,'repair');
        }else if(remedy.kind!=='regenerate-subtitles')throw fault('无法执行该修复。');
        note(remedy.reason||'修复后重新检查成片');
        change(id,{status:'queued',phase:'render',repairs:j.repairs+1,revision:next.revision,snapshot:next,priorCandidates:[...(j.priorCandidates||[]),{revision:j.revision,files:j.files,qa}]});
        return;
      }
      let files={...j.files};
      if(p.settings.publishPackage&&j.kind!=='preview')files={...files,...await makePublicationPackage(p,{videoPath:files.video,directory,media,signal})};
      const used=new Set(p.timeline.clips.map(c=>c.assetId));
      const sources=p.assets.filter(a=>used.has(a.id)&&a.source&&(a.source.url||a.source.license||a.source.licenseUrl||a.source.credit||a.source.rights));
      const facts=p.facts||[];
      const musicCredit=activeStyleMusicCredit(p);
      if(sources.length||facts.length||musicCredit){
        files.credits=path.join(directory,'素材与事实来源.txt');
        const lines=sources.filter(a=>a.id!==musicCredit?.assetId).map(a=>[a.name,a.source.credit||a.source.author,a.source.license||a.source.rights,a.source.url,a.source.licenseUrl].filter(Boolean).join(' · '));
        if(musicCredit)lines.push(musicCredit.line);
        const factsText=facts.map(f=>[f.text,f.url].filter(Boolean).join(' · '));
        await writeFile(files.credits,[...lines,...factsText].join('\n')+'\n');
      }
      files.project=await portableProject(p,path.join(directory,'工程'),styles);
      files.review=path.join(directory,'review.json');const temp=files.review+'.tmp';
      await writeFile(temp,JSON.stringify(qa,null,2));await rename(temp,files.review);
      const latest=store.get(projectId);
      if(latest.revision===p.revision)store.snapshot(latest);
      let published,publicationWarning;
      const localDraft=j.creativeResult?.engine==='local' && ['produce','revise'].includes(j.kind);
      if(qa.deliverable&&j.kind!=='preview'&&!localDraft&&deliveryRoot){
        try{published=await publishDelivery(deliveryRoot,p,j.id,files,styles);}catch(e){publicationWarning='成片已保存到工程交付目录。另存到影片目录时遇到问题：'+e.message;}
      }
      change(id,{status:'done',phase:'done',progress:1,files,qa,published,publicationWarning,stale:latest.revision!==p.revision});
      note(qa.label||'已完成');
    }catch(error){
      const interrupted=signal.aborted;
      change(id,{status:interrupted?'paused':'failed',error:interrupted?'任务已暂停，工程与已完成步骤已保存。':String(error.message||error).slice(0,1800)});
    }finally{running.delete(id);kick();}
  }
  function resume(id,input={}){
    const j=store.getJob(id);if(!['paused','failed'].includes(j.status))throw fault('当前任务不能续作。',409);
    if(store.listJobs(j.projectId).some(other=>other.id!==j.id&&activeStates.includes(other.status)))throw fault('该工程另有任务正在运行。',409);
    if(j.phase==='creative'&&j.input.engine!=='local'&&input.engine!=='local'&&!input.confirmRetry)throw fault('上次 Codex 回合可能已完成。请检查当前时间线后选择续作，或直接渲染已有剪辑。',409);
    change(id,{status:'queued',error:null,input:{...j.input,...input}});kick();return store.getJob(id);
  }
  function pause(id){
    const j=store.getJob(id);if(j.status==='queued'){change(id,{status:'paused'});return store.getJob(id);}
    const ctrl=running.get(id);if(ctrl){change(id,{status:'pausing'});ctrl.abort(new Error('用户已暂停'));}
    return store.getJob(id);
  }
  async function redirect(id,{message,selection,engine}){
    if(typeof message!=='string'||!message.trim()||message.length>10000)throw fault('请输入本次新的制作要求。');
    const j=store.getJob(id);
    if(engine!==undefined&&!['local','codex'].includes(engine))throw fault('创作引擎无效。');
    const requested=engine||(j.phase==='creative'?j.input.engine:'codex')||'codex';
    if(j.status==='queued'&&j.phase==='creative'){
      change(id,{input:{...j.input,engine:requested,message:[j.input.message,message].filter(Boolean).join('\n'),selection:selection||j.input.selection}});
      event(id,'已更新本轮制作要求');return store.getJob(id);
    }
    if(j.status==='running'&&j.phase==='creative'&&j.input.engine!=='local'&&requested==='codex'&&director.steer){
      try{await director.steer(j.projectId,{jobId:id,message});event(id,'已把新要求传入当前 Codex 回合');return store.getJob(id);}
      catch(e){if(e.status!==409)throw e;}
    }
    if(!activeStates.includes(j.status))throw fault('任务已结束，请从当前工程发起改稿。',409);
    pause(id);
    const until=Date.now()+45000;
    while(activeStates.includes(store.getJob(id).status)&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
    if(activeStates.includes(store.getJob(id).status))throw fault('正在保存当前步骤，暂停完成后可继续。',409);
    const p=store.get(j.projectId);
    return enqueue(p.id,p.timeline.clips.some(c=>c.track==='video')?'revise':'produce',{engine:requested,message,selection,baseRevision:p.revision});
  }
  function recover(){
    for(const j of store.listJobs())if(['running','pausing'].includes(j.status)){
      const receipt=store.get(j.projectId).directorState;
      const reconcilable=receipt?.jobId===j.id&&Boolean(receipt?.turnId);
      const needsUser=j.status==='pausing'||(j.phase==='creative'&&j.input.engine!=='local'&&!reconcilable);
      change(j.id,{status:needsUser?'paused':'queued',error:needsUser?'恢复了上次的剪辑记录。':null});
    }kick();
  }
  async function close(){stopping=true;for(const ctrl of running.values())ctrl.abort(new Error('工作台已关闭'));while(running.size)await new Promise(r=>setTimeout(r,40));}
  return {enqueue,resume,pause,redirect,recover,close};
}
