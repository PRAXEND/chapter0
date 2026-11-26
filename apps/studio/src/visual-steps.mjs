import {focusKeys,blendKeys} from '../www/clip-automation.js';
import {randomUUID} from 'node:crypto';
import {viewportRect} from './viewport.mjs';

const stageNames = {problem:'观察问题', detail:'看细节', mechanism:'解释原因', verification:'回到原片'};
const bounded = (n, min, max) => Math.max(min, Math.min(max, n));
const inUnit = n => Number.isFinite(n) && n >= 0 && n <= 1;
const units = text => [...text].reduce((n,c)=>n+(/^[\x00-\x7f]$/.test(c)?.55:1),0);

export function validRegion(r) {
  return !!r && [r.x,r.y,r.width,r.height].every(inUnit) && r.width>0 && r.height>0 && r.x+r.width<=1.000001 && r.y+r.height<=1.000001;
}

export function projectSourceRegion(region, view, profile, atFrame) {
  if(!validRegion(region)||![view?.width,view?.height,profile?.width,profile?.height].every(n=>Number.isFinite(n)&&n>0)) return null;
  if (view.viewport) {
    const pane=viewportRect(view.viewport,profile);
    const local=projectSourceRegion(region,{...view,viewport:null},{...profile,...pane},atFrame);
    return local && {...local,x:(pane.x+local.x*pane.width)/profile.width,y:(pane.y+local.y*pane.height)/profile.height,
      width:local.width*pane.width/profile.width,height:local.height*pane.height/profile.height};
  }
  const A=view.width*(Number.isFinite(view.pixelAspect)&&view.pixelAspect>0?view.pixelAspect:1)/view.height, T=profile.width/profile.height;
  let left,top,width,height;
  if(view.framing || view.fit==='cover') {
    const from=view.framing?.from||{x:.5,y:.5,zoom:1}, to=view.framing?.to||from;
    if(![from,to].every(k=>inUnit(k.x)&&inUnit(k.y)&&Number.isFinite(k.zoom)&&k.zoom>=1&&k.zoom<=4)) return null;
    const f=bounded((atFrame-(view.start??0))/Math.max(1,(view.duration??1)-1),0,1);
    const key=view.framing?.keys?.length&&blendKeys(focusKeys(view),atFrame-(view.start??0));
    const value=k=>key?key[k]:from[k]+(to[k]-from[k])*f;
    const viewW=Math.min(1,T/A)/value('zoom'), viewH=Math.min(1,A/T)/value('zoom');
    const x=bounded(value('x')-viewW/2,0,1-viewW), y=bounded(value('y')-viewH/2,0,1-viewH);
    left=(region.x-x)/viewW;top=(region.y-y)/viewH;width=region.width/viewW;height=region.height/viewH;
  } else {
    const scaleW=Math.min(1,A/T),scaleH=Math.min(1,T/A);
    left=(1-scaleW)/2+region.x*scaleW;top=(1-scaleH)/2+region.y*scaleH;
    width=region.width*scaleW;height=region.height*scaleH;
  }
  const visibleW=Math.max(0,Math.min(1,left+width)-Math.max(0,left));
  const visibleH=Math.max(0,Math.min(1,top+height)-Math.max(0,top));
  return {x:left+width/2,y:top+height/2,width,height,visibleFraction:Math.min(1,visibleW*visibleH/(width*height))};
}

