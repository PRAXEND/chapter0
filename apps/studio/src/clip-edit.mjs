import {splitGraphicKeys} from './graphic-keys.mjs';
import {transitionEnvelope,validFraming} from './framing.mjs';

const fail=(message,status=422)=>{throw Object.assign(new Error(message),{status});};
const end=c=>c.start+c.duration;
const mediaTracks=new Set(['video','music','narration']);
const mediaClip=(clip,project)=>mediaTracks.has(clip.track)&&project.assets.find(a=>a.id===clip.assetId&&a.kind!=='image');
const nearZero=n=>Math.abs(n)<1e-8?0:n;

// A retained section of a retimed source must sample the same fps/atempo stream.
// The visible sourceIn is independently editable and remains in project-frame units.
export function sampleClock(c) {
  const offset=c.sampleWindow?.offsetFrames??0, length=c.sampleWindow?.durationFrames??c.duration;
  return {start:c.start-offset,duration:length,sourceIn:nearZero((c.sourceIn??0)-offset*(c.speed??1))};
}

export function validateSampleWindow(c,project) {
  const w=c.sampleWindow;
  if(w==null)return;
  const asset=mediaClip(c,project);
  if(!asset||!Number.isSafeInteger(w.offsetFrames)||w.offsetFrames<0||
    !Number.isSafeInteger(w.durationFrames)||w.durationFrames<w.offsetFrames+c.duration||
    w.durationFrames>project.profile.fps*86400)fail('变速采样窗口无效。');
  const clock=sampleClock(c);
  if(clock.sourceIn<0||clock.sourceIn+clock.duration*(c.speed??1)>Math.ceil(asset.duration*project.profile.fps)+1+1e-7)
    fail('变速采样窗口超出原片。');
}

function keysWithin(clip,from,to) {
  let keys=clip.keyframes, duration=clip.duration;
  if(from>0){[,keys]=splitGraphicKeys(clip,from);duration-=from;}
  if(to<clip.duration){[keys]=splitGraphicKeys({...clip,keyframes:keys,duration},to-Math.max(0,from));}
  if(from<0){
    const atZero=splitGraphicKeys(clip,0)[0][0];
    keys=[{...atZero,frame:0},...(!keys.some(k=>k.frame===0)?[atZero]:[]).concat(keys).map(k=>({...k,frame:k.frame-from}))];
  }
  return keys;
}

function croppedEffects(effects,from,to) {
  return effects.flatMap(e=>{
    const start=e.offsetFrames??0, a=Math.max(from,start), b=Math.min(to,start+e.duration);
    return b<=a?[]:[{...e,offsetFrames:a-from,duration:b-a,phaseFrames:(e.phaseFrames??0)+a-start}];
  });
}

// Local bounds may extend outside the previous trim, but only within the underlying source.
function section(clip,from,to,project) {
  const changes={duration:to-from};
  if(from!==0)changes.start=clip.start+from;
  if(mediaClip(clip,project)){
    const rate=clip.speed??1, previousOffset=clip.sampleWindow?.offsetFrames??0;
    const offset=Math.max(0,from+previousOffset);
    const extraHead=Math.max(0,-from-previousOffset);
    const available=(clip.sampleWindow?.durationFrames??clip.duration)+extraHead;
    changes.sourceIn=nearZero((clip.sourceIn??0)+from*rate);
    if(changes.sourceIn<0)fail('入点已到原片开头。');
    changes.sampleWindow={offsetFrames:offset,durationFrames:Math.max(available,offset+changes.duration)};
  }
  if(from!==0&&['graphic','video','caption'].includes(clip.track)){
    const offset=Math.max(0,(clip.stackOrigin?.offsetFrames??0)+from);
    changes.stackOrigin={id:clip.stackOrigin?.id??clip.id,offsetFrames:offset};
  }
  if(clip.keyframes?.length)changes.keyframes=keysWithin(clip,from,to);
  if(clip.pictureEffects?.length)changes.pictureEffects=croppedEffects(clip.pictureEffects,from,to);
  if(clip.framing?.to){
    const {from:a,to:b}=clip.framing;
    const point=at=>Object.fromEntries(['x','y','zoom'].map(k=>[k,a[k]+(clip.duration===1?0:(b[k]-a[k])*at/(clip.duration-1))]));
    changes.framing={from:point(from),to:point(to-1)};
    if(!validFraming(changes.framing))fail('延长此镜头会把取景移出原片，请调整取景终点后重试。');
  }
  const fade=transitionEnvelope(clip);
  if(fade.duration){
    if(from<0)fail('此片段带有入场转场，请先移除转场再向前延长入点。');
    const duration=Math.min(to,fade.duration)-from;
    changes.transition=duration<=0?null:{...clip.transition,duration,totalFrames:fade.total,offsetFrames:fade.offset+from};
  }
  return changes;
}

