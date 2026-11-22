import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {projectSourceRegion,validRegion} from './visual-steps.mjs';
import {shotFingerprint} from './director-visual.mjs';

const execute=promisify(execFile);
const live=c=>c.hidden!==true&&c.enabled!==false;
const lastFrame=c=>c.start+c.duration-1;
const covers=(c,f)=>live(c)&&c.start<=f&&f<=lastFrame(c);
const clamp=(x,lo,hi)=>Math.min(hi,Math.max(lo,x));
const stageNames=new Set(['problem','detail','mechanism','verification']);
const finding=(id,severity,message,fix,fromFrame,toFrame)=>({id,reason:'visual-evidence',severity,message,fix,fromFrame,toFrame});
const positiveClauses=text=>String(text||'').split(/[。；;\n，,]/u).filter(s=>!/(?:不必|不需要|无需|不用|不要|不要求|不强求|不必强求|do not (?:need|require|use)|no need to)/i.test(s)).join('。');

export function visualRequirements(project) {
  const explicit=project.settings?.visualRequirements||{};
  const brief=positiveClauses(project.brief);
  const editable=/可编辑.{0,22}(?:强调|标注|指引|框|圈|箭头|兴趣区)|(?:定位|圈出|框出|指出|标出).{0,12}(?:纹路|局部|部位|区域|细节)|editable.{0,24}(?:callout|annotation|highlight)/i.test(brief);
  const style=/(?:严格|忠实|依照|照着|复刻|贴近|对齐).{0,18}(?:所选|选中的|参考|这套|这个|本项目的).{0,10}(?:风格|样片|剪法)|faithfully (?:follow|match) (?:the )?(?:selected |reference )?style|((?:严格|复现|复刻|遵循|照着|接近|忠实|贴近|对齐|依照|模仿|按).{0,16}(?:henry|基准片|科普风格|科普模板)|(?:henry|基准片).{0,12}(?:科普风格|同款|效果|复现|复刻|风格))/i.test(brief);
  const motion=/(?:需要|必须|务必|全程|请用|请使用|请加入|只用|要求).{0,16}(?:运动实拍|运动画面|动态实拍|实拍运动|实拍动作|实验实录|操作实录|动态过程|动作视频)|real (?:moving footage|motion footage)/i.test(brief);
  return {editableEvidence:explicit.editableEvidence??editable,styleFidelity:explicit.styleFidelity??style,motionFootage:explicit.motionFootage??motion};
}

function transformed(clip,profile,frame) {
  const g=clip.geometry||{},origin={frame:0,x:g.x??.5,y:g.y??.28,scale:1,opacity:1},events=new Map([[0,origin]]);
  let current=origin;
  for(const key of [...(clip.keyframes||[])].sort((a,b)=>a.frame-b.frame)){
    current={...current,...key};events.set(key.frame,current);
  }
  const points=[...events.values()];const when=frame-clip.start;
  const l=points.filter(k=>k.frame<=when).at(-1)||origin,r=points.find(k=>k.frame>when)||l;
  const ratio=r.frame===l.frame?0:(when-l.frame)/(r.frame-l.frame);
  const val=k=>(l[k]??origin[k])+((r[k]??origin[k])-(l[k]??origin[k]))*ratio;
  return {x:val('x'),y:val('y'),width:(g.width||0)*val('scale'),height:(g.height||0)*val('scale'),opacity:val('opacity'),color:clip.style?.color||'#FFFFFF',strokeWidth:clip.style?.strokeWidth||Math.max(2,Math.min(profile.width,profile.height)*.004)};
}

const unitColor=value=>{
  const m=/^#([a-f\d]{6})([a-f\d]{2})?$/i.exec(value||'');
  return m?{rgb:m[1].match(/../g).map(h=>parseInt(h,16)),alpha:m[2]?parseInt(m[2],16)/255:1}:null;
};

function overlapRatio(a,b) {
  const overlap=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  return overlap/(a.width*a.height+b.width*b.height-overlap||1);
}
const boxRect=b=>({x:b.x-b.width/2,y:b.y-b.height/2,width:b.width,height:b.height});
const plain=t=>String(t||'').trim().toLocaleLowerCase().replace(/[\s，。！？,.!?:：]/gu,'');
const generic=t=>/^(?:步骤?\d+|细节|重点|请看|这里|见图|原图|第一步|第二步|第三步|证据|lookhere|detail|step\d+)$/iu.test(plain(t));
function similarEvidence(a,b) {
  return a.assetId===b.assetId&&overlapRatio(a.region,b.region)>.78;
}

