import {access,copyFile,readFile,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {footage,captionHash,styleSubjects} from './review-sources.mjs';
import {createStyleLibrary,fileSha256} from '../src/style.mjs';
import {reviewProject,readSrt} from '../src/review.mjs';
import {createBlindReview} from '../src/blind-review.mjs';

const [rootArg,scope='all',srcArg]=process.argv.slice(2);
if(!rootArg||!['all','sources','style','gate','pair'].includes(scope)) throw Error('使用 node build-review-library.mjs <独立评测库> [sources|gate|style|pair|all] [工作台src目录]');
const root=path.resolve(rootArg),src=path.resolve(srcArg||fileURLToPath(new URL('../src/',import.meta.url)));
const load=s=>import(pathToFileURL(path.join(src,s)).href);
const media=await load('media.mjs'), audio=await load('audio.mjs'),{createStore}=await load('project.mjs');
const {portableProject}=await load('library.mjs'),exec=promisify(execFile);
const inputs=path.join(root,'research-sources'),records=path.join(root,'research-plan'),voiceDir=path.join(inputs,'voices');
await mkdir(voiceDir,{recursive:true});await mkdir(records,{recursive:true});
const stateFile=path.join(records,'library-state.json');
const optional=async file=>readFile(file,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const state=await optional(stateFile)||{protocol:1,samples:{},studies:{}};
async function persist(){await writeFile(stateFile+'.tmp',JSON.stringify(state,null,2));await rename(stateFile+'.tmp',stateFile);}
const checksum=t=>createHash('sha256').update(t).digest('hex');
const store=createStore(root,{probeMedia:media.probeMedia}),library=createStyleLibrary(root),blind=createBlindReview(root);
const fps=25,profile={width:640,height:360,fps},rights='NASA educational media; credit NASA and named mission/team; https://www.nasa.gov/nasa-brand-center/images-and-media/';
const person='iss061m2627771232_Live_Interviews_Jeanette_Epps_191004';
function remote(id,suffix){const e=encodeURIComponent(id);return 'https://images-assets.nasa.gov/video/'+e+'/'+e+suffix;}
async function acquire(name,url,hash) {
  const out=path.join(inputs,name);
  try{await access(out);}catch{
    const response=await fetch(url,{signal:AbortSignal.timeout(180000)});
    if(!response.ok)throw Error('官方源返回 '+response.status+' '+name);
    const tmp=out+'.'+randomUUID()+'.tmp';
    try {await pipeline(response.body,createWriteStream(tmp,{flags:'wx'}));if(await fileSha256(tmp)!==hash)throw Error('源指纹不一致 '+name);await rename(tmp,out);}
    finally{await rm(tmp,{force:true});}
  }
  if(await fileSha256(out)!==hash) throw Error('缓存的源文件已变化 '+name);
}
async function sources() {
  const credits=['# 看片研究的来源与使用条件','','所有原片均下载自 NASA Images & Video Library。这里用于本地教学与剪辑评测。素材原声、文案和额外配音的来源分别记录在工程。','[NASA 媒体使用说明](https://www.nasa.gov/nasa-brand-center/images-and-media/)','','| 文件 | 官方记录 | SHA-256 |','|---|---|---|'];
  for(const [key,[id,hash]] of Object.entries(footage)){
    await acquire(key+'.mp4',remote(id,'~mobile.mp4'),hash);
    credits.push('| '+key+'.mp4 | [NASA / '+id+'](https://images.nasa.gov/details/'+encodeURIComponent(id)+') | '+hash+' |');
  }
  await acquire('interview.srt',remote(person,'.srt'),captionHash);
  credits.push('','访谈使用 NASA 宇航员 Jeanette Epps 在 2019 年 10 月 4 日采访中的真实同期声和 NASA 配套英文字幕。其他场景中文旁白由系统语音 Tingting 生成。');
  await writeFile(path.join(root,'资料来源.md'),credits.join('\n')+'\n');
}
function clip(track,start,duration,attrs={}) {return {id:randomUUID(),track,start,duration,sourceIn:0,speed:1,gain:1,locked:false,...attrs};}
async function assetFor(p,key) {
  const [id]=footage[key];
  return store.addAsset(p.id,path.join(inputs,key+'.mp4'),{name:key+'.mp4',url:'https://images.nasa.gov/details/'+encodeURIComponent(id),credit:'NASA',rights});
}
async function voiceFor(p,text) {
  const file=path.join(voiceDir,checksum(text).slice(0,20)+'.wav');
  try{await access(file);}catch{await audio.synthesize(text,{mode:'system',voice:'Tingting',output:file});}
  return store.addAsset(p.id,file,{name:'研究旁白.wav',role:'narration',provider:'macOS say',voiceId:'Tingting',referenceHash:null});
}
async function finalize(p,base,k,condition,defect) {
  const id=randomUUID(),outDir=path.join(store.paths(p.id).outputs,id),video=path.join(outDir,'video.mp4');
  await mkdir(outDir,{recursive:true});
  const result=await media.renderProject(p,{directory:outDir,output:video});
  if(['trim','mute','drop'].includes(defect)) {
    const tmp=path.join(outDir,'injected.mp4');
    const expected=result.duration;
    const filter=defect==='mute'?'volume=0':"volume=0:enable='between(t,0.3,3.9)'";
    const args=['-nostdin','-v','error','-y','-i',video,'-map','0:v:0','-map','0:a:0?'];
    if(defect==='trim')args.push('-t',String(Math.max(1,Math.min(expected*.42,2.2))),'-c:v','libx264','-preset','veryfast','-c:a','aac');
    else args.push('-c:v','copy','-af',filter,'-c:a','aac');
    await exec(await media.mediaTool('ffmpeg'),[...args,tmp]);await rename(tmp,video);
  }
  const qa=await reviewProject(p,{videoPath:video,srtPath:result.srtPath,resolveTool:media.mediaTool});
  const reviewFile=path.join(outDir,'review.json');await writeFile(reviewFile,JSON.stringify(qa,null,2));
  const manifest=await portableProject(p,path.join(outDir,'工程'));store.snapshot(p);
  const stamp=new Date().toISOString();
  store.saveJob({id,projectId:p.id,kind:'render',status:'done',phase:'done',revision:p.revision,qa,createdAt:stamp,updatedAt:stamp,progress:1,repairs:0,files:{video,subtitle:result.srtPath,project:manifest,review:reviewFile},events:[{at:stamp,message:'独立评测样本已冻结'}]});
  const row={group:base,projectId:p.id,jobId:id,videoPath:video,hash:qa.artifactSha256,mode:p.mode,fps:p.profile.fps,systemStatus:qa.status,systemIssues:qa.issues,condition,defect:defect||null};
  state.samples[k]=row;await persist();console.log('冻结',k,qa.status);
  return row;
}
async function styleSample(slug,styleId,run,author) {
  const subj=styleSubjects[slug],front=author==='foreground',key=[front?'front':'style',slug,styleId,run].join('-');
  if(state.samples[key]) return state.samples[key];
  const from=path.join(records,'treatments', [slug,styleId,run].join('-')+'.json');
  const direction=await optional(from);
  if(!direction) throw Error('缺少独立 Codex 回合 '+path.basename(from));
  let decision=direction.decision;
  if(front) {
    const humanFacing=await optional(path.join(records,'foreground.json'));decision=humanFacing?.[slug];
    if(!decision) throw Error('缺少该题已记录的前台 Codex 决定');
  }
  const style=await library.get(styleId),voice=subj.narration,first=Math.round(subj.start*fps),anchorSourceFrame=Math.round(subj.anchor*fps);
  let p=store.create({title:'研究 '+slug+' '+style.name+' '+run+(front?'（前台）':''),mode:'script',brief:subj.description,script:voice,profile,style:{id:style.id,version:style.version},settings:{voiceMode:'system',requireCaptions:true,engine:'local'}});
  const [source,speech]=await Promise.all([assetFor(p,slug),voiceFor(p,voice)]);
  const duration=10*fps, actionFrame=anchorSourceFrame-first;
  const n=Math.min(duration,Math.max(1,Math.round(speech.duration*fps)));
  const rows=[clip('video',0,duration,{assetId:source.id,sourceIn:first,gain:0}),clip('narration',0,n,{assetId:speech.id}),clip('caption',0,n,{text:voice}),
    ...library.compileScene({style,start:0,duration,actionFrame,anchorAssetId:source.id,anchorSourceFrame,text:decision.text,followup:decision.followup,continuity:decision.continuity,subject:subj.subject},profile)];
  p=store.get(p.id);p=store.apply(p.id,p.revision,rows.map(clip=>({op:'add',clip})),'user');
  return finalize(p,front?'pair':'style',key,{style:styleId,topic:slug,run,origin:front?'Codex desktop conversation':'Studio Codex App Server',model:direction.model,effort:direction.effort,promptHash:direction.promptHash,imageHash:direction.imageHash,inputHash:source.sha256,voiceHash:speech.sha256},null);
}
const fixed={
 topic:{asset:'lift',windows:[98,124,217,239,319,445],lines:['夜色里，塔架上的灯光勾出了金属结构的轮廓。','沿着塔身往上看，灯光照亮的是一层层工作平台。','镜头靠近底部。亮着灯的地方能看到运输设备的轮廓。','站在设备旁边，工作人员和巨大的履带形成了对比。','看地面附近，灯光照出了从车旁向两侧散开的水柱。','天色渐亮，发射塔和箭体的轮廓变得清楚起来。']},
 script:{asset:'station',windows:[44,82,140,175,225,281],lines:['先看飞船的正面，圆形对接口朝向了镜头。','白色舱体与黑色背景分开，突出的舱盖可以辨认。','飞船前部的结构暴露在外，镜头正对着它。','从正面看，边缘比中央的圆形接口更亮。','随着视角改变，白色外壳上出现了更强的反光。','接口的近景中，先观察有光的边缘，再看暗部。']}
};
async function gate(mode,i,cues) {
  const key='gate-'+mode+'-'+i;if(state.samples[key])return state.samples[key];
  const interview=mode==='interview',config=fixed[mode],assetKey=interview?'interview':config.asset,text=interview?'':config.lines[i];
  let p=store.create({title:'交付判断样本 '+mode+' '+(i+1),mode,brief:interview?'从公开访谈中剪出一句完整问答':'用给定公开镜头解释可见事项',script:text,profile,settings:{voiceMode:interview?'original':'system',requireCaptions:true,engine:'local'},style:{id:'neutral',version:1}});
  const source=await assetFor(p,assetKey);let clips,defect=null;
  if(interview) {
    const spans=[[1,3],[4,9],[13,16],[17,19],[20,25],[26,33]], [a,b]=spans[i];
    const selected=cues.slice(a-1,b),from=Math.round(selected[0].from/1000*fps),to=Math.round(selected.at(-1).to/1000*fps);
    clips=[clip('video',0,to-from,{assetId:source.id,sourceIn:from,gain:i===4?0:1})];
    for(const cue of selected){ const s=Math.round(cue.from/1000*fps)-from,e=Math.round(cue.to/1000*fps)-from;if(e>s)clips.push(clip('caption',s,e-s,{text:cue.text.replace(/^>>\s*/,'')}));}
    if(i===4)defect='muted-original';if(i===5)defect='trim';
  }else{
    const speech=await voiceFor(p,text),speechFrames=Math.max(1,Math.ceil(speech.duration*fps)),length=speechFrames+Math.round(.4*fps);
    clips=[clip('video',0,length,{assetId:source.id,sourceIn:config.windows[i]*fps,gain:0}),clip('caption',0,speechFrames,{text})];
    if(mode==='topic'&&i===4)defect='missing-narration';
    else clips.push(clip('narration',0,speechFrames,{assetId:speech.id}));
    if(mode==='topic'&&i===5)defect='drop';
    if(mode==='script'&&i===4)defect='mute';
    if(mode==='script'&&i===5)defect='trim';
  }
  p=store.get(p.id);p=store.apply(p.id,p.revision,clips.map(clip=>({op:'add',clip})),'user');
  return finalize(p,'gate',key,{source:assetKey,control:i<4?'unmodified':'injected',sourceHash:source.sha256},defect);
}
async function study(kind,rows) {
  if(state.studies[kind])return;
  const titles={gate:'留出看片 · 三类入口',style:'风格辨认 · 三个新题材',pair:'场景编辑 · 前台与工作台'};
  const saved=await blind.create({kind,title:titles[kind],samples:rows});
  state.studies[kind]=saved;await persist();console.log('研究就绪',kind,rows.length);
}
try {
  await sources();
  if(scope==='all'||scope==='gate'){
    const cues=readSrt(await readFile(path.join(inputs,'interview.srt'),'utf8')),rows=[];
    for(const mode of ['topic','script','interview']) for(let i=0;i<6;i++) rows.push(await gate(mode,i,cues));
    await study('gate',rows);
  }
  if(scope==='all'||scope==='style'){
    const rows=[];
    for(const slug of Object.keys(styleSubjects)) for(const id of ['henry-hot-news','henry-technical-explainer'])for(const run of [1,2]){
      const sample=await styleSample(slug,id,run,'workbench');
      rows.push({...sample,expected:id==='henry-hot-news'?'热点资讯':'技术科普',topicGroup:slug});
    }
    await study('style',rows);
  }
  if(scope==='all'||scope==='pair'){
    const rows=[];
    for(const slug of ['flare','splash']){
      const work=await styleSample(slug,'henry-hot-news',1,'workbench');
      const front=await styleSample(slug,'henry-hot-news',1,'foreground');
      rows.push({...work,comparisonPath:front.videoPath,comparisonHash:front.hash,primary:'workbench',conditions:{...work.condition,notes:'同一公开素材、固定画面/旁白/模板、相同模型与推理档；配对范围为短场景的字句与衔接决定。'}});
    }
    await study('pair',rows);
  }
} finally {store.close();}
