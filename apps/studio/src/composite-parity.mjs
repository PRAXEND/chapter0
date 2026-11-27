import path from 'node:path';
import {motionCatalog,motionCues,motionGeometry} from './motion-components.mjs';
import {graphicKeys,splitGraphicKeys} from './graphic-keys.mjs';
import {reviewStage} from './review-stage.mjs';
import {decodePixels} from './visual-review.mjs';

const whole={x:0,y:0,width:1,height:1};
function samplesForClip(c,profile){
  const {fps}=profile;
  if(c.hidden||c.enabled===false)return [];
  let bounds,offsets;
  if(c.motion){
    const spec=motionCatalog.find(item=>item.id===c.motion.componentId);
    const g=motionGeometry(spec,profile,c);
    bounds={x:g.x-g.width/2,y:g.y-g.height/2,width:g.width,height:g.height};
    const cues=c.motion.cueFrames??motionCues(spec,c.duration,fps,c.motion.props);
    offsets=(cues.length?cues:[0]).map(f=>f+Math.max(1,Math.round(fps*.2)));
  }else if(c.viewport){
    bounds=c.viewport;offsets=[0,Math.floor(c.duration/2)];
  }else if(c.keyframes?.some(k=>Number.isFinite(k.rotation))){
    const keys=graphicKeys(c),index=keys.findIndex((k,i)=>i>0&&k.rotation!==keys[i-1].rotation);
    let at=Math.floor(c.duration/2);
    if(index>0){
      const a=keys[index-1],b=keys[index];
      at=a.frame+Math.max(1,Math.round((b.frame-a.frame)*Math.min(.5,60/Math.abs(b.rotation-a.rotation))));
    }
    offsets=[at,0];
    bounds=whole;
  }else return [];
  return [...new Set(offsets.map(f=>Math.min(c.duration-1,f)))].map(offset=>{
    const result={clipId:c.id,frame:c.start+offset,bounds};
    if(c.shape==='polygon'&&c.geometry?.points){
      const pose=splitGraphicKeys(c,offset)[1][0];
      const rad=pose.rotation*Math.PI/180,cos=Math.cos(rad),sin=Math.sin(rad);
      const points=c.geometry.points.map(([u,v])=>{
        const x=(u-.5)*c.geometry.width*profile.width*pose.scale,y=(v-.5)*c.geometry.height*profile.height*pose.scale;
        return [pose.x+(x*cos-y*sin)/profile.width,pose.y+(x*sin+y*cos)/profile.height];
      });
      const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),x=Math.min(...xs),y=Math.min(...ys);
      result.bounds={x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y};
      result.points=points;
    }
    return result;
  });
}

// Round-robin covers different layers before sampling a second event on the same layer.
export function compositionSamples(p,limit=12){
  const stage=reviewStage(p);
  const groups=p.timeline.clips.map(c=>samplesForClip(c,stage.profile)).filter(g=>g.length);
  const samples=[];
  for(let i=0;groups.some(g=>g.length>i)&&samples.length<limit;i++){
    for(let n=0;n<Math.min(groups.length,limit);n++){
      const g=groups[Math.floor(n*groups.length/Math.min(groups.length,limit))];
      if(g[i]&&samples.length<limit)samples.push(g[i]);
    }
  }
  return samples.map(s=>({...s,bounds:stage.bounds(s.bounds),...(s.points&&{points:s.points.map(([x,y])=>stage.point(x,y))})})).sort((a,b)=>a.frame-b.frame);
}
function inPolygon(x,y,points){
  let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const [ax,ay]=points[i],[bx,by]=points[j];
    if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;
  }
  return inside;
}
export function pixelDifference(a,b,w,h,r,points){
  const x1=Math.max(0,Math.floor(r.x*w)),x2=Math.min(w,Math.ceil((r.x+r.width)*w));
  const y1=Math.max(0,Math.floor(r.y*h)),y2=Math.min(h,Math.ceil((r.y+r.height)*h));
  let sum=0,outliers=0,count=0;
  for(let y=y1;y<y2;y++)for(let x=x1;x<x2;x++){
    if(points&&!inPolygon((x+.5)/w,(y+.5)/h,points))continue;
    const k=(y*w+x)*3;
    const d=(Math.abs(a[k]-b[k])+Math.abs(a[k+1]-b[k+1])+Math.abs(a[k+2]-b[k+2]))/3;
    sum+=d;if(d>22)outliers++;count++;
  }
  if(!count)throw Error('取样区域在画布外');
  const mae=sum/count,changed=outliers/count;
  return {pixels:count,meanAbsoluteError:+mae.toFixed(3),changedFraction:+changed.toFixed(4),matches:!(mae>6&&changed>.05)};
}

export async function compareCompositions(p,{videoPath,ffmpeg,drafts,cache,signal}){
  const samples=compositionSamples(p);
  if(!samples.length)return null;
  const {fps,width,height}=p.profile;
  const ratio=256/Math.max(width,height),w=Math.max(8,Math.round(width*ratio)),h=Math.max(8,Math.round(height*ratio));
  const checks=[];
  let previous,frames;
  for(const {clipId,frame,bounds,points} of samples){
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
      checks.push({clipId,frame,...pixelDifference(...frames,w,h,bounds,points)});
    }catch(error){
      signal?.throwIfAborted();
      checks.push({clipId,frame,matches:null});
      // A frame read or a local renderer can be unavailable. Keep the playable candidate.
      if(!frames)break;
    }
  }
  return {revision:p.revision,requested:samples.length,checks};
}