async function decodePixels(ffmpeg,file,sec,width,height,signal) {
  const result=await execute(ffmpeg,['-nostdin','-v','error','-ss',String(Math.max(0,sec)),'-protocol_whitelist','file','-i',file,
    '-map','0:v:0','-frames:v','1','-an','-vf','scale='+width+':'+height,'-pix_fmt','rgb24','-threads','1','-f','rawvideo','pipe:1'],
    {signal,encoding:'buffer',maxBuffer:width*height*3+65536,timeout:30000});
  if(result.stdout.length!==width*height*3)throw Error('缺少合成画面');
  return result.stdout;
}

function matchingPaint(pixels,w,h,box) {
  const color=unitColor(box.color);
  if(!color||color.alpha*box.opacity<.15)return {visible:false,sideCoverage:[0,0,0,0]};
  const [R,G,B]=color.rgb,center=[box.x*w,box.y*h],half=[box.width*w*.5,box.height*h*.5],radius=3;
  const near=(x,y)=>{
    for(let j=-radius;j<=radius;j++)for(let i=-radius;i<=radius;i++) {
      const ix=Math.round(x+i),iy=Math.round(y+j);if(ix<0||iy<0||ix>=w||iy>=h)continue;
      const at=(ix+iy*w)*3,dr=Math.abs(pixels[at]-R),dg=Math.abs(pixels[at+1]-G),db=Math.abs(pixels[at+2]-B);
      if(Math.max(dr,dg,db)<85&&(dr+dg+db)<134)return true;
    }
    return false;
  };
  // A uniformly similar sky or painted wall must not count as the four edges of a visible outline.
  const edge=(x,y,nx,ny)=>near(x,y)&&(!near(x+nx*9,y+ny*9)||!near(x-nx*9,y-ny*9));
  const sides=[0,0,0,0];
  for(let n=1;n<=12;n++){const t=(n/13)*2-1;
    sides[0]+=edge(center[0]+t*half[0],center[1]-half[1],0,1);sides[1]+=edge(center[0]+t*half[0],center[1]+half[1],0,1);
    sides[2]+=edge(center[0]-half[0],center[1]+t*half[1],1,0);sides[3]+=edge(center[0]+half[0],center[1]+t*half[1],1,0);
  }
  return {visible:sides.filter(n=>n>=7).length>=3,sideCoverage:sides.map(n=>Number((n/12).toFixed(2)))};
}
function widestReturn(shot,profile,frame) {
  const projected=projectSourceRegion({x:0,y:0,width:1,height:1},{...shot.asset,fit:shot.clip.fit,framing:shot.clip.framing,start:shot.clip.start,duration:shot.clip.duration},profile,frame);
  return projected&&projected.visibleFraction>=.75;
}

