import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {projectSourceRegion,validRegion} from './visual-steps.mjs';

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
  const style=/((?:严格|复现|复刻|遵循|照着|接近|忠实|贴近|对齐|依照|模仿|按).{0,16}(?:henry|基准片|科普风格|科普模板)|(?:henry|基准片).{0,12}(?:科普风格|同款|效果|复现|复刻|风格))/i.test(brief);
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
  const sides=[0,0,0,0];
  for(let n=1;n<=12;n++){const t=(n/13)*2-1;
    sides[0]+=near(center[0]+t*half[0],center[1]-half[1]);sides[1]+=near(center[0]+t*half[0],center[1]+half[1]);
    sides[2]+=near(center[0]-half[0],center[1]+t*half[1]);sides[3]+=near(center[0]+half[0],center[1]+t*half[1]);
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
  for(const label of graphics) {
    const a=label.evidenceAnchor;
    if(!a||!stageNames.has(a.stage)||!validRegion(a.region)||!a.stepId||!plain(label.text)||plain(a.label)!==plain(label.text)||generic(label.text)||plain(a.observation).length<3||generic(a.observation))continue;
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
      fromFrame:from,toFrame:end,frame:mid,localized:false,fullView:widestReturn(shot,profile,mid),sourceFile:shot.asset.path};
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

async function measureMotion(project,windows,ffmpeg,signal) {
  const records=[],fps=project.profile.fps;
  for(const {from,to,shot:{clip,asset}} of windows.filter(v=>v.shot.asset?.kind==='video').slice(0,6)) {
    if(!asset.path||to-from<fps*.35)continue;
    const d=to-from, at=(f)=>((clip.sourceIn||0)+(from-clip.start+f)*(clip.speed||1))/fps;
    const times=[.22,.47,.72].map(u=>at(d*u));
    try {
      const frames=[];for(const sec of times)frames.push(await decodePixels(ffmpeg,asset.path,sec,96,60,signal));
      const pair=[sceneChange(frames[0],frames[1],96,60),sceneChange(frames[1],frames[2],96,60)];
      records.push({assetId:asset.id,fromFrame:from,toFrame:to,sourceTimes:times,comparisons:pair,
        result:pair.every(p=>p.change<1.6)?'no-detectable-change':pair.every(p=>p.afterGlobalMotion<3.2)?'consistent-with-camera-movement':'changing-footage'});
    }catch(error){if(signal?.aborted)throw error;records.push({assetId:asset.id,fromFrame:from,toFrame:to,result:'unavailable'});}
  }
  return records;
}

function sharesSubject(step,project) {
  const nearby=(project.timeline.clips||[]).filter(c=>c.track==='caption'&&live(c)&&c.start<=step.toFrame&&lastFrame(c)>=step.fromFrame).map(c=>c.text);
  const claims=(project.facts||[]).filter(f=>f.assetId===step.assetId).map(f=>f.text||f.claim);
  const material=[...nearby,...claims].filter(Boolean).join(' ');
  if(!material.trim())return null;
  const segmenter=new Intl.Segmenter('zh',{granularity:'word'}),ignore=new Set(['因此','这个','画面','照片','这里','边上','先看','能看到','可以','因为','位置','看到','上面','下面','有点','the','this','that','with','look','shows','image']);
  const words=t=>new Set([...segmenter.segment(t.toLowerCase())].filter(x=>x.isWordLike&&[...x.segment].length>1&&!ignore.has(x.segment)).map(x=>x.segment));
  const vocabulary=words(material),description=words(step.label+' '+step.observation);
  if(vocabulary.size<3||description.size<2)return null;
  return [...description].some(w=>vocabulary.has(w)||w.length>2&&material.includes(w));
}

function usesScienceGrammar(project,styleSpec) {
  const spec=styleSpec||project.style||{}, declared=spec.executionPlan?.template||project.visualDirection?.executionPlan?.template||project.visualDirection?.template;
  if(declared)return declared==='step-reveal';
  const templates=spec.templates||spec.templateIds;
  if(Array.isArray(templates))return templates.some(t=>(typeof t==='string'?t:t.id)==='step-reveal');
  return project.timeline.clips.some(c=>c.template==='step-reveal')||spec.id==='henry-technical-explainer';
}
function relevantRange(project,first,last) {
  const cue=project.timeline.clips.find(c=>live(c)&&c.track==='graphic'&&/(?:留意|看这里|看此处|注意看|请看|观察|注意到|look here|notice|watch the)/i.test(c.text||''));
  return cue?[cue.start,lastFrame(cue)]:[first,last];
}

export async function reviewVisualEvidence(project,{videoPath,ffmpeg,signal,styleSpec,hashFile}) {
  const requirements=visualRequirements(project),findings=[];
  const science=usesScienceGrammar(project,styleSpec);
  const assets=new Map(project.assets.map(a=>[a.id,a])),shots=project.timeline.clips.filter(c=>c.track==='video'&&live(c)).sort((a,b)=>a.start-b.start).map(clip=>({clip,asset:assets.get(clip.assetId)}));
  const windows=visibleWindows(shots),first=windows[0]?.from??0,last=windows.at(-1)?.to??0;
  const evidence={requirements,sourceWindows:windows.map(w=>({assetId:w.shot.clip.assetId,kind:w.shot.asset?.kind||'unknown',fromFrame:w.from,toFrame:w.to})),steps:[],motion:[]};
  if(!windows.length||!Object.values(requirements).some(Boolean)) return {evidence,findings};
  const photosOnly=windows.every(w=>w.shot.asset?.kind==='image');
  if(requirements.motionFootage) {
    if(photosOnly)findings.push(finding('required-moving-footage','major','本期明确要求运动实拍，画面全由照片组成。','加入能显示所述过程的实拍窗口，或由用户更改该素材要求。',first,last));
    else {
      evidence.motion=await measureMotion(project,windows,ffmpeg,signal);
      if(!evidence.motion.some(m=>m.result==='changing-footage'))findings.push(finding('required-moving-footage','unknown','抽取的原片窗口不能确认有超出整幅平移、缩放或定格的过程。','回看标出的原片，选真实运动区间或确认当前处理。',first,last));
    }
  }
  if(!requirements.editableEvidence&&!requirements.styleFidelity)return {evidence,findings};
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
  if(science&&requirements.styleFidelity) {
    const hasProgression=distinct.length>=2||hasLocal&&returned;
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
