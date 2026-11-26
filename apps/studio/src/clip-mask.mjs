import {createHash} from 'node:crypto';
import {stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {validateMask} from '../www/clip-automation.js';

// Distance is measured in output pixels, so wide panes keep an even feather radius.
export function maskSampler(mask,width,height){
  const cx=mask.x*width,cy=mask.y*height,rx=mask.width*width/2,ry=mask.height*height/2;
  const feather=Math.max(1,(mask.feather??0)*Math.min(width,height));
  return (x,y)=>{
    const dx=Math.abs(x-cx),dy=Math.abs(y-cy);
    const edge=mask.shape==='ellipse'?(1-Math.hypot(dx/rx,dy/ry))*Math.min(rx,ry):Math.min(rx-dx,ry-dy);
    const alpha=Math.max(0,Math.min(1,.5+edge/feather));
    return mask.invert?1-alpha:alpha;
  };
}
export async function writeMask(mask,width,height,work,signal){
  validateMask(mask);
  const hash=createHash('sha256').update(JSON.stringify([mask.shape,mask.x,mask.y,mask.width,mask.height,mask.feather??0,mask.invert??false,width,height])).digest('hex');
  const file=path.join(work,'mask-'+hash+'.pgm');
  if(await stat(file).catch(()=>false))return file;
  const header=Buffer.from('P5\n'+width+' '+height+'\n255\n'),pixels=Buffer.allocUnsafe(header.length+width*height);
  header.copy(pixels);
  const sample=maskSampler(mask,width,height);
  for(let y=0;y<height;y++){
    if((y&63)===0){signal?.throwIfAborted();await new Promise(resolve=>setImmediate(resolve));}
    let i=header.length+y*width;
    for(let x=0;x<width;x++)pixels[i++]=Math.round(255*sample(x+.5,y+.5));
  }
  await writeFile(file,pixels,{signal});return file;
}

// QA uses rectangular sample regions. Only credit a cell if all its probes can see
// that source through the higher mattes. Rendered alpha itself remains pixel-accurate.
export function exposedMaskRegions(shots,profile,normalized){
  const n=24,stack=shots.map(shot=>{
    const r=normalized(shot.clip.viewport,profile);
    const w=(profile?.width||1080)*r.width,h=(profile?.height||1080)*r.height;
    const sample=shot.clip.mask&&maskSampler(shot.clip.mask,w,h);
    return {shot,regions:[],at(x,y){
      const dx=(x-r.x)/r.width,dy=(y-r.y)/r.height;
      return dx<0||dy<0||dx>1||dy>1?0:sample?sample(dx*w,dy*h):1;
    }};
  });
  for(let y=0;y<n;y++){
    const runs=stack.map(()=>null);
    for(let x=0;x<=n;x++){
      const points=[[.05,.05],[.95,.05],[.5,.5],[.05,.95],[.95,.95]],transmission=points.map(()=>1);
      for(let i=stack.length-1;i>=0;i--){
        const layer=stack[i],visible=x<n&&points.map(([a,b],j)=>{
          const opacity=layer.at((x+a)/n,(y+b)/n),weight=transmission[j]*opacity;
          transmission[j]*=1-opacity;return weight>=.1;
        }).every(Boolean);
        if(visible&&runs[i]===null)runs[i]=x;
        if(!visible&&runs[i]!==null){
          const start=runs[i],previous=layer.regions.findLast(r=>r.x===start&&r.width===x-start&&r.y+r.height===y);
          if(previous)previous.height++;else layer.regions.push({x:start,y,width:x-start,height:1});
          runs[i]=null;
        }
      }
    }
  }
  return stack.filter(s=>s.regions.length).map(({shot,regions})=>({shot,regions:regions.map(r=>({x:r.x/n,y:r.y/n,width:r.width/n,height:r.height/n}))}));
}