function makeSteps(project,shots) {
  const graphics=project.timeline.clips.filter(c=>live(c)&&c.track==='graphic');
  const fps=project.profile.fps, profile=project.profile,steps=[];
  const shapeAmbiguous=graphics.some(c=>c.shape==='outline'&&c.geometry?.width>0&&c.geometry?.height>0);
  const labels=graphics.filter(c=>c.evidenceAnchor&&c.text&&plain(c.evidenceAnchor.label)===plain(c.text));
  const candidates=labels.map(label=>({label,a:label.evidenceAnchor,annotation:'editable-label'}));
  const captions=project.timeline.clips.filter(c=>live(c)&&c.track==='caption'&&plain(c.text)&&!generic(c.text));
  for(const box of graphics.filter(c=>c.shape==='outline'&&c.evidenceAnchor)) {
    const a=box.evidenceAnchor;
    if(labels.some(l=>l.evidenceAnchor.stepId===a.stepId&&l.start<=lastFrame(box)&&box.start<=lastFrame(l)))continue;
    for(const cue of captions.filter(c=>c.start<=lastFrame(box)&&box.start<=lastFrame(c))) {
      const at=Math.max(box.start,cue.start),to=Math.min(lastFrame(box),lastFrame(cue));
      if(sharesSubject({...a,fromFrame:at,toFrame:to},project)===true)candidates.push({label:cue,a,annotation:'synchronized-caption'});
    }
  }
  for(const {label,a,annotation} of candidates) {
    if(!a||!stageNames.has(a.stage)||!validRegion(a.region)||!a.stepId||!plain(a.label)||generic(a.label)||plain(a.observation).length<3||generic(a.observation))continue;
    const local=a.region.width*a.region.height<.72,outline=graphics.find(c=>c.shape==='outline'&&c.evidenceAnchor?.stepId===a.stepId&&c.evidenceAnchor?.sha256===a.sha256);
    const from=Math.max(label.start,outline?.start??label.start);
    const end=Math.min(lastFrame(label),outline?lastFrame(outline):lastFrame(label));
    if(end-from+1<Math.max(2,Math.floor(fps*.28)))continue;
    const mid=Math.floor((from+end)/2),shot=shots.filter(s=>covers(s.clip,mid)).at(-1);
    if(!shot?.asset||shot.asset.id!==a.assetId||shot.asset.sha256!==a.sha256||!Number.isSafeInteger(a.sourceFrame))continue;
    if(shot.asset.kind==='image'?a.sourceFrame!==0:a.sourceFrame<(shot.clip.sourceIn||0)||a.sourceFrame>=(shot.clip.sourceIn||0)+shot.clip.duration*(shot.clip.speed||1))continue;
    if(transformed(label,profile,mid).opacity<.15||unitColor(label.style?.color||'#FFFFFF')?.alpha<.15)continue;
    const view={width:shot.asset.width,height:shot.asset.height,pixelAspect:shot.asset.pixelAspect,fit:shot.clip.fit,framing:shot.clip.framing,start:shot.clip.start,duration:shot.clip.duration};
    const expected=projectSourceRegion(a.region,view,profile,mid);
    if(!expected||expected.visibleFraction<.85)continue;
    const step={stepId:a.stepId,assetId:a.assetId,sha256:a.sha256,sourceFrame:a.sourceFrame,stage:a.stage,region:a.region,label:a.label,observation:a.observation,
      fromFrame:from,toFrame:end,frame:mid,annotation,shownText:label.text,localized:false,fullView:widestReturn(shot,profile,mid),sourceFile:shot.asset.path};
    if(local&&outline){
      const box=transformed(outline,profile,mid);
      if(box.opacity>.15&&overlapRatio(boxRect(box),boxRect(expected))>=.72&&box.width*profile.width>=7&&box.height*profile.height>=7) {
        step.localized=true;step.box=box;
      }
    }
    steps.push(step);
  }
  return {steps:steps.sort((a,b)=>a.frame-b.frame),shapeAmbiguous};
}

function visibleWindows(shots) {
  const edges=[...new Set(shots.flatMap(s=>[s.clip.start,s.clip.start+s.clip.duration]))].sort((a,b)=>a-b),windows=[];
  for(let i=0;i+1<edges.length;i++) {
    const from=edges[i],to=edges[i+1]-1,s=shots.filter(s=>covers(s.clip,from)).at(-1);
    if(!s)continue;
    const previous=windows.at(-1);
    if(previous?.shot===s&&previous.to+1===from)previous.to=to;
    else windows.push({from,to,shot:s});
  }
  return windows;
}

function sceneChange(a,b,w,h) {
  const lum=(buf,x,y)=>{const n=(y*w+x)*3;return .25*buf[n]+.52*buf[n+1]+.23*buf[n+2];};
  let best=Infinity,raw;
  for(const zoom of [1,.92,.96,1.04,1.08])for(const dx of [0,-6,-3,3,6])for(const dy of [0,-4,-2,2,4]) {
    let sum=0,count=0;
    for(let y=6;y<h-6;y+=2)for(let x=9;x<w-9;x+=2){
      const tx=Math.round((x-w/2)/zoom+w/2+dx),ty=Math.round((y-h/2)/zoom+h/2+dy);
      if(tx<0||ty<0||tx>=w||ty>=h)continue;
      sum+=Math.min(50,Math.abs(lum(a,x,y)-lum(b,tx,ty)));count++;
    }
    const error=sum/Math.max(1,count);
    if(zoom===1&&dx===0&&dy===0)raw=error;
    best=Math.min(best,error);
  }
  return {change:+raw.toFixed(2),afterGlobalMotion:+best.toFixed(2)};
}