export function scienceExecutionPlan(blueprint={},spec={}) {
  const roles={
    problem:{components:['impact-title'],aim:'从可见任务提出具体矛盾，保留能说明问题的原画面。'},
    detail:{components:['staggered-explanation'],aim:'逐处指出能实际辨认的部位、痕迹或条件，把观察标签放到相应位置。'},
    mechanism:{components:['process-rail','comparison-guide'],aim:'让观众看见原因与结果怎样对应。原片能看见过程时，跟随真实动作。原片只能交代现场时，用实际细节作前后对照，或在原照旁放标有“原理示意”的可编辑图解，让状态随相应的解说变化。把论文依据和画面能直接证明的部分分别标清。'},
    verification:{components:['impact-title','source-label'],aim:'回到原片或实验结果回答开头，区分可见证据和推断。'}
  };
  return {template:'step-reveal',stages:roles,palette:blueprint.palette||{text:'#FFFFFF',mechanism:'#48E1D1',contrast:'#F7CB52'},
    sourceRules:(spec.rules||[]).filter(r=>['video-first','material-roles','script-picture-map','payoff-and-boundary'].includes(r.id)).map(r=>({id:r.id,instruction:r.instruction})),
    prototype:(blueprint.graphic_placements||[]).map(p=>({component:p.component,frames:p.timeline_frames,region:p.rect_normalized,example:p.reference_text})),
    adaptation:(spec.rules||[]).some(r=>r.id==='video-first')
      ?'此版明确要求以真实运动、实验、录屏或已标身份的仿真作为主体。静态史料可短暂用于局部指认，然后返回有信息的过程或结果。用户明确要求只用照片或照片为主时可按原照做分步图解。其他情况下，全静态或少量实拍的处理应说明与所选风格的差距。'
      :'有运动或实验过程时选能作证的原片窗口；原题是照片、图表或静物时，可依靠有位置的细节、分步对照和回到原图完成解释。每个关注区都应写清画面上具体能看见什么。'};
}

function positionKeys(start,end,view,region,profile,labelPosition) {
  const keys=[], frames=end-start;
  const step=view.framing?.to?Math.max(1,Math.floor(profile.fps/4)):frames;
  for(let f=0;f<frames;f+=step) keys.push(f);
  if(view.framing?.to&&keys.at(-1)!==frames-1) keys.push(frames-1);
  const boxes=keys.map(f=>projectSourceRegion(region,view,profile,start+f));
  if(boxes.some(b=>!b||b.visibleFraction<.96)) throw Error('兴趣区被本镜头裁出画面，请缩小兴趣区或改用看得清它的时间段。');
  const box=boxes[0];
  return {box,keys:boxes.map((b,i)=>({frame:keys[i],...(labelPosition?labelPosition(b):{x:b.x,y:b.y}),scale:labelPosition?1:b.width/box.width,opacity:1}))};
}

