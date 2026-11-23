import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs, promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {verifyCompositionPixels} from './verify-motion-pixels.mjs';

const {values:args}=parseArgs({options:{atlas:{type:'string'},flight:{type:'string'},out:{type:'string'},studio:{type:'string'}}});
if(!args.atlas||!args.flight||!args.out)throw Error('node verify-motion-composition.mjs --atlas <Atlas 基准 MP4> --flight <NASA 机智号首飞 MP4> --out <新目录> [--studio <apps/studio 目录>]');
const sourceDir=args.studio?path.resolve(args.studio):fileURLToPath(new URL('..',import.meta.url));
const {startStudio}=await import(pathToFileURL(path.join(sourceDir,'src/server.mjs')));
const {mediaTool}=await import(pathToFileURL(path.join(sourceDir,'src/media.mjs')));
const ffmpeg=await mediaTool('ffmpeg');
assert.ok(ffmpeg,'需要工作台 FFmpeg');
const exec=promisify(execFile);
const output=path.resolve(args.out);
await Promise.all([access(args.atlas),access(args.flight)]);
await mkdir(path.dirname(output),{recursive:true});
await mkdir(output,{mode:0o700}); // Retain every previous result, including failed baselines.
const evidence=path.join(output,'像素证据');
await mkdir(evidence);
const profile={width:960,height:540,fps:24};
const length=456;
const samples=[
  {id:'impact-title',start:0,duration:48,at:28,geometry:{x:.275,y:.125,width:.50,height:.23},props:{label:'两种技术现场',title:'动作如何成为证据',size:54}},
  {id:'source-label',start:48,duration:42,at:67,geometry:{x:.5,y:.80,width:.94,height:.045},props:{lab:'影像来源  ·  Atlas 试片 / NASA JPL 火星首飞'}},
  {id:'fragment-title',start:90,duration:48,at:122,geometry:{x:.29,y:.12,width:.51,height:.18},props:{title:'从现场，看到结构'}},
  {id:'comparison-guide',start:138,duration:54,at:167,geometry:{x:.5,y:.5,width:1,height:.72},props:{left:'Atlas · 搬运实拍',right:'机智号 · 火星实拍'}},
  {id:'process-rail',start:192,duration:64,at:235,geometry:{x:.5,y:.865,width:.91,height:.143},props:{a:'观察动作',b:'定位部件',c:'解释原理'},cues:[0,16,37]},
  {id:'staggered-explanation',start:256,duration:104,at:338,geometry:{x:.30,y:.355,width:.43,height:.32},props:{a:'先找到旋翼',b:'观察机身',c:'再看起飞结果',transparentBackground:false},cues:[0,24,60]},
];
const staggered=samples.at(-1);
const newPhrase='两层旋翼朝相反方向转';
const newCues=[0,45,60];
const filmFiles={};
const receipts={profile,frames:length,sources:[],http:[],samples,editedPhrase:newPhrase,cuesBefore:staggered.cues,cuesAfter:newCues};
const writeReceipt=()=>writeFile(path.join(evidence,'工程操作记录.json'),JSON.stringify(receipts,null,2));
async function hash(file){const h=createHash('sha256');for await(const c of createReadStream(file))h.update(c);return h.digest('hex');}
const pack=path.resolve(sourceDir,'../../user-packs/henry-video-styles/reproduction/technical-explainer');
const nativeIds=['impact-title','source-label','process-rail','staggered-explanation','fragment-title','comparison-guide'];
receipts.originalJsx=await Promise.all(nativeIds.map(async (id,index)=>{
  const file='mg-0'+(index+1)+'.jsx';
  return {id,file,sha256:await hash(path.join(pack,file))};
}));
receipts.program={};
for(const name of ['server.mjs','media.mjs','text-tracks.mjs','motion-jsx.generated.mjs']){
  const file=path.join(sourceDir,'src',name);
  try{receipts.program[name]=await hash(file);}catch(error){if(error.code!=='ENOENT')throw error;}
}
async function proxy(id,source,sourceStart){
  const file=path.join(evidence,id+'.mp4');
  await exec(ffmpeg,['-v','error','-nostdin','-ss',String(sourceStart),'-i',path.resolve(source),'-map','0:v:0','-an','-vf','fps=24,scale=960:540:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1','-frames:v',String(length),'-c:v','libx264','-crf','16','-preset','veryfast','-pix_fmt','yuv420p','-threads','2','-movflags','faststart',file]);
  receipts.sources.push({id,source:path.basename(source),sourceSha256:await hash(source),sourceStart,frames:length,sha256:await hash(file)});
  return file;
}
const atlas=await proxy('Atlas实验室',args.atlas,1);
const flight=await proxy('机智号火星首飞',args.flight,12);
const service=await startStudio({root:path.join(output,'工作台资料库')});
try{
  const origin=new URL(service.url).origin;
  const entry=await fetch(service.url,{redirect:'manual'});assert.equal(entry.status,303);
  const cookie=entry.headers.get('set-cookie').split(';')[0];
  async function api(route,body){
    const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{cookie,origin,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();if(!response.ok)throw Error(route+': '+(data.error||response.status));return data;
  }
  async function saveVideo(route,name){
    const response=await fetch(origin+route,{headers:{cookie,origin}});
    if(!response.ok)throw Error(route+': '+response.status);
    const file=path.join(output,name);await writeFile(file,Buffer.from(await response.arrayBuffer()));
    receipts.http.push({file:name,route,sha256:await hash(file)});return file;
  }
  const project=await api('/api/projects',{mode:'script',title:'两种技术现场 · 原版动效与分屏',profile,settings:{voiceMode:'original',musicMode:'none',cloudEnabled:false}});
  const route='/api/projects/'+project.id;receipts.projectId=project.id;
  async function upload(file){
    const response=await fetch(origin+route+'/assets',{method:'POST',headers:{cookie,origin,'x-file-name':encodeURIComponent(path.basename(file)),'content-type':'application/octet-stream'},body:createReadStream(file),duplex:'half'});
    const data=await response.json();if(!response.ok)throw Error(data.error);return data;
  }
  async function edits(commands,description){
    const current=await api(route);
    const value=await api(route+'/edits',{baseRevision:current.revision,commands});
    receipts.http.push({description,revision:value.revision,commands});return value;
  }
  const add=clip=>({op:'add',clip});
  async function job(kind,name){
    const {revision}=await api(route);
    let j=await api(route+'/jobs',{kind,baseRevision:revision});
    const until=Date.now()+12*60*1000;
    while(!['done','failed','paused'].includes(j.status)&&Date.now()<until){await delay(350);j=await api('/api/jobs/'+j.id);}
    assert.equal(j.status,'done',j.error||JSON.stringify(j.events?.at(-1)));
    receipts.http.push({kind,revision,jobId:j.id,workbenchReview:j.qa?.label});
    return {id:j.id,file:await saveVideo('/api/jobs/'+j.id+'/file/video',name)};
  }
  async function draft(fromFrame,name){
    const d=await api(route+'/draft',{fromFrame});receipts.http.push({draft:name,fromFrame:d.fromFrame,toFrame:d.toFrame,revision:d.revision});
    return {file:await saveVideo(d.url,name),from:d.fromFrame,to:d.toFrame};
  }
  const left=await upload(atlas),right=await upload(flight);
  const videos=[left,right].map((a,i)=>({id:i?'flight-right':'atlas-left',track:'video',assetId:a.id,start:0,duration:length,sourceIn:0,fit:'contain',muted:true,viewport:{x:i*.5,y:0,width:.5,height:1}}));
  await edits(videos.map(add),'独立的两个视频视口');
  filmFiles.plate=(await job('preview','01 实拍分屏底片.mp4')).file;
  const jsx=samples.map(s=>({id:s.id,track:'graphic',text:'',start:s.start,duration:s.duration,geometry:s.geometry,motion:{componentId:s.id,version:1,props:s.props,...(s.cues&&{cueFrames:s.cues})}}));
  const section={start:360,duration:length-360,track:'graphic',text:''};
  const points=[[.02,.41],[.37,.39],[.5,.43],[.61,.51],[.97,.5],[.99,.59],[.63,.61],[.5,.57],[.39,.49],[.03,.5]];
  const rotors=[];
  for(const [i,label] of ['上层旋翼','下层旋翼'].entries()){
    const x=i?.74:.26,sign=i?1:-1;
    rotors.push({...section,id:'back'+i,shape:'polygon',geometry:{x,y:.5,width:.46,height:.78,points:[[0,0],[1,0],[1,1],[0,1]]},style:{color:'#071722'}});
    rotors.push({...section,id:'rotor'+i,shape:'polygon',geometry:{x,y:.50,width:.26,height:.20,points},style:{color:'#FFFFFF'},keyframes:Array.from({length:8},(_,k)=>({frame:k*12,rotation:k*20.4*sign}))});
    rotors.push({...section,id:'title'+i,text:label+' · 俯视示意',geometry:{x,y:.18},style:{fontSize:23,color:i?'#FFD15A':'#48E1D1'}});
  }
  await edits([...jsx,...rotors].map(add),'六个可编辑组件与双旋翼');
  const previewStart=staggered.start-8;
  filmFiles.before=await draft(previewStart,'02 三步跟随 · 改字前.mp4');
  const second=jsx.at(-1);
  const wordMotion={...second.motion,props:{...second.motion.props,b:newPhrase}};
  await edits([{op:'update',id:second.id,changes:{motion:wordMotion}}],'只改第二句文字');
  filmFiles.words=await draft(previewStart,'03 三步跟随 · 只改第二句.mp4');
  const final=await edits([{op:'update',id:second.id,changes:{motion:{...wordMotion,cueFrames:newCues}}}],'把第二句出现点从片段内 24 帧拖到 45 帧');
  filmFiles.draft=await draft(previewStart,'04 三步跟随 · 延迟后草稿.mp4');
  const render=await job('render','工作台动效与合成.mp4');
  filmFiles.full=render.file;
  receipts.finalRevision=final.revision;
  receipts.finalSha256=await hash(render.file);
  const manifest=path.join(output,'工作台资料库','projects',project.id,'outputs',render.id,'工程','project.vstudio.json');
  const exported=JSON.parse(await readFile(manifest,'utf8'));
  assert.deepEqual(exported.timeline.clips.find(c=>c.id===staggered.id).motion,{...wordMotion,cueFrames:newCues});
  receipts.portableProject=path.relative(output,manifest);
  assert.equal(exported.timeline.clips.filter(c=>c.motion).length,6);
  const files={...filmFiles,atlas,flight};
  await writeReceipt();
  const results=await verifyCompositionPixels({files,evidence,ffmpeg,profile,samples,newCues,staggered});
  const qa=await api('/api/jobs/'+render.id+'/file/review');
  const parity=qa.evidence?.compositeParity??null;
  const selected=new Set(parity?.checks?.map(check=>check.clipId));
  const expected=[...nativeIds,...videos.map(c=>c.id),'rotor0','rotor1'];
  results.checks.push({name:'正式工作台按当前版本和图层记录预览与导出的对照',
    pass:Boolean(parity&&parity.revision===final.revision&&parity.requested<=12&&
      parity.checks.length===parity.requested&&parity.checks.every(row=>Number.isInteger(row.frame)&&row.matches===true)&&expected.every(id=>selected.has(id))),
    measurements:{requested:parity?.requested??0,selected:[...selected],revision:parity?.revision,projectRevision:final.revision}});
  await writeFile(path.join(evidence,'工作台预览导出抽检.json'),JSON.stringify({parity,issues:qa.issues?.filter(row=>row.id?.startsWith('composite-parity'))},null,2));
  const report={...results,projectId:project.id,revision:final.revision,sha256:receipts.finalSha256,project:receipts.portableProject};
  await writeFile(path.join(output,'验收结果.json'),JSON.stringify(report,null,2));
  const pass=report.checks.filter(c=>c.pass).length;
  const notes=[
    '# 工作台动效与合成验收','',
    '19 秒，960×540，24 fps。左窗取 Atlas 科普基准片，右窗取 NASA 机智号首飞。同一工程先改第二行文字，再移动它的出现点，最后把窗口草稿与正式成片按工程帧号对齐。此样片按静音技术演示制作。','',
    '成片像素检查通过 '+pass+' / '+report.checks.length+' 项。[播放正式成片](工作台动效与合成.mp4) · [打开可编辑工程]('+receipts.portableProject+')','',
    '| 播放区间 | 观看内容 |','|---|---|',
    '| 0–5.75 秒 | 两份录像同时呈现，依次叠加动词强调、实验来源、纵条聚字。 |',
    '| 5.75–10.67 秒 | 两个栏目和中线指向各自的素材，接着依次点亮三张路径卡。 |',
    '| 10.67–15 秒 | 三步跟随的第二行出现点由片段内 24 帧移至 45 帧，第三行保持在 60 帧。 |',
    '| 15–19 秒 | 同一轮廓绕各自中心转动。上桨每 12 帧逆时针 20.4°，下桨顺时针 20.4°。 |','',
    '取自正式导出的画面见[六个组件](像素证据/六个原版组件.jpg)、[第二句改动的四个状态](像素证据/三步跟随的四个实拍状态.jpg)和[双桨四个时刻](像素证据/两层旋翼的相反转动.jpg)。第二句对照图依次为原句、改字、同一时刻延迟后、晚到后新句出现。','',
    '两窗分别与独立解码的两份来源做同帧交叉对照。白桨的角度由成片中的明亮轮廓实测。预览与导出均为有损编码，通过同帧内容与局部像素误差复核。[逐项检查](验收结果.json) · [工程修改、源文件与程序指纹](像素证据/工程操作记录.json)','',
    '成片 SHA-256 为 `'+receipts.finalSha256+'`。','',
    ...report.checks.filter(c=>!c.pass).map(c=>'未通过：'+c.name+'。'),
  ];
  await writeFile(path.join(output,'验收说明.md'),notes.join('\n')+'\n');
  console.log(JSON.stringify({file:filmFiles.full,project:manifest,result:report.checks.map(c=>[c.name,c.pass])},null,2));
  if(report.checks.some(c=>!c.pass))process.exitCode=1;
}finally{
  await writeReceipt();await service.close();
}