async function measureMotion(project,windows,ffmpeg,signal,videoPath) {
  const records=[],fps=project.profile.fps;
  const spans=[];
  for(const window of windows.filter(v=>v.shot.asset?.kind==='video')) {
    const length=window.to-window.from+1,parts=Math.ceil(length/(4*fps));
    for(let i=0;i<parts;i++)spans.push({...window,from:window.from+Math.floor(length*i/parts),to:window.from+Math.floor(length*(i+1)/parts)-1});
  }
  const count=Math.min(36,spans.length);
  for(let i=0;i<count;i++) {
    const {from,to,shot:{clip,asset}}=spans[count===spans.length?i:Math.round(i*(spans.length-1)/(count-1))];
    if(!asset.path||to-from<fps*.35)continue;
    const d=to-from, at=(f)=>((clip.sourceIn||0)+(from-clip.start+f)*(clip.speed||1))/fps;
    const fractions=[.22,.47,.72],times=fractions.map(u=>at(d*u));
    try {
      const compare=async(file,timestamps)=>{
        const frames=[];for(const sec of timestamps)frames.push(await decodePixels(ffmpeg,file,sec,96,60,signal));
        const pair=[sceneChange(frames[0],frames[1],96,60),sceneChange(frames[1],frames[2],96,60)];
        const result=pair.every(p=>p.change<1.6)?'no-detectable-change':pair.every(p=>p.afterGlobalMotion<3.2)?'consistent-with-camera-movement':'changing-footage';
        return {pair,result};
      };
      const source=await compare(asset.path,times),candidate=await compare(videoPath,fractions.map(u=>(from+d*u)/fps));
      records.push({assetId:asset.id,fromFrame:from,toFrame:to,sourceTimes:times,comparisons:source.pair,candidateComparisons:candidate.pair,
        sourceResult:source.result,candidateResult:candidate.result,result:source.result==='changing-footage'?candidate.result:source.result});
    }catch(error){if(signal?.aborted)throw error;records.push({assetId:asset.id,fromFrame:from,toFrame:to,result:'unavailable'});}
  }
  return records;
}

function sharesSubject(step,project) {
  const nearby=(project.timeline.clips||[]).filter(c=>c.track==='caption'&&live(c)&&c.start<=step.toFrame&&lastFrame(c)>=step.fromFrame).map(c=>c.text);
  const facts=project.facts||[],current=facts.filter(f=>f.assetId===step.assetId&&Number.isFinite(f.start)&&f.start<=step.toFrame).sort((a,b)=>b.start-a.start)[0];
  const material=(nearby.length?nearby:[current?.text||current?.claim]).filter(Boolean).join(' ');
  if(!material.trim())return null;
  const segmenter=new Intl.Segmenter('zh',{granularity:'word'}),ignore=new Set(['因此','这个','画面','照片','这里','边上','先看','能看到','可以','因为','位置','看到','上面','下面','有点','the','this','that','with','look','shows','image']);
  const words=t=>new Set([...segmenter.segment(t.toLowerCase())].filter(x=>x.isWordLike&&[...x.segment].length>1&&!ignore.has(x.segment)).map(x=>x.segment));
  const vocabulary=words(material),description=words(step.label+' '+step.observation);
  if(vocabulary.size<3||description.size<2)return null;
  return [...description].some(w=>vocabulary.has(w)||w.length>2&&material.includes(w));
}

export function currentVisualChecks(project) {
  const receipt=project.visualDirection;
  if(!receipt?.timelineHash||receipt.timelineHash!==shotFingerprint(project))return [];
  return (receipt.checks||[]).filter(c=>stageNames.has(c.stage)&&Number.isSafeInteger(c.frame)&&plain(c.observation).length>=4&&
    receipt.frames?.some(f=>f.source==='timeline'&&f.frame===c.frame&&f.stage===c.stage&&/^[a-f0-9]{64}$/.test(f.sha256||'')));
}

