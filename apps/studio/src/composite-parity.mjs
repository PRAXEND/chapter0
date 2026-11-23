import path from 'node:path';
import {motionCatalog,motionCues} from './motion-components.mjs';
import {decodePixels} from './visual-review.mjs';

const whole={x:0,y:0,width:1,height:1};
function samplesForClip(c,fps){
  if(c.hidden||c.enabled===false)return [];
  let bounds,offsets;
  if(c.motion){
    const spec=motionCatalog.find(item=>item.id===c.motion.componentId);
    const g=c.geometry??spec.geometry;
    bounds={x:g.x-g.width/2,y:g.y-g.height/2,width:g.width,height:g.height};
    const cues=c.motion.cueFrames??motionCues(spec,c.duration,fps,c.motion.props);
    offsets=(cues.length?cues:[0]).map(f=>f+Math.max(1,Math.round(fps*.2)));
  }else if(c.viewport){
    bounds=c.viewport;offsets=[0,Math.floor(c.duration/2)];
  }else if(c.keyframes?.some(k=>Number.isFinite(k.rotation))){
    bounds=whole;offsets=[0,Math.floor(c.duration*.37)];
  }else return [];
  return [...new Set(offsets.map(f=>c.start+Math.min(c.duration-1,f)))].map(frame=>({clipId:c.id,frame,bounds}));
}

// Round-robin covers different layers before sampling a second event on the same layer.
export function compositionSamples(p,limit=12){
  const groups=p.timeline.clips.map(c=>samplesForClip(c,p.profile.fps)).filter(g=>g.length);
  const samples=[];
  for(let i=0;groups.some(g=>g.length>i)&&samples.length<limit;i++){
    for(let n=0;n<Math.min(groups.length,limit);n++){
      const g=groups[Math.floor(n*groups.length/Math.min(groups.length,limit))];
      if(g[i]&&samples.length<limit)samples.push(g[i]);
    }
  }
  return samples.sort((a,b)=>a.frame-b.frame);
}
export function pixelDifference(a,b,w,h,r){
  const x1=Math.max(0,Math.floor(r.x*w)),x2=Math.min(w,Math.ceil((r.x+r.width)*w));
  const y1=Math.max(0,Math.floor(r.y*h)),y2=Math.min(h,Math.ceil((r.y+r.height)*h));
  let sum=0,outliers=0,count=0;
  for(let y=y1;y<y2;y++)for(let x=x1;x<x2;x++){
    const k=(y*w+x)*3;
    const d=(Math.abs(a[k]-b[k])+Math.abs(a[k+1]-b[k+1])+Math.abs(a[k+2]-b[k+2]))/3;
    sum+=d;if(d>22)outliers++;count++;
  }
  if(!count)throw Error('取样区域在画布外');
  const mae=sum/count,changed=outliers/count;
  return {meanAbsoluteError:+mae.toFixed(3),changedFraction:+changed.toFixed(4),matches:!(mae>6&&changed>.05)};
}

export async function compareCompositions(p,{videoPath,ffmpeg,drafts,cache,signal}){
  const samples=compositionSamples(p);
  if(!samples.length)return null;
  const {fps,width,height}=p.profile;
  const ratio=256/Math.max(width,height),w=Math.max(8,Math.round(width*ratio)),h=Math.max(8,Math.round(height*ratio));
  const checks=[];
  let previous,frames;
  for(const {clipId,frame,bounds} of samples){
    signal?.throwIfAborted();
    try{
      if(previous!==frame){
        const draft=await drafts.open(p,Math.floor(frame/(fps*6))*fps*6,signal);
        if(draft.revision!==p.revision||frame<draft.fromFrame||frame>=draft.toFrame)throw Error('预览版本或帧范围已改变');
        // A small positive timestamp rounding error can seek to the next frame. Round down to microseconds.
        const at=f=>Math.floor(f/fps*1e6)/1e6;
        frames=await Promise.all([decodePixels(ffmpeg,path.join(cache,'drafts',draft.name),at(frame-draft.fromFrame),w,h,signal),
                                  decodePixels(ffmpeg,videoPath,at(frame),w,h,signal)]);
        previous=frame;
      }
      checks.push({clipId,frame,...pixelDifference(...frames,w,h,bounds)});
    }catch(error){
      signal?.throwIfAborted();
      checks.push({clipId,frame,matches:null});
      // A frame read or a local renderer can be unavailable. Keep the playable candidate.
      if(!frames)break;
    }
  }
  return {revision:p.revision,requested:samples.length,checks};
}
