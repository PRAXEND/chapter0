import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

const active=p=>p.timeline.clips.filter(c=>!c.hidden&&c.enabled!==false);
const length=p=>active(p).reduce((n,c)=>Math.max(n,c.start+c.duration),0);
const fields=['track','assetId','start','duration','sourceIn','speed','gain','muted','fit','text','style','geometry','transition','keyframes'];
const signature=c=>c&&JSON.stringify(fields.map(k=>c[k]));
const overlap=(c,l,r)=>c.start<r&&c.start+c.duration>l;

export async function renderTimelineWindow(project,{directory,output,fromFrame,toFrame,signal,media}={}) {
  if(!Number.isSafeInteger(fromFrame)||!Number.isSafeInteger(toFrame)||fromFrame<0||toFrame<=fromFrame||toFrame>length(project)) throw Error('草稿区间须位于当前时间线内');
  const adapter=media||await import('./media.mjs');
  return adapter.renderProject(project,{directory,output,preview:true,window:{fromFrame,toFrame},signal});
}

function changed(before,after) {
  const old=new Map(active(before).map(c=>[c.id,c])),now=new Map(active(after).map(c=>[c.id,c]));
  return [...new Set([...old.keys(),...now.keys()])].map(id=>({id,before:old.get(id),after:now.get(id)}))
    .filter(pair=>signature(pair.before)!==signature(pair.after));
}

function chooseFocus(pairs,selection) {
  const selected=pairs.find(p=>p.id===selection.clipId);if(selected) return selected;
  const left=Number.isSafeInteger(selection.fromFrame)?selection.fromFrame:0,right=Number.isSafeInteger(selection.toFrame)?selection.toFrame:left+1;
  const inView=pairs.filter(p=>[p.before,p.after].some(c=>c&&overlap(c,left,right)));
  const near=inView.length?inView:pairs;
  return [...near].sort((a,b)=>Math.abs((a.after||a.before).start-left)-Math.abs((b.after||b.before).start-left))[0];
}

function adjacentPosition(source,target,missing) {
  const others=active(source).filter(c=>c.id!==missing.id&&c.track===missing.track);
  const next=others.filter(c=>c.start>=missing.start+missing.duration).sort((a,b)=>a.start-b.start);
  const prior=others.filter(c=>c.start+c.duration<=missing.start).sort((a,b)=>b.start+b.duration-a.start-a.duration);
  const current=new Map(active(target).map(c=>[c.id,c]));
  for(const c of next) if(current.has(c.id)) return current.get(c.id).start;
  for(const c of prior) if(current.has(c.id)){const remaining=current.get(c.id);return remaining.start+remaining.duration;}
  return missing.start;
}

function windowFor(p,other,focus,side,selection) {
  const fps=p.profile.fps,total=length(p),clip=focus[side],opposite=focus[side==='before'?'after':'before'];
  const record={projectId:p.id,revision:p.revision,clipId:focus.id,clipPresent:!!clip};
  if(!total) return {...record,status:'empty-timeline'};
  let anchor;
  if(!clip) anchor=adjacentPosition(other,p,opposite);
  else if(opposite&&opposite.start===clip.start&&opposite.duration!==clip.duration) anchor=clip.start+Math.min(clip.duration,opposite.duration);
  else {
    const selected=focus.after||clip;
    const hinted=selected.id===selection.clipId&&Number.isSafeInteger(selection.fromFrame)?selection.fromFrame-selected.start:0;
    anchor=clip.start+Math.max(0,Math.min(clip.duration-1,hinted));
  }
  const frames=Math.min(total,Math.max(1,Math.round(5*fps)));
  const fromFrame=Math.max(0,Math.min(total-frames,Math.round(anchor-.9*fps)));
  return {...record,status:'captured',fromFrame,toFrame:fromFrame+frames};
}

export async function capturePreference(styles,store,input,{media,signal}={}) {
  const {id,version,instruction,source}=input,b=input.before,a=input.after;
  if(typeof instruction!=='string'||!instruction.trim()||instruction.length>2000) throw Error('请填写要保存的风格偏好');
  if((await styles.get(id)).version!==version) throw Error('风格版本已更新，请读取最新版再保存');
  if(!a&&!b) return styles.savePreference({id,version,instruction,source});
  if(!a?.projectId||a.projectId!==b?.projectId||!Number.isSafeInteger(a.revision)||!Number.isSafeInteger(b.revision)||b.revision<1||b.revision>a.revision) throw Error('请从同一工程选择有效的前后版本');
  const after=store.revision(a.projectId,a.revision);
  let before=store.revision(b.projectId,b.revision),changes=changed(before,after);
  // The workbench's default preceding revision may have changed only settings or a selection.
  while(input.findEdit===true&&!changes.length&&before.revision>1) {
    before=store.revision(b.projectId,before.revision-1);changes=changed(before,after);
  }
  if(!changes.length) {
    const record=p=>({projectId:p.id,revision:p.revision,status:'no-timeline-change'});
    return styles.savePreference({id,version,instruction,source,before:record(before),after:record(after)});
  }
  const focus=chooseFocus(changes,{...a,clipId:a.clipId||b.clipId});
  const left=windowFor(before,after,focus,'before',a),right=windowFor(after,before,focus,'after',a);
  const cache=store.paths(a.projectId).cache;await mkdir(cache,{recursive:true});
  const scratch=await mkdtemp(path.join(cache,'preference-')),references=[];
  try {
    for(const [project,record,side,title] of [[before,left,'before','修改前'],[after,right,'after','修改后']]) {
      if(record.status!=='captured') continue;
      const output=path.join(scratch,side+'.mp4');
      const result=await renderTimelineWindow(project,{directory:scratch,output,fromFrame:record.fromFrame,toFrame:record.toFrame,signal,media});
      if(result.frames!==record.toFrame-record.fromFrame) throw Error('风格对照片段与所选帧区间不符');
      const ref=await styles.captureReference(output,{id:'preference-'+randomUUID(),kind:'video',title:title+' · 工程 v'+record.revision});
      if(result.sha256!==ref.sha256) throw Error('风格对照片段写入后指纹改变');
      references.push({...ref,duration_s:result.duration,derivedFrom:{...record}});
      Object.assign(record,{referenceId:ref.id,sha256:ref.sha256});
    }
    return await styles.savePreference({id,version,instruction,source,before:left,after:right,references});
  } finally {await rm(scratch,{recursive:true,force:true});}
}