async function filmedSequence(project,windows,checks,motion,hashFile) {
  const observed=project.visualDirection?.frames||[],verified=[],hashes=new Map();
  for(const check of checks.filter(c=>!c.needsFix)) {
    const window=windows.find(w=>w.from<=check.frame&&w.to>=check.frame),asset=window?.shot.asset;
    const row=(project.storyboard||[]).find(r=>r.assetId===asset?.id&&r.start<=check.frame&&r.start+r.duration>check.frame);
    const anchor=row?.visualSteps?.find(s=>s.stage===check.stage&&s.atFrame<=check.frame&&s.assetHash===asset?.sha256&&
      plain(s.observation).length>=4&&observed.some(f=>f.source==='asset'&&f.assetId===asset?.id&&f.assetHash===asset?.sha256&&f.sha256===s.witnessFrameHash));
    if(!anchor||asset.kind!=='video'||!motion.some(m=>m.assetId===asset.id&&m.fromFrame<=check.frame&&m.toFrame>=check.frame&&m.result==='changing-footage'))continue;
    if(!hashes.has(asset.id)){try{hashes.set(asset.id,await hashFile(asset.path));}catch{hashes.set(asset.id,null);}}
    if(hashes.get(asset.id)!==asset.sha256)continue;
    verified.push({stage:check.stage,frame:check.frame,assetId:asset.id,sha256:asset.sha256,sourceFrame:anchor.sourceFrame??anchor.anchorSourceFrame,witnessFrameHash:anchor.witnessFrameHash});
  }
  return verified.sort((a,b)=>a.frame-b.frame);
}
function usesScienceGrammar(project,styleSpec) {
  const spec=styleSpec||project.style||{}, declared=spec.executionPlan?.template||project.visualDirection?.executionPlan?.template||project.visualDirection?.template;
  if(declared)return declared==='step-reveal';
  const templates=spec.templates||spec.templateIds;
  if(Array.isArray(templates))return templates.some(t=>(typeof t==='string'?t:t.id)==='step-reveal');
  return project.timeline.clips.some(c=>c.template==='step-reveal')||spec.id==='henry-technical-explainer';
}
function videoFirstPolicy(project,spec) {
  const rule=[...(spec?.rules||[]),...(spec?.executionPlan?.sourceRules||[]),...(project.style?.rules||[])].find(r=>r.id==='video-first');
  if(!rule)return null;
  const explicit=project.settings?.visualRequirements?.motionFootage,brief=positiveClauses(project.brief);
  const photoOverride=brief.split('。').some(part=>(!/(?:开头|片头|结尾|片尾|这段|此段|这一镜|首个镜头)/.test(part)||/(?:全片|整片|整条|全程|所有素材)/.test(part))&&/(?:只(?:使用|用|以)|仅(?:使用|用|限)|全程(?:使用|用|只用)|全部(?:是|使用|用)|不用视频只用|只要).{0,20}(?:照片|相片|静图|静态图|原照|原图|图片)|(?:照片|原照|图片|静图|静态图|图解).{0,8}(?:为主|为主体|为唯一素材)|(?:still images|photos|photographs) only|only (?:use |using )?(?:still images|photos|photographs)/i.test(part));
  return {ruleId:rule.id,basis:rule.basis||'style',instruction:rule.instruction,override:explicit===false?'motionFootage:false':explicit!==true&&photoOverride?'user-photo-brief':null};
}
function coverage(windows,motion) {
  const length=w=>w.to-w.from+1,frames=motion.reduce((n,m)=>n+m.toFrame-m.fromFrame+1,0);
  const totalFrames=windows.reduce((n,w)=>n+length(w),0),stillFrames=windows.filter(w=>w.shot.asset?.kind==='image').reduce((n,w)=>n+length(w),0);
  const measured={changingFrames:0,stationaryFrames:0,cameraFrames:0};
  for(const m of motion) {
    const field={'changing-footage':'changingFrames','no-detectable-change':'stationaryFrames','consistent-with-camera-movement':'cameraFrames'}[m.result];
    if(field)measured[field]+=m.toFrame-m.fromFrame+1;
  }
  const unverifiedFrames=totalFrames-stillFrames-Object.values(measured).reduce((a,b)=>a+b,0);
  return {totalFrames,stillFrames,...measured,unverifiedFrames,sampledVideoFrames:frames,changingRatio:totalFrames?+((measured.changingFrames/totalFrames).toFixed(4)):0};
}
async function motionReview(project,windows,evidence,policy,checks,hashFile) {
  const {fps}=project.profile,c=coverage(windows,evidence.motion),r=project.visualDirection,verified=[];
  if(!policy.override&&c.changingFrames) {
    const filmed=await filmedSequence(project,windows,checks,evidence.motion,hashFile);
    evidence.witnessedShots=filmed;
    const known=new Set(),receipt=r?.motion,hashes=new Map();
    if(r?.timelineHash&&r.timelineHash===shotFingerprint(project))for(const item of receipt?.windows||[]) {
      const a=project.assets.find(a=>a.id===item.assetId&&a.kind==='video');
      const checkHash=(hash,sec)=>/^[a-f0-9]{64}$/.test(hash||'')&&r.frames?.some(f=>f.source==='asset'&&f.assetId===a?.id&&f.assetHash===a?.sha256&&f.sha256===hash&&Math.abs(f.seconds-sec)<=.5/fps);
      if(!a||item.assetHash!==a.sha256||item.fromHash===item.toHash||!checkHash(item.fromHash,item.sourceStart)||!checkHash(item.toHash,item.sourceEnd)||plain(item.observation).length<4)continue;
      if(!hashes.has(a.id)){try{hashes.set(a.id,await hashFile(a.path));}catch{hashes.set(a.id,null);}}
      if(hashes.get(a.id)!==a.sha256)continue;
      for(const m of evidence.motion) {
        if(m.assetId!==a.id||m.result!=='changing-footage'||!m.sourceTimes.some(s=>s>=item.sourceStart&&s<=item.sourceEnd))continue;
        const key=[a.id,m.fromFrame,item.sourceStart,item.sourceEnd].join('@');
        if(!known.has(key)){
          const w=windows.find(w=>w.shot.asset?.id===a.id&&w.from<=m.fromFrame&&w.to>=m.toFrame),clip=w?.shot.clip;
          if(!clip||clip.id!==item.clipId||clip.start!==item.timelineFrom||clip.duration!==item.timelineFrames)continue;
          const projected=t=>clip.start+(t*fps-(clip.sourceIn||0))/(clip.speed||1);
          const from=Math.max(m.fromFrame,Math.ceil(projected(item.sourceStart))),to=Math.min(m.toFrame,Math.ceil(projected(item.sourceEnd))-1);
          if(to<from)continue;
          verified.push({assetId:a.id,fromFrame:from,toFrame:to,observation:item.observation});known.add(key);
        }
      }
    }
  }
  const covered=[];
  for(const sample of evidence.motion.filter(m=>m.result==='changing-footage')){
    if(evidence.witnessedShots?.some(s=>s.assetId===sample.assetId&&s.frame>=sample.fromFrame&&s.frame<=sample.toFrame))covered.push([sample.fromFrame,sample.toFrame]);
    else for(const v of verified.filter(v=>v.assetId===sample.assetId&&v.fromFrame<=sample.toFrame&&v.toFrame>=sample.fromFrame))covered.push([v.fromFrame,v.toFrame]);
  }
  let end=-1;
  c.informativeFrames=0;
  for(const [from,to] of covered.sort((a,b)=>a[0]-b[0])){
    if(to>end)c.informativeFrames+=to-Math.max(from,end+1)+1;
    end=Math.max(end,to);
  }
  const informative=c.informativeFrames>c.totalFrames/2,majority=c.changingFrames>c.totalFrames/2;
  const status=policy.override?'photo-adaptation':majority?(informative?'met':'unverified'):c.changingFrames?'partial':
    c.stillFrames===c.totalFrames?'unmet':c.unverifiedFrames+c.cameraFrames>=c.totalFrames/2?'unverified':'unmet';
  evidence.motionCoverage=c;
  evidence.styleExecution={ruleId:policy.ruleId,basis:policy.basis,motionStatus:status,override:policy.override,informativeWindows:verified,
    assessment:status==='met'?'motion-rule-supported':status==='photo-adaptation'?'requested-photo-adaptation':status==='unverified'?'unverified':'not-reproduced'};
  if(status==='photo-adaptation'||status==='met')return null;
  const secs=n=>(n/fps).toFixed(1),ratios='全片有画面的 '+secs(c.totalFrames)+' 秒中，'+secs(c.stillFrames)+' 秒使用照片，'+secs(c.changingFrames)+' 秒在原片与成片均测到超出整体移动的变化。';
  const relevant=windows.filter(w=>w.shot.asset?.kind==='image'||!evidence.motion.some(m=>m.assetId===w.shot.asset?.id&&m.fromFrame>=w.from&&m.toFrame<=w.to&&m.result==='changing-footage'));
  const longest=relevant.sort((a,b)=>(b.to-b.from)-(a.to-a.from))[0]||windows[0];
  const severity=status==='unmet'&&c.stillFrames===c.totalFrames&&evidence.requirements.styleFidelity?'major':'minor';
  const message=status==='unmet'?'所选风格要求以有信息的运动画面为主体，本版未达到。':
    status==='partial'?'本版只有部分时段呈现有变化的视频，未达到所选风格以运动过程为主体的要求。':
    '所选风格要求以有信息的运动画面为主体，目前无法确认取到的变化确实在说明该段内容。';
  return finding('style-video-first',severity,message+ratios,'选择能说明对应台词的实拍、实验、录屏或标明身份的仿真，保留必要的原照片段。',longest.from,longest.to);
}
function relevantRange(project,first,last) {
  const cue=project.timeline.clips.find(c=>live(c)&&c.track==='graphic'&&/(?:留意|看这里|看此处|注意看|请看|观察|注意到|look here|notice|watch the)/i.test(c.text||''));
  return cue?[cue.start,lastFrame(cue)]:[first,last];
}