function move(clip,start) {
  if(!Number.isSafeInteger(start)||start<0)fail('移动位置必须是有效的工程帧。');
  const changes={start};
  if(Number.isSafeInteger(clip.actionFrame))changes.actionFrame=clip.actionFrame+start-clip.start;
  return {op:'update',id:clip.id,changes};
}

function changeSpeed(clip,requested,project) {
  if(!mediaClip(clip,project))fail('倍速适用于录影片段与音轨。');
  if(!Number.isFinite(requested)||requested<.125||requested>8)fail('倍速范围为 0.125–8。');
  const span=clip.duration*(clip.speed??1);
  // The output clock has integer frames. Keep BOTH source endpoints, including
  // at minimum/maximum rate, then report the attainable rate in the project.
  const duration=Math.max(1,Math.ceil(span/8-1e-10),Math.min(Math.floor(span/.125+1e-10),Math.round(span/requested)));
  if(duration===clip.duration)return null;
  const speed=span/duration,changes={duration,speed,sampleWindow:null};
  const local=n=>Math.round(n*duration/clip.duration);
  if(clip.keyframes?.length)changes.keyframes=clip.keyframes.map(k=>({...k,frame:local(k.frame)}));
  if(clip.pictureEffects?.length)changes.pictureEffects=clip.pictureEffects.map(f=>{
    const start=Math.min(duration-1,local(f.offsetFrames??0)),end=local((f.offsetFrames??0)+f.duration);
    return {...f,offsetFrames:start,duration:Math.max(1,end-start),...(f.phaseFrames?{phaseFrames:local(f.phaseFrames)}:{})};
  });
  const fade=transitionEnvelope(clip);
  if(fade.duration)changes.transition={...clip.transition,duration:Math.max(1,local(fade.duration)),offsetFrames:local(fade.offset),totalFrames:Math.max(1,local(fade.total))};
  if(Number.isInteger(clip.actionFrame)&&clip.actionFrame>=clip.start&&clip.actionFrame<end(clip))changes.actionFrame=clip.start+Math.min(duration-1,local(clip.actionFrame-clip.start));
  return {op:'update',id:clip.id,changes};
}

// Expanded lazily: a later command can trim a piece created earlier in the same transaction.
export function* timelineCommands(commands,project) {
  for(const cmd of commands){
    if(!['split','trim','move','speed','ripple-remove'].includes(cmd?.op)){yield cmd;continue;}
    const clips=project.timeline.clips,clip=clips.find(c=>c.id===cmd.id);
    if(!clip)fail('片段已改变，请重新读取工程。',409);
    if(clip.locked)fail('该片段已锁定。',409);
    if(cmd.op==='move'){yield move(clip,cmd.start);continue;}
    if(cmd.op==='ripple-remove'){
      // A bound event follows its picture/graphic, even when that owner is on another track.
      const others=clips.filter(c=>c!==clip&&c.track===clip.track&&!c.soundBinding);
      if(others.some(c=>c.start<end(clip)&&clip.start<end(c)))fail('同轨片段重叠，不能波纹删除。可先分割重叠区间，或只删除所选片段。',409);
      const later=others.filter(c=>c.start>=end(clip));
      if(later.some(c=>c.locked))fail('同轨后方有已锁定片段，无法移动。',409);
      yield {op:'remove',id:clip.id};
      for(const c of later)yield move(c,c.start-clip.duration);
      continue;
    }
    if(clip.motion)fail('原版 JSX 组件使用完整的出场与音效时钟。可移动整个组件，或在组件参数中调整出场帧。');
    if(cmd.op==='speed'){
      const change=changeSpeed(clip,cmd.speed,project);
      if(change)yield change;
      continue;
    }
    const at=cmd.atFrame, head=at-clip.start;
    if(cmd.op==='split'){
      if(!Number.isSafeInteger(at)||head<1||head>=clip.duration)fail('请选择片段内的分割帧。');
      const left=section(clip,0,head,project),right={...clip,...section(clip,head,clip.duration,project),id:cmd.newId};
      // An explicitly split sound is now two independently editable audio pieces.
      delete right.soundBinding;
      yield {op:'update',id:clip.id,changes:left};
      yield {op:'add',clip:right};
    }else{
      if(!Number.isSafeInteger(at)||at<0||!['start','end'].includes(cmd.edge))fail('请选择有效的裁切边和工程帧。');
      const from=cmd.edge==='start'?head:0,to=cmd.edge==='end'?head:clip.duration;
      if(from>=to)fail('裁切后至少须保留一帧。');
      if(from===0&&to===clip.duration)continue;
      yield {op:'update',id:clip.id,changes:section(clip,from,to,project)};
    }
  }
}
