// All positions are relative output frames. Source distances use the project's frame unit.
const epsilon=1e-7;
const check=(ok,message)=>{if(!ok)throw Object.assign(Error(message),{status:422});};
const slope=(a,b)=>(b.sourceFrame-a.sourceFrame)/(b.frame-a.frame);
const clean=n=>Math.abs(n)<epsilon?0:n;

function segmentAt(points,frame,key='frame'){
  let index=1;
  while(index<points.length-1&&frame>=points[index][key])index++;
  return [points[index-1],points[index]];
}
function sourceDistance(points,frame){
  const [a,b]=segmentAt(points,frame);
  return a.sourceFrame+(frame-a.frame)*slope(a,b);
}
export function sourceAt(clip,localFrame){
  const curve=clip.timeMap,base=clip.sourceIn??0;
  if(!curve)return base+localFrame*(clip.speed??1);
  const offset=curve.offsetFrames??0;
  return base+sourceDistance(curve.points,offset+localFrame)-sourceDistance(curve.points,offset);
}
export function localAtSource(clip,sourceFrame){
  const curve=clip.timeMap,base=clip.sourceIn??0;
  if(!curve)return (sourceFrame-base)/(clip.speed??1);
  const offset=curve.offsetFrames??0,target=sourceDistance(curve.points,offset)+sourceFrame-base;
  const [a,b]=segmentAt(curve.points,target,'sourceFrame');
  return a.frame+(target-a.sourceFrame)/slope(a,b)-offset;
}
export function timeKeys(clip){
  if(!clip.timeMap)return [{frame:0,sourceFrame:0},{frame:clip.duration,sourceFrame:clip.duration*(clip.speed??1)}];
  const offset=clip.timeMap.offsetFrames??0,base=clip.sourceIn??0;
  const frames=[0,...clip.timeMap.points.map(p=>p.frame-offset).filter(f=>f>0&&f<clip.duration),clip.duration];
  return frames.map(frame=>({frame,sourceFrame:clean(sourceAt(clip,frame)-base)}));
}
export function validateTimeMap(clip,asset,fps){
  if(clip.timeMap==null)return;
  const {points,offsetFrames=0}=clip.timeMap;
  check(Object.keys(clip.timeMap).every(k=>['points','offsetFrames'].includes(k))&&clip.track==='video'&&asset?.kind==='video'&&!clip.sampleWindow,'时间曲线适用于录像，使用独立的原片采样时钟。');
  check(Array.isArray(points)&&points.length>=2&&points.length<=64,'时间曲线须有 2–64 个锚点。');
  for(const [i,p] of points.entries()){
    check(p&&Object.keys(p).every(k=>['frame','sourceFrame'].includes(k))&&Number.isSafeInteger(p.frame)&&p.frame>=0&&p.frame<=fps*86400&&Number.isFinite(p.sourceFrame)&&p.sourceFrame>=0,
      '曲线横轴是整数工程帧，纵轴是非负原片帧。');
    if(!i){check(p.frame===0&&p.sourceFrame===0,'时间曲线须从零点开始。');continue;}
    const rate=slope(points[i-1],p);
    check(p.frame>points[i-1].frame&&rate>=.125-epsilon&&rate<=8+epsilon,'曲线锚点须依次向前，每段速度为 0.125–8 倍。');
  }
  check(Number.isSafeInteger(offsetFrames)&&offsetFrames>=0&&offsetFrames+clip.duration<=points.at(-1).frame,'片段超出时间曲线的可见区间。');
  const available=Math.ceil(asset.duration*fps)+1;
  const start=(clip.sourceIn??0)-sourceDistance(points,offsetFrames);
  check(start>=-epsilon&&start+points.at(-1).sourceFrame<=available+epsilon,'曲线超出原片的可用窗口。');
  check(Math.abs(sourceAt(clip,clip.duration)-sourceAt(clip,0)-clip.duration*(clip.speed??1))<epsilon*Math.max(1,clip.duration),
    '曲线的首尾与片段原片窗口不一致，请通过时间曲线操作重设。');
}
export function setTimeMap(clip,points){
  const span=sourceAt(clip,clip.duration)-(clip.sourceIn??0);
  if(points==null)return {timeMap:null,sampleWindow:null,speed:span/clip.duration};
  check(Array.isArray(points)&&points.length>=2&&points.length<=64&&points.every(p=>p&&typeof p==='object')&&points.at(-1)?.frame===clip.duration&&Math.abs(points.at(-1).sourceFrame-span)<epsilon*Math.max(1,span),
    '时间曲线须保留片段时长和原片首尾。');
  return {timeMap:{points:points.map(p=>({frame:p.frame,sourceFrame:p.sourceFrame}))},speed:span/clip.duration,sampleWindow:null};
}
export function timeSection(clip,from,to){
  const curve=clip.timeMap,oldOffset=curve.offsetFrames??0;
  const first=oldOffset+from,last=oldOffset+to;
  let points=curve.points,offsetFrames=first;
  if(first<0){
    const head=sourceDistance(points,first);
    points=[{frame:0,sourceFrame:0},...points.map(p=>({frame:p.frame-first,sourceFrame:p.sourceFrame-head}))];
    // The extrapolated lead has the same slope as the former first segment.
    points.splice(1,1);
    offsetFrames=0;
  }
  const lastFrame=offsetFrames+to-from;
  if(lastFrame>points.at(-1).frame)points=[...points.slice(0,-1),{frame:lastFrame,sourceFrame:sourceDistance(points,lastFrame)}];
  return {sourceIn:clean(sourceAt(clip,from)),speed:(sourceDistance(curve.points,last)-sourceDistance(curve.points,first))/(to-from),
    timeMap:{points,...(offsetFrames&&{offsetFrames})},sampleWindow:null};
}

