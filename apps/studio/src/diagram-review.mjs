import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAss} from './text-tracks.mjs';

const execute=promisify(execFile);
const last=c=>c.start+c.duration-1;
const live=c=>c.enabled!==false&&!c.hidden;
const covers=(c,f)=>c.start<=f&&last(c)>=f;
const identity=/原理示意|示意图|示意动画|横截面|剖面图|机理图|流程模拟|结构图解|仿真演示|模型演示|schematic|cross[- ]section|mechanism diagram|simulation/i;
const letters=t=>String(t||'').replace(/[^\p{L}]/gu,'').toLowerCase();
const rgb=s=>(/^#([a-f0-9]{6})(?:[a-f0-9]{2})?$/i.exec(s||'')?.[1]||'ffffff').match(/../g).map(x=>parseInt(x,16));
const mean=a=>a.reduce((v,x)=>v+x,0)/a.length;
function unionLength(list,moving=false){
  let end=-1,count=0;
  for(const w of [...list].sort((a,b)=>a.fromFrame-b.fromFrame)){
    const to=w.toFrame-(moving?1:0),from=Math.max(end+1,w.fromFrame);
    if(to>=from)count+=to-from+1;
    end=Math.max(end,to);
  }
  return count;
}

async function glyphMask(label,at,profile,width,height,{ffmpeg,signal,temp,pose}) {
  const p=pose(label,at),layer={...label,start:0,duration:2,geometry:{x:p.x,y:p.y},keyframes:[{frame:0,scale:p.scale,opacity:1}],
    style:{...label.style,color:'#FFFFFF',backgroundColor:'#000000'}};
  await writeFile(path.join(temp,'identity.ass'),createAss([layer],profile));
  const limit=Math.min(1,1920/Math.max(profile.width,profile.height)),size=n=>Math.max(16,2*Math.round(n*limit/2));
  const result=await execute(ffmpeg,['-v','error','-nostdin','-f','lavfi','-i','color=c=black:s='+size(profile.width)+'x'+size(profile.height)+':r=1',
    '-frames:v','1','-vf','ass=identity.ass,scale='+width+':'+height+',format=gray','-threads','1','-f','rawvideo','pipe:1'],
    {cwd:temp,signal,encoding:'buffer',maxBuffer:width*height+65536,timeout:30000});
  return result.stdout;
}
function glyphVisible(mask,frame,w,h,color){
  const ink=rgb(color),near=i=>{let d=0;for(let k=0;k<3;k++)d+=Math.abs(frame[3*i+k]-ink[k]);return d<176;};
  let minX=w,maxX=0,minY=h,maxY=0,matches=0,n=0;
  for(let i=0;i<mask.length;i++)if(mask[i]>155){const x=i%w,y=Math.floor(i/w);minX=Math.min(x,minX);maxX=Math.max(x,maxX);minY=Math.min(y,minY);maxY=Math.max(y,maxY);matches+=near(i);n++;}
  if(n<12)return {visible:false};
  let other=0,total=0;
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
    const i=y*w+x;if(mask[i]<25){other+=near(i);total++;}
  }
  const match=matches/n,contrast=match-other/Math.max(1,total);
  return {visible:match>=.61&&contrast>=.20,glyphMatch:+match.toFixed(2),contrast:+contrast.toFixed(2)};
}

const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,(a.width-b.width)/2,(a.height-b.height)/2);
function movements(shapes,title,profile,pose){
  const candidates=[];
  for(const clip of shapes){
    const bounds=[...new Set([0,...(clip.keyframes||[]).map(k=>k.frame),clip.duration-1])].sort((a,b)=>a-b);
    for(let i=1;i<bounds.length;i++){
      const fromFrame=Math.max(clip.start+bounds[i-1],title.start),toFrame=Math.min(clip.start+bounds[i],last(clip),last(title));
      if(toFrame-fromFrame<Math.max(3,profile.fps*.18))continue;
      const middleFrame=Math.round((fromFrame+toFrame)/2),frames=[fromFrame,middleFrame,toFrame],boxes=frames.map(f=>pose(clip,f));
      if(boxes.some(b=>b.opacity<.5||b.x<0||b.x>1||b.y<0||b.y>1)||distance(boxes[0],boxes[2])<.028)continue;
      const titlePos=pose(title,middleFrame);
      if(Math.abs(boxes[1].x-titlePos.x)>.40||Math.abs(boxes[1].y-titlePos.y)>.62)continue;
      candidates.push({clip,fromFrame,middleFrame,toFrame,frames,boxes,weight:distance(boxes[0],boxes[2])*Math.sqrt(boxes[1].width*boxes[1].height)});
    }
  }
  return candidates.sort((a,b)=>b.weight-a.weight);
}