export async function reviewVisualEvidence(project,{videoPath,ffmpeg,signal,styleSpec,hashFile}) {
  const requirements=visualRequirements(project),findings=[];
  const science=usesScienceGrammar(project,styleSpec),policy=videoFirstPolicy(project,styleSpec);
  const assets=new Map(project.assets.map(a=>[a.id,a])),shots=project.timeline.clips.filter(c=>c.track==='video'&&live(c)).sort((a,b)=>a.start-b.start).map(clip=>({clip,asset:assets.get(clip.assetId)}));
  const windows=visibleWindows(shots),first=windows[0]?.from??0,last=windows.at(-1)?.to??0;
  const evidence={requirements,sourceWindows:windows.map(w=>({assetId:w.shot.clip.assetId,kind:w.shot.asset?.kind||'unknown',fromFrame:w.from,toFrame:w.to})),steps:[],motion:[]};
  if(!windows.length)return {evidence,findings};
  const checks=currentVisualChecks(project);
  if(checks.length)evidence.composedChecks=checks.map(c=>({stage:c.stage,frame:c.frame,needsFix:c.needsFix}));
  for(const c of checks.filter(c=>c.needsFix)) {
    const cue=project.timeline.clips.find(clip=>clip.track==='caption'&&covers(clip,c.frame));
    findings.push(finding('visual-witness-'+c.frame,requirements.editableEvidence||requirements.styleFidelity?'unknown':'minor','合成复看记录：'+c.observation+(cue?' 同段字幕为“'+cue.text+'”。':''),'回看对应原片与这段合成画面，再调整贴合画面的说明或镜头。',cue?.start??c.frame,cue?lastFrame(cue):c.frame));
  }
  if(!Object.values(requirements).some(Boolean)&&!policy)return {evidence,findings};
  const photosOnly=windows.every(w=>w.shot.asset?.kind==='image');
  if(requirements.motionFootage) {
    if(photosOnly)findings.push(finding('required-moving-footage','major','本期明确要求运动实拍，画面全由照片组成。','加入能显示所述过程的实拍窗口，或由用户更改该素材要求。',first,last));
    else {
      evidence.motion=await measureMotion(project,windows,ffmpeg,signal,videoPath);
      if(!evidence.motion.some(m=>m.result==='changing-footage'))findings.push(finding('required-moving-footage','unknown','抽取的原片窗口不能确认有超出整幅平移、缩放或定格的过程。','回看标出的原片，选真实运动区间或确认当前处理。',first,last));
    }
  }
  if(!requirements.editableEvidence&&!requirements.styleFidelity&&!policy)return {evidence,findings};
  const {steps,shapeAmbiguous}=makeSteps(project,shots),hashes=new Map(),fps=project.profile.fps;
  const w=Math.max(16,Math.min(640,project.profile.width)),h=Math.max(16,Math.round(w*project.profile.height/project.profile.width));
  const confirmed=[];
  for(const s of steps) {
    const {sourceFile,box,...record}=s;
    if(s.localized) {
      try{
        if(!hashes.has(s.assetId))hashes.set(s.assetId,await hashFile(sourceFile));
        record.sourceVerified=hashes.get(s.assetId)===s.sha256;
        record.frameMatch=matchingPaint(await decodePixels(ffmpeg,videoPath,s.frame/fps,w,h,signal),w,h,box);
        record.canvasRegion={x:box.x,y:box.y,width:box.width,height:box.height};
        record.relatedWords=sharesSubject(s,project);
        if(record.sourceVerified&&record.frameMatch.visible&&record.relatedWords!==false)confirmed.push(s);
      } catch(error) {if(signal?.aborted)throw error;record.frameMatch={visible:null};}
    }
    evidence.steps.push(record);
  }
  const candidate=steps.some(s=>s.localized),hasLocal=confirmed.length>0;
  const finalWindow=windows.at(-1),lastShot=finalWindow?.shot;
  const laterCut=hasLocal&&lastShot?.clip.start>confirmed[0].toFrame;
  const zoom=lastShot?.clip.framing;
  const widerCamera=zoom?.to&&zoom.from.zoom-zoom.to.zoom>=.22;
  const visibleReturn=hasLocal&&lastShot?.asset?.sha256===confirmed[0].sha256&&last-confirmed[0].toFrame>=fps*.45&&widestReturn(lastShot,project.profile,last);
  const returned=hasLocal&&(
    steps.some(s=>s.stage==='verification'&&s.fullView&&s.frame>confirmed[0].frame&&s.sha256===confirmed[0].sha256)||
    (laterCut||widerCamera)&&visibleReturn
  );
  const distinct=confirmed.filter((step,i)=>!confirmed.slice(0,i).some(old=>similarEvidence(old,step)));
  evidence.confirmedSteps=confirmed.map(s=>s.stepId);evidence.distinctFocusedRegions=distinct.length;evidence.returnToOriginal=!!returned;
  if(requirements.editableEvidence&&!hasLocal) {
    const ambiguous=candidate||shapeAmbiguous||windows.some(w=>w.shot.clip.framing);
    findings.push(finding('required-located-visual',ambiguous?'unknown':'major',
      ambiguous?'已有强调或裁切，但原片位置、相关解说或实际成片中的可见指引仍待核。':'明确要求的可编辑局部强调没有出现在时间线上；字幕和普通标题无法定位原片细节。',
      '在实际原图或源帧选中要指出的部位，让可编辑标注随对应语句出现，再回看该段合成画面。',...(steps.length?[steps[0].fromFrame,steps[0].toFrame]:relevantRange(project,first,last))));
  }
  if(hasLocal&&requirements.styleFidelity){
    for(const off of evidence.steps.filter(s=>s.sourceVerified&&s.frameMatch?.visible&&s.relatedWords===false)){
      findings.push(finding('visual-words-'+off.frame,'unknown','“'+off.label+'”所标部位与同段字幕或旁白稿没有可核对的共同描述。','回看此段，核对台词与所指的原片部位。',off.fromFrame,off.toFrame));
    }
  }
  if(policy) {
    if(!photosOnly&&!evidence.motion.length)evidence.motion=await measureMotion(project,windows,ffmpeg,signal,videoPath);
    const miss=await motionReview(project,windows,evidence,policy,checks,hashFile);
    if(miss&&!findings.some(f=>f.id==='required-moving-footage'))findings.push(miss);
  }
  if(science&&requirements.styleFidelity) {
    let hasProgression=distinct.length>=2||hasLocal&&returned;
    if(!hasProgression&&!photosOnly&&checks.length){
      if(!evidence.motion.length)evidence.motion=await measureMotion(project,windows,ffmpeg,signal,videoPath);
      const sequence=evidence.witnessedShots||await filmedSequence(project,windows,checks,evidence.motion,hashFile);
      evidence.witnessedShots=sequence;
      let stageIndex=0;
      const order=['problem','mechanism','verification'];
      for(const shot of sequence)if(shot.stage===order[stageIndex])stageIndex++;
      hasProgression=stageIndex===order.length;
    }
    if(!hasProgression&&!(requirements.editableEvidence&&!hasLocal)) {
      // A flat sequence of stills with no evidence treatment is a known missing deliverable.
      // For genuine motion or an unfamiliar treatment, an independent viewing can resolve the uncertainty.
      findings.push(finding('required-science-execution',photosOnly&&!candidate&&!shapeAmbiguous?'major':'unknown',
        photosOnly?'科普基准要求解释可见机制；现有照片段落尚未验出逐步指认、局部对照或回到原图验证。':'尚需核对科普风格中的任务、机制与结果是否由对应画面承接。',
        '在原件上逐段标出可观察到的变化，或使用能说明机制的实拍及对照画面。',first,last));
    }
  }
  return {evidence,findings};
}