// Each visible strip retains its whole authored segment as the fps/atempo decoding anchor.
export function curveRuns(clip){
  const curve=clip.timeMap;
  if(!curve)return [clip];
  const offset=curve.offsetFrames??0,base=clip.start-offset,source=(clip.sourceIn??0)-sourceDistance(curve.points,offset);
  const runs=[];
  for(let i=1;i<curve.points.length;i++){
    const a=curve.points[i-1],b=curve.points[i],start=Math.max(clip.start,base+a.frame),end=Math.min(clip.start+clip.duration,base+b.frame);
    if(end<=start)continue;
    const skip=start-base-a.frame,speed=slope(a,b);
    runs.push({...clip,timeMap:null,start,duration:end-start,speed,sourceIn:clean(source+a.sourceFrame+skip*speed),
      sampleWindow:{offsetFrames:skip,durationFrames:b.frame-a.frame}});
  }
  return runs;
}
export const defaultMask={shape:'ellipse',x:.5,y:.5,width:.6,height:.65,feather:0,invert:false};
export function validateMask(mask){
  if(mask==null)return;
  check(Object.keys(mask).every(k=>['shape','x','y','width','height','feather','invert'].includes(k))&&['ellipse','rectangle'].includes(mask.shape)&&[mask.x,mask.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)&&
    [mask.width,mask.height].every(n=>Number.isFinite(n)&&n>0&&n<=2)&&Number.isFinite(mask.feather??0)&&(mask.feather??0)>=0&&(mask.feather??0)<=.5&&
    (mask.invert==null||typeof mask.invert==='boolean'),'蒙版需要有效形状、中心、宽高及 0–0.5 的羽化比例。');
}
export const defaultFocus={x:.5,y:.5,zoom:1};
export function focusKeys(clip){
  const f=clip.framing,last=clip.duration-1,from=f?.from??defaultFocus,to=f?.to??from;
  return [{frame:0,...from},...(f?.keys??[]),...(last>0?[{frame:last,...to}]:[])];
}
export function blendKeys(keys,frame){
  const next=keys.findIndex(k=>k.frame>=frame);
  if(next<0)return {...keys.at(-1),frame};
  if(next===0||keys[next].frame===frame)return {...keys[next],frame};
  const a=keys[next-1],b=keys[next],f=(frame-a.frame)/(b.frame-a.frame),out={frame};
  for(const key of Object.keys(a))if(key!=='frame')out[key]=a[key]+(b[key]-a[key])*f;
  return out;
}
export function framingFor(keys,duration){
  const coords=p=>({x:p.x,y:p.y,zoom:p.zoom});
  return {from:coords(keys[0]),to:coords(keys.at(-1)),keys:keys.filter(k=>k.frame>0&&k.frame<duration-1).map(k=>({frame:k.frame,...coords(k)}))};
}
export function remapFocus(clip,from,to){
  const keys=focusKeys(clip),at=f=>({...blendKeys(keys,f),frame:f-from});
  return framingFor([at(from),...keys.filter(k=>k.frame>from&&k.frame<to-1).map(k=>({...k,frame:k.frame-from})),at(to-1)],to-from);
}

const value = (n, previous) => Number.isFinite(n) ? n : previous;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

export function graphicKeys(clip) {
  let current = {
    frame: 0, x: value(clip.geometry?.x, .5),
    y: value(clip.geometry?.y, clip.track === 'caption' ? .86 : .28),
    scale: 1, opacity: 1, rotation: 0,
  };
  const points = new Map([[0, current]]);
  for (const key of [...(clip.keyframes ?? [])].sort((a, b) => a.frame - b.frame)) {
    if (!Number.isInteger(key.frame) || key.frame < 0 || key.frame > clip.duration) continue;
    current = {
      frame: key.frame, x: value(key.x, current.x), y: value(key.y, current.y),
      scale: clamp(value(key.scale, current.scale), .01, 10), opacity: clamp(value(key.opacity, current.opacity), 0, 1),
      rotation: value(key.rotation, current.rotation),
    };
    points.set(key.frame, current);
  }
  if (!points.has(clip.duration)) points.set(clip.duration, { ...current, frame: clip.duration });
  return [...points.values()];
}