export function compileVisualSteps(scene,profile) {
  const {start,duration,style,visualSteps:steps,anchorAssetId,evidenceView:view}=scene;
  const finish=start+duration,{width,height,fps}=profile;
  if(!Array.isArray(steps)||!steps.length||steps.length>6||!anchorAssetId||!view||!/^[a-f0-9]{64}$/.test(view.sha256||'')) throw Error('分步指引需要已核实原件、画幅、指纹以及一至六个可见观察。');
  const layers=[],sequenceId=randomUUID();
  const prepared=steps.map((s,i)=>{
    const at=s?.atFrame, end=i+1<steps.length?steps[i+1]?.atFrame:finish;
    const label=String(s?.label||'').trim(),observation=String(s?.observation||'').trim();
    if(!Object.hasOwn(stageNames,s?.stage)||!Number.isSafeInteger(at)||at<start||!Number.isSafeInteger(end)||end<=at||end>finish||!validRegion(s.region)) throw Error('分步的阶段、兴趣区或显示顺序无效。');
    if(!label||units(label)>22||[...observation].length<3||observation.length>380) throw Error('每步需要可读的短标签和来自原画面的具体观察。');
    if(end-at<Math.max(2,Math.ceil(fps*Math.max(.35,units(label)/12))))throw Error('视觉标签出现时间过短，请缩短文案或扩大区间。');
    const sourceFrame=s.sourceFrame??scene.anchorSourceFrame;
    if(!Number.isSafeInteger(sourceFrame)||sourceFrame<0)throw Error('分步缺少对应的原片帧。');
    const region={x:s.region.x,y:s.region.y,width:s.region.width,height:s.region.height};
    const id=randomUUID();
    return {stage:s.stage,at,end,label,observation,region,sourceFrame,id};
  });
  const first=prepared[0], rail=prepared.length>1;
  const railY=(projectSourceRegion(first.region,view,profile,first.at)?.y??.5)<.22?.75:.09;
  function graphic(role,s,props) {
    return {id:randomUUID(),track:'graphic',start:s.at,duration:s.end-s.at,sourceIn:0,speed:1,gain:1,locked:false,
      template:'step-reveal',templateVersion:2,templateRole:role,styleId:style.id,styleVersion:style.version,
      actionFrame:s.at,anchorAssetId,anchorSourceFrame:s.sourceFrame,continuity:scene.continuity||'',evidenceAnchor:{stepId:s.id,sequenceId,stage:s.stage,
        assetId:anchorAssetId,sha256:view.sha256,sourceFrame:s.sourceFrame,region:s.region,observation:s.observation,label:s.label},...props};
  }
  const title=String(scene.text||'').trim();
  const titleRoom=first.at-start;
  if(title&&units(title)<=36&&titleRoom>=fps*Math.max(.5,units(title)/12)) {
    layers.push({id:randomUUID(),track:'graphic',start,duration:titleRoom,sourceIn:0,speed:1,gain:1,locked:false,
      template:'step-reveal',templateVersion:2,templateRole:'question',styleId:style.id,styleVersion:style.version,text:title,
      geometry:{x:.5,y:.19},style:{fontSize:Math.max(12,Math.floor(Math.min(height*.053,width*.84/(units(title)+1.5)))),color:'#FFFFFF',backgroundColor:'#061218EC'}});
  }
  for(const [index,s] of prepared.entries()) {
    const local=s.region.width*s.region.height<.72;
    const ink=s.stage==='mechanism'?'#F7CB52':'#48E1D1';
    const hit=positionKeys(s.at,s.end,view,s.region,profile);
    if(local) {
      const {x,y,width:w,height:h}=hit.box;
      if(w*width<7||h*height<7)throw Error('关注的原图细节太小，请用可见的近景或扩大可辨认的范围。');
      layers.push(graphic('evidence-region',s,{shape:'outline',text:'',geometry:{x,y,width:w,height:h},keyframes:hit.keys,style:{color:ink,strokeWidth:Math.max(2,Math.round(Math.min(width,height)*.005))}}));
    }
    const sizeRatio={problem:.071,detail:.061,mechanism:.066,verification:.059}[s.stage];
    const size=Math.max(12,Math.floor(Math.min(height*sizeRatio,width*.84/(units(s.label)+1.5))));
    const halfW=Math.min(.46,(size*(units(s.label)+1.25))/(2*width)), halfH=Math.max(.029,size/height*.76);
    const place=b=>{
      const above=b.y-b.height/2-halfH-.015, below=b.y+b.height/2+halfH+.015;
      const y=[above,below].find(v=>v>=.04&&v<=.81&&(!rail||Math.abs(v-railY)>halfH+.04));
      return {x:bounded(b.x,halfW+.022,.978-halfW),y:y??(railY<.5?.69:.18)};
    };
    const labelKeys=positionKeys(s.at,s.end,view,s.region,profile,place).keys;
    layers.push(graphic('evidence-label',s,{text:s.label,geometry:{x:labelKeys[0].x,y:labelKeys[0].y},style:{fontSize:size,color:'#FFFFFF',backgroundColor:'#061218EC'},keyframes:labelKeys}));
    if(rail) {
      const span=.89/prepared.length, chipX=.055+(index+.5)*span;
      const railText=stageNames[s.stage],railSize=Math.max(10,Math.floor(Math.min(height*.033,width*(span-.015)/(units(railText)+1.3))));
      const chip=(from,to,isCurrent)=>{
        if(to<=from)return;
        layers.push(graphic('process-rail',s,{start:from,duration:to-from,text:(index+1)+'  '+railText,stageActive:isCurrent,geometry:{x:chipX,y:railY},
          style:{fontSize:railSize,color:isCurrent?ink:'#D2DEDF',backgroundColor:isCurrent?'#061218EF':'#15212BBA'},keyframes:[{frame:0,x:chipX,y:railY,opacity:isCurrent?1:.74,scale:1}]}));
      };
      chip(first.at,s.at,false);chip(s.at,s.end,true);chip(s.end,finish,false);
    }
  }
  return layers;
}