export async function reviewExplanatoryAnimations(project,sourceWindows,{ffmpeg,signal,readFrame,pose,paint,related}){
  const graphics=project.timeline.clips.filter(c=>c.track==='graphic'&&live(c));
  const labels=graphics.filter(c=>letters(c.text).length>=2),titles=labels.filter(c=>identity.test(c.text));
  const shapes=graphics.filter(c=>!c.text&&c.geometry?.width>0&&c.geometry?.height>0);
  const result={diagramFrames:0,actionFrames:0,windows:[],thresholds:{minGlyphMatch:.61,minGlyphContrast:.20,minRelativeTravel:.028,minEdgeSeparation:.16,requiredSeparatedSamples:2,samplesPerTransition:3},method:'按已标身份的可编辑图例查找相对运动。分别核对文字字形、可编辑几何体在起点、中段、终点的颜色位置和固定参照物。图解显示时长包含阅读停留，动作时长按通过核对的关键帧间隔计算。未检出只表示这些证据未达到该项阈值。'};
  if(!titles.length||!shapes.some(c=>c.keyframes?.length>1))return result;
  const profile=project.profile,ratio=Math.min(1,640/Math.max(profile.width,profile.height)),w=Math.round(profile.width*ratio),h=Math.round(profile.height*ratio);
  const temp=await mkdtemp(path.join(os.tmpdir(),'studio-diagram-review-'));
  try{
    for(const title of titles.slice(0,8)){
      const moves=movements(shapes,title,profile,pose);if(!moves.length)continue;
      const cache=new Map(),pixels=async f=>{if(!cache.has(f))cache.set(f,await readFrame(f,w,h));return cache.get(f);};
      const textAt=async(c,f)=>{const mask=await glyphMask(c,f,profile,w,h,{ffmpeg,signal,temp,pose});return {frame:f,...glyphVisible(mask,await pixels(f),w,h,c.style?.color)};};
      const inset=Math.min(Math.floor(title.duration/4),Math.round(profile.fps*.28));
      const identityFrames=[await textAt(title,title.start+inset),await textAt(title,last(title)-inset)];
      if(!identityFrames.every(f=>f.visible))continue;
      const stages=[];
      for(const c of labels.filter(c=>c!==title&&c.start>=title.start&&last(c)<=last(title)&&c.duration<title.duration&&c.duration>=profile.fps*.35&&!identity.test(c.text)&&!/^步骤?\d+$/u.test(c.text)).slice(0,24)){
        const at=c.start+Math.floor((c.duration-1)/2),p=pose(c,at),head=pose(title,at);
        if(Math.abs(p.x-head.x)>.20||Math.abs(p.y-head.y)>.67)continue;
        const timing={label:c.text,observation:c.text,fromFrame:c.start,toFrame:last(c)};
        const match=related(timing);
        if(match===false)continue;
        const rendered=await textAt(c,at);
        if(rendered.visible&&!stages.some(s=>letters(s.label)===letters(c.text)))stages.push({id:c.id,label:c.text,fromFrame:c.start,toFrame:last(c),...rendered});
      }
      if(stages.length<2||!stages.some(s=>stages.some(t=>s.toFrame<t.fromFrame)))continue;
      const actions=[];
      for(const move of moves.slice(0,18)){
        if(actions.some(a=>a.fromFrame===move.fromFrame&&a.toFrame===move.toFrame))continue;
        const images=[];for(const f of move.frames)images.push(await pixels(f));
        const paints=move.boxes.map((box,i)=>paint(images[i],w,h,box));
        if(!paints.every(p=>p.visible))continue;
        const wrong=move.boxes.map((_,i)=>mean(paint(images[i],w,h,move.boxes[i===0?2:0]).sideCoverage));
        const separation=paints.map((p,i)=>mean(p.sideCoverage)-wrong[i]);
        if(separation.filter(n=>n>=.16).length<2)continue;
        const reference=shapes.find(c=>{
          if(c.id===move.clip.id||!covers(c,move.fromFrame)||!covers(c,move.toFrame))return false;
          const boxes=move.frames.map(f=>pose(c,f)),b=boxes[1],m=move.boxes[1],size=b.width*b.height;
          if(size>.052||size<.00017||Math.abs(b.x-m.x)>.29||Math.abs(b.y-m.y)>.24||distance(boxes[0],boxes[2])>.012||
            Math.hypot(b.x-m.x,b.y-m.y)<.035||boxes.some(q=>q.opacity<.5))return false;
          return boxes.every((q,i)=>{
            const observed=paint(images[i],w,h,q);
            if(observed.visible)return true;
            const [top,bottom,left,right]=observed.sideCoverage;
            // For a narrow rule, H.264 can preserve the ends while thinning its long edges.
            return (q.height*h<=8&&q.width*w>=12&&Math.min(left,right)>=.8&&(top+bottom)/2>=.23)||
              (q.width*w<=8&&q.height*h>=12&&Math.min(top,bottom)>=.8&&(left+right)/2>=.23);
          });
        });
        if(!reference)continue;
        actions.push({fromFrame:move.fromFrame,middleFrame:move.middleFrame,toFrame:move.toFrame,objectId:move.clip.id,referenceId:reference.id,
          frames:move.frames.map((frame,i)=>({frame,x:move.boxes[i].x,y:move.boxes[i].y,edgeCoverage:paints[i].sideCoverage,separation:+separation[i].toFixed(2)}))});
      }
      if(actions.length){
        const underlying=sourceWindows.filter(s=>s.from<=last(title)&&s.to>=title.start).map(s=>({assetId:s.shot.clip.assetId,kind:s.shot.asset?.kind||'unknown',fromFrame:Math.max(s.from,title.start),toFrame:Math.min(s.to,last(title))}));
        result.windows.push({fromFrame:title.start,toFrame:last(title),label:title.text,identityId:title.id,identityFrames,stages:stages.sort((a,b)=>a.fromFrame-b.fromFrame),underlying,actions:actions.sort((a,b)=>a.fromFrame-b.fromFrame)});
      }
    }
  }catch(error){if(signal?.aborted)throw error;result.unverified=true;}
  finally{await rm(temp,{recursive:true,force:true});}
  result.diagramFrames=unionLength(result.windows);result.actionFrames=unionLength(result.windows.flatMap(w=>w.actions),true);
  return result;
}
