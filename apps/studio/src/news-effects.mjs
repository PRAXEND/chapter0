// Local equivalents of the three archived editor effects. Use the picture's project clock
// for all samples, including exports which start in the middle of the source effect.
export const shakeDefaults={type:'camera-shake',strength:.35,speed:6,zoom:1.015,rotation:.1,breathe:0};
export const newsEffects=[
  {id:'camera-shake',sourceId:'builtin:fx-shake',name:'动作震屏',placement:'picture',frames30:7,defaults:shakeDefaults},
  {id:'whip-pan',sourceId:'builtin:tr-whip-pan',name:'甩镜',placement:'transition',frames30:8},
  {id:'organic-dissolve',sourceId:'builtin:tr-organic-dissolve',name:'纹理溶解',placement:'transition',frames30:10},
];
const within=(v,lo,hi)=>Number.isFinite(v)&&v>=lo&&v<=hi;
export function validatePictureEffects(effects,clip){
  if(!Array.isArray(effects)||effects.length>16||clip.track!=='video')throw Error('画面效果须置于视频片段');
  for(const fx of effects){
    const e={...shakeDefaults,offsetFrames:0,phaseFrames:0,...fx};
    if(e.type!=='camera-shake'||Object.keys(e).some(k=>!Object.hasOwn(shakeDefaults,k)&&!['offsetFrames','phaseFrames','duration'].includes(k))||
      ![e.offsetFrames,e.phaseFrames,e.duration].every(Number.isSafeInteger)||e.offsetFrames<0||e.phaseFrames<0||e.phaseFrames>86400*120||
      e.duration<1||e.offsetFrames+e.duration>clip.duration||!within(e.strength,0,2)||!within(e.speed,.1,30)||
      !within(e.zoom,1,1.5)||!within(e.rotation,0,10)||!within(e.breathe,0,.2))throw Error('震屏时长、位置或参数无效');
  }
}
export function splitPictureEffects(effects,head){
  const left=[],right=[];
  for(const e of effects){
    const start=e.offsetFrames??0,end=start+e.duration;
    if(start<head)left.push({...e,offsetFrames:start,duration:Math.min(head,end)-start});
    if(end>head)right.push({...e,offsetFrames:Math.max(0,start-head),duration:end-Math.max(head,start),
      phaseFrames:(e.phaseFrames||0)+Math.max(0,head-start)});
  }
  return [left,right];
}
export function shakeFilter(clip,first,profile){
  if(!clip.pictureEffects?.length)return '';
  validatePictureEffects(clip.pictureEffects,clip);
  return clip.pictureEffects.map(fx=>{
    const e={...shakeDefaults,offsetFrames:0,phaseFrames:0,...fx},offset=first-clip.start-e.offsetFrames;
    const t=n=>'('+n+'+'+(offset+e.phaseFrames)+')',on=n=>'between('+n+'+'+offset+',0,'+(e.duration-1)+')';
    const wave=(n,freq)=>'sin('+t(n)+'*'+Number((2*Math.PI*e.speed*freq/profile.fps).toFixed(9))+')';
    const z='if('+on('on')+','+e.zoom+'+'+e.breathe+'*abs('+wave('on',.5)+'),1)';
    const coord=(size,freq)=>'('+size+'-'+size+'/zoom)*(.5+'+Math.min(.49,e.strength*.6)+'*'+wave('on',freq)+')';
    // Crop enough of the rotation edge inside the authored zoom to avoid exposed black borders.
    return "rotate=angle='if("+on('n')+","+wave('n',.7)+"*"+e.rotation+"*PI/180,0)':bilinear=1,"+
      "zoompan=z='"+z+"':x='"+coord('iw',1)+"':y='"+coord('ih',1.57)+"':d=1:s="+profile.width+'x'+profile.height+':fps='+profile.fps;
  }).join(',');
}
export function newsTransition(type,phase){
  if(type==='organic-dissolve'){
    const mask='(0.50+0.22*sin(11*X/W+4*sin(8*Y/H))+0.15*sin(15*Y/H-2*sin(15*X/W))+0.075*sin(38*X/W+26*Y/H))';
    const alpha='clip(('+phase+'-'+mask+')*10+0.5,0,1)';
    return "blend=all_expr='A*("+alpha+")+B*(1-("+alpha+"))':shortest=1";
  }
  if(type!=='whip-pan')return null;
  // Stack the outgoing frame on the left and the incoming frame on the right.
  // Unlike a wipe, this moves detail in both sources. The order works for cropped panes too.
  const p='('+phase.replaceAll('N-1','n')+')',ease='('+p+'*'+p+'*(3-2*'+p+'))';
  return "xstack=inputs=2:layout=w1_0|0_0:shortest=1,crop=w=iw/2:h=ih:x='(iw/2)*"+ease+"':y=0:exact=1,"+
    "avgblur=sizeX=7:sizeY=1:enable='gt("+p+",0)*lt("+p+",1)'";
}
