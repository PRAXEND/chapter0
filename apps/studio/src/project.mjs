import {publicationFields,portraitLayout,portraitTitleProblem} from './presentation.mjs';
import {requestedDurationRange,validateDuration} from './duration.mjs';
import {validatePictureEffects} from './news-effects.mjs';
import {timelineCommands,validateSampleWindow} from './clip-edit.mjs';
import {createEditHistory} from './edit-history.mjs';
import {isDeepStrictEqual} from 'node:util';
import {syncMotionSounds} from './motion-sound-binding.mjs';
import {validateSoundDesign} from './style-sounds.mjs';
import {dedicatedVoiceReference,henryV8,audioSelection} from './style-audio.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { copyFile, link, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {validFraming} from './framing.mjs';
import {polygonPath} from './polygon.mjs';
import {validateMotionClip} from './motion-components.mjs';
import {viewportRect,overlapOnStage} from './viewport.mjs';

export const defaultRoot = () => process.env.STUDIO_DATA_ROOT || path.join(os.homedir(),'Library','Application Support','Video Studio','standalone');
export const tracks = ['video','narration','music','caption','graphic'];
export function fault(message, status = 422) { return Object.assign(new Error(message), {status}); }
const now = () => new Date().toISOString();
const idPattern = /^[\w.-]{1,100}$/;
const copy = value => structuredClone(value);
const text = (s, max = 10000) => String(s ?? '').slice(0,max);
const conflicts = () => fault('工程已有新版本，请查看最新时间线后重试。',409);
const spans = (a,b) => a.start < b.start+b.duration && b.start < a.start+a.duration;
function checkId(id) {
  if (typeof id !== 'string' || !idPattern.test(id) || id==='.' || id==='..') throw fault('编号无效。');
  return id;
}
function profileOf(p = {}) {
  const {width=1920,height=1080,fps=30}=p;
  if (![width,height].every(n=>Number.isInteger(n)&&n>=16&&n<=8192&&n%2===0) || !Number.isInteger(fps)||fps<1||fps>60) throw fault('画幅或帧率无效。');
  return {width,height,fps};
}
export function validateClip(clip,p) {
  checkId(clip.id);
  if (!tracks.includes(clip.track)) throw fault('未知轨道。');
  for(const key of ['start','duration']) {
    const value=clip[key];
    if(!Number.isSafeInteger(value)||value < (key==='duration'?1:0)) throw fault('剪辑位置和长度必须使用有效的整数帧。');
  }
  if(!Number.isFinite(clip.sourceIn??0)||(clip.sourceIn??0)<0)throw fault('原片入点须为非负的有效帧位置。');
  validateSampleWindow(clip,p);
  if(clip.start+clip.duration>p.profile.fps*86400)throw fault('时间线超出一天。');
  const speed=clip.speed??1, gain=clip.gain??1;
  if(!Number.isFinite(speed)||speed<0.125||speed>8||!Number.isFinite(gain)||gain<0||gain>16)throw fault('速率或音量无效。');
  if(['video','music','narration'].includes(clip.track)) {
    const a=p.assets.find(x=>x.id===clip.assetId);
    if(!a || (clip.track==='video' ? !['image','video'].includes(a.kind) : a.kind==='image'||a.hasAudio===false)) throw fault('轨道与所选素材不匹配。');
    if(a.kind!=='image' && (clip.sourceIn??0)+clip.duration*speed>Math.ceil(a.duration*p.profile.fps)+1) throw fault('剪辑超出原片的可用窗口。');
  } else if (!clip.motion && (typeof clip.text!=='string'||clip.text.length>4000)) throw fault('文字图层内容无效。');
  if(clip.pictureEffects!=null){try{validatePictureEffects(clip.pictureEffects,clip);}catch(e){throw fault(e.message);}}
  if(clip.soundDesign!=null){try{validateSoundDesign(clip.soundDesign,p);}catch(e){throw fault(e.message);}}
  if(clip.motion!=null) validateMotionClip(clip,p.profile);
  if(clip.geometry)for(const key of ['x','y','width','height'])if(clip.geometry[key]!=null&&!Number.isFinite(clip.geometry[key]))throw fault('图层坐标无效。');
  if(clip.framing!=null && (clip.track!=='video' || !validFraming(clip.framing)))throw fault('画面取景中心须在原素材内，放大倍率须为 1–4。');
  if (clip.viewport != null) {
    if (clip.track !== 'video') throw fault('只有视频轨道使用分屏窗口。');
    try { viewportRect(clip.viewport, p.profile); } catch (error) { throw fault(error.message); }
  }
  if(clip.shape==='outline' && (clip.track!=='graphic' || clip.text || !['width','height'].every(k=>clip.geometry?.[k]>0 && clip.geometry[k]<=2)))throw fault('指示框需要空文字与有效尺寸。');
  if(clip.shape==='polygon'){
    if(clip.track!=='graphic'||clip.text||!['width','height'].every(k=>clip.geometry?.[k]>0&&clip.geometry[k]<=2))throw fault('矢量轮廓需要空文字与有效宽高。');
    try{polygonPath(clip.geometry.points,Math.round(p.profile.width*clip.geometry.width),Math.round(p.profile.height*clip.geometry.height));}catch(error){throw fault(error.message);}
  }
  if(clip.keyframes && (!Array.isArray(clip.keyframes)||clip.keyframes.some(k=>!Number.isInteger(k?.frame)||k.frame<0||k.frame>clip.duration)))throw fault('关键帧须位于图层范围内。');
  if (clip.keyframes?.some(k => 'rotation' in k && !Number.isFinite(k.rotation))) throw fault('旋转角度必须为有限度数。');
  if(clip.stackOrigin){
    checkId(clip.stackOrigin.id);
    if(!Number.isSafeInteger(clip.stackOrigin.offsetFrames)||clip.stackOrigin.offsetFrames<0||clip.stackOrigin.offsetFrames>p.profile.fps*86400)throw fault('片段分割时钟无效。');
  }
}
function newSettings(mode, supplied={},style) {
  const s={voiceMode:mode==='interview'?'original':'system',shareFrames:false,shareTranscript:true,cloudEnabled:false,cloudBudget:0,publishPackage:false,...supplied};
  if(s.captionDisplay!=null&&!['burned-in','sidecar'].includes(s.captionDisplay))throw fault('字幕显示方式无效。');
  if(henryV8(style))s.requireCaptions=true;
  try {validateDuration(s);} catch(error){throw fault(error.message);}
  if(s.finalReviewMaxTurns!=null && ![0,1].includes(s.finalReviewMaxTurns))throw fault('独立终审次数可选 0 或 1。');
  if(s.confirmSequence!=null&&typeof s.confirmSequence!=='boolean')throw fault('审稿方式无效。');
  if(henryV8(style) && mode!=='interview' && audioSelection({mode,settings:s},'voice')==='style'){
    s.voiceMode='preset';s.presetVoice='dylan';s.voiceSelection='style';
  }
  if(s.sceneSound!=null&&typeof s.sceneSound!=='boolean')throw fault('本期动作音效开关无效。');
  if(s.autoReview!==undefined && typeof s.autoReview!=='boolean')throw fault('自动回看设置无效。');
  if(s.sourceScope!==undefined && !['project','search'].includes(s.sourceScope))throw fault('素材范围无效。');
  if(!['system','clone','preset','original','import'].includes(s.voiceMode))throw fault('声音方式无效。');
  if(s.voiceMode==='preset'&&s.presetVoice!=null&&!/^[a-z0-9_-]{1,45}$/.test(s.presetVoice))throw fault('本地预置声音名称无效。');
  for(const key of ['voiceSelection','musicSelection'])if(s[key]!=null&&!['style','user','preview'].includes(s[key]))throw fault('声音偏好来源无效。');
  if(typeof s.shareFrames!=='boolean'||typeof s.shareTranscript!=='boolean'||typeof s.cloudEnabled!=='boolean'||!Number.isFinite(s.cloudBudget)||s.cloudBudget<0)throw fault('隐私或费用设置无效。');
  for(const field of ['voiceReferenceAssetId','narrationAssetId','musicAssetId'])if(s[field])checkId(s[field]);
  return s;
}
const sortClips=clips=>clips.sort((a,b)=>a.start-b.start||tracks.indexOf(a.track)-tracks.indexOf(b.track)||a.id.localeCompare(b.id));
export function createStore(root=defaultRoot(),{probeMedia}={}) {
  root=path.resolve(root);
  mkdirSync(root,{recursive:true,mode:0o700});
  const db=new DatabaseSync(path.join(root,'studio.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history (project TEXT, revision INTEGER, body TEXT NOT NULL, PRIMARY KEY(project,revision));
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS project_jobs ON jobs(project);`);
  const journal=createEditHistory(db,{revision,validateClip,sortClips});
  function paths(id) {
    const directory=path.join(root,'projects',checkId(id));
    return {directory,assets:path.join(directory,'assets'),cache:path.join(directory,'cache'),outputs:path.join(directory,'outputs')};
  }
  function get(id) {
    const row=db.prepare('SELECT body FROM projects WHERE id=?').get(checkId(id));
    if(!row)throw fault('找不到该工程。',404);
    return JSON.parse(row.body);
  }
  function transaction(f,reading=false) {
    db.exec(reading?'BEGIN':'BEGIN IMMEDIATE');
    try{const v=f();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}
  }
  function persist(p,versioned) {
    const body=JSON.stringify(p);
    if(versioned)db.prepare('INSERT INTO history VALUES(?,?,?)').run(p.id,p.revision,body);
    db.prepare('INSERT OR REPLACE INTO projects VALUES(?,?)').run(p.id,body);
    return p;
  }
  function mutate(id,base,fn,versioned=true) {
    return transaction(()=>{
      const p=get(id);
      if(base!==undefined && p.revision!==base)throw conflicts();
      if(fn(p)===false)return p;
      if(versioned)p.revision++;
      p.updatedAt=now();
      return persist(p,versioned);
    });
  }
  function create(data={}) {
    if(!['topic','script','interview'].includes(data.mode))throw fault('请选择一个制作入口。');
    const id=randomUUID(), dirs=paths(id);
    for(const dir of Object.values(dirs))mkdirSync(dir,{recursive:true,mode:0o700});
    const p={schema:1,id,title:text(data.title||'未命名工程',160),mode:data.mode,brief:text(data.brief),script:text(data.script,160000),
      profile:profileOf(data.profile), settings:newSettings(data.mode,{autoReview:true,...requestedDurationRange(data.brief),...data.settings},data.style),style:data.style||{id:'neutral',version:1},
      revision:1,assets:[],timeline:{clips:[]},createdAt:now(),updatedAt:now()};
    return transaction(()=>persist(p,true));
  }
  async function addAsset(id,file,source={}) {
    get(id);
    const info=await stat(file);
    if(!info.isFile()||!info.size)throw fault('素材文件为空或不可读取。');
    const dirs=paths(id), temp=path.join(dirs.assets,'.incoming-'+randomUUID()+path.extname(file));
    await copyFile(file,temp,constants.COPYFILE_FICLONE);
    try {
      const hash=createHash('sha256'); for await(const block of createReadStream(temp))hash.update(block);
      const sha256=hash.digest('hex');
      const already=get(id).assets.find(a=>a.sha256===sha256); if(already)return already;
      const probe=await probeMedia(temp);
      const ext=path.extname(file).toLowerCase().replace(/[^a-z0-9.]/g,'').slice(0,10);
      const target=path.join(dirs.assets,sha256+ext);
      try{await link(temp,target);}catch(error){if(error.code!=='EEXIST')throw error;}
      const asset={...probe,id:randomUUID(),name:text(source.name||path.basename(file),250),path:target,sha256,size:info.size,source,createdAt:now()};
      if(!['video','audio','image'].includes(asset.kind))throw fault('文件中没有可用的音视频流。');
      return mutate(id,undefined,p=>{
        if(p.assets.some(a=>a.sha256===sha256))return false;
        p.assets.push(asset);
      }).assets.find(a=>a.sha256===sha256);
    }finally{await unlink(temp).catch(()=>{});}
  }
  function apply(id,baseRevision,commands,actor='user',sceneMeta) {
    if(!Number.isInteger(baseRevision)||!Array.isArray(commands)||!commands.length||commands.length>10000)throw fault('请提供起始版本和剪辑指令。');
    return mutate(id,baseRevision,p=>{
      const clips=p.timeline.clips, before=copy(clips), expanded=[], direct=new Set(commands);
      for(const cmd of timelineCommands(commands,p)){
        if(!cmd||typeof cmd!=='object')throw fault('剪辑指令无效。');
        expanded.push(cmd);
        const found=clips.findIndex(c=>c.id===(cmd.id??cmd.clip?.id));
        const before=clips[found];
        if(cmd.op==='lock'){
          if(actor!=='user'||!before||typeof cmd.locked!=='boolean')throw fault('只有用户可以锁定或解锁已有片段。',409);
          before.locked=cmd.locked;continue;
        }
        if(cmd.op==='add'&&before)throw fault('片段编号已存在。',409);
        if(cmd.op!=='add'&&!before)throw fault('片段已改变，请重新读取工程。',409);
        if(before?.locked)throw fault('该片段已锁定。',409);
        if(cmd.op==='remove'){clips.splice(found,1);continue;}
        if(!['add','update'].includes(cmd.op))throw fault('未知剪辑指令。');
        if(cmd.op==='update'&&(!cmd.changes||typeof cmd.changes!=='object'||Array.isArray(cmd.changes)))throw fault('请提供要修改的片段属性。');
        if(cmd.op==='update'&&(cmd.changes?.id!==undefined||cmd.changes?.locked!==undefined))throw fault('编号和锁定状态须单独修改。');
        const candidate=cmd.op==='add'?{...copy(cmd.clip),locked:false}:{...before,...copy(cmd.changes)};
        if(before?.sampleWindow && cmd.op==='update' && !Object.hasOwn(cmd.changes,'sampleWindow') &&
          (['assetId','sourceIn','speed'].some(k=>before[k]!==candidate[k]) || before.sampleWindow.offsetFrames+candidate.duration>before.sampleWindow.durationFrames))
          delete candidate.sampleWindow;
        if(candidate.muted!==before?.muted&&candidate.muted!==undefined&&typeof candidate.muted!=='boolean')throw fault('静音状态须为开或关。');
        if(candidate.fit!=null&&candidate.fit!==before?.fit&&!['cover','contain'].includes(candidate.fit))throw fault('画面适配方式无效。');
        validateClip(candidate,p);
        if(actor==='user'&&direct.has(cmd)){
          const a=p.assets.find(a=>a.id===candidate.assetId);
          const out=c=>(c.sourceIn??0)+c.duration*(c.speed??1);
          // Older edits allowed a one-frame rounding margin. They remain movable and repairable,
          // but fresh manual trims and inserts cannot run beyond the end of a real source.
          if(a&&a.kind!=='image'&&(!before||before.assetId!==a.id||out(candidate)>out(before)+1e-7) &&
            out(candidate)>Math.ceil(a.duration*p.profile.fps-1e-8)+1e-7)throw fault('剪辑超出原片的可用窗口。');
        }
        if(actor!=='user' && candidate.assetId!==before?.assetId && dedicatedVoiceReference(p.assets.find(a=>a.id===candidate.assetId)))throw fault('专用音色参考不能被自动加入本片剪辑。',409);
        if(actor!=='user'&&clips.some(c=>c.locked&&c.track===candidate.track&&spans(c,candidate)&&overlapOnStage(c,candidate,p.profile)))throw fault('本次修改会覆盖已锁定的轨道区间。',409);
        if(cmd.op==='add')clips.push(candidate);else clips[found]=candidate;
      }
      if(sceneMeta)Object.assign(p,copy(sceneMeta));
      syncMotionSounds(p,before,expanded,paths(id).assets,actor);
      sortClips(clips);
      if(actor==='user'){
        if(!isDeepStrictEqual(before,clips))journal.record(p,commands);
        else if(!sceneMeta)return false;
      }
    });
  }
  function playHistory(id,base,forward){
    if(!Number.isSafeInteger(base))throw conflicts();
    return mutate(id,base,p=>{journal.apply(p,forward);});
  }
  function applySceneEdit(id,baseRevision,commands,metadata,actor='codex'){
    if(!metadata||Object.keys(metadata).some(k=>!['storyboard','facts','directorNotes','styleAudio','pendingSequence','sequenceApproval'].includes(k)))throw fault('分镜事务元数据无效。');
    return apply(id,baseRevision,commands,actor,metadata);
  }
  const immutable=new Set(['id','schema','profile','title','mode','settings','timeline','assets','style','script','brief','revision','createdAt','updatedAt','__proto__','constructor','prototype']);
  function setMeta(id,patch){
    if(!patch||Object.keys(patch).some(k=>immutable.has(k)))throw fault('工程内容必须使用版本编辑接口。');
    return mutate(id,undefined,p=>Object.assign(p,patch),false);
  }
  function configure(id,base,changes){
    if(!Number.isInteger(base))throw conflicts();
    return mutate(id,base,p=>{
      for(const k of ['title','brief','script'])if(k in changes)p[k]=text(changes[k],k==='script'?160000:10000);
      if(changes.style)p.style=copy(changes.style);
      if(changes.publication){
        const {title,body,tags}=changes.publication;
        if(typeof title!=='string'||typeof body!=='string'||!Array.isArray(tags)||tags.some(t=>typeof t!=='string'))throw fault('请输入有效的发布标题、正文与话题。');
        const titleError=title.trim()&&portraitLayout(p)&&portraitTitleProblem(title);
        if(titleError)throw fault(titleError);
        let layout;try{layout=publicationFields({...p.publication,...changes.publication});}catch(e){throw fault(e.message);}
        p.publication={...layout,title:text(title,180).trim(),body:text(body,4000).trim(),tags:[...new Set(tags.map(tag=>text(tag,48).trim().replace(/^#+/,'')))].filter(Boolean).slice(0,12)};
      }
      if(changes.sourceAnchors){
        if(!Array.isArray(changes.sourceAnchors)||changes.sourceAnchors.some(a=>!p.assets.some(asset=>asset.id===a.assetId&&a.sourceFrame<=Math.ceil(asset.duration*p.profile.fps))||!Number.isSafeInteger(a.sourceFrame)||a.sourceFrame<0||!String(a.label||'').trim()))throw fault('动作标记必须绑定可用原片内的帧。');
        p.sourceAnchors=copy(changes.sourceAnchors);
      }
      if(changes.settings||changes.style){
        const previous=p.settings;p.settings=newSettings(p.mode,{...previous,...changes.settings},p.style);
        if(changes.settings?.sceneSound!==undefined && p.settings.sceneSound!==previous.sceneSound){
          syncMotionSounds(p,p.timeline.clips.map(c=>({...c})),[],paths(id).assets,'user',true);
          p.timeline.clips.sort((a,b)=>a.start-b.start||tracks.indexOf(a.track)-tracks.indexOf(b.track)||a.id.localeCompare(b.id));
        }
        if(p.settings.voiceReferenceAssetId!==previous.voiceReferenceAssetId){
          const a=p.assets.find(a=>a.id===p.settings.voiceReferenceAssetId);
          p.settings.referenceHash=a?.sha256||null;
          if(!changes.settings?.voiceLibraryId)p.settings.voiceLibraryId=null;
          p.settings.voiceId=undefined;
        }
      }
      if(changes.profile){if(p.timeline.clips.length)throw fault('已有片段的工程须沿用原时间基准。');p.profile=profileOf(changes.profile);}
    });
  }
  function list(){return db.prepare('SELECT body FROM projects ORDER BY rowid DESC').all().map(r=>{const p=JSON.parse(r.body);return {id:p.id,title:p.title,mode:p.mode,revision:p.revision,updatedAt:p.updatedAt};}).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
  function revision(id,rev){const row=db.prepare('SELECT body FROM history WHERE project=? AND revision=?').get(checkId(id),rev);if(!row)throw fault('工程版本不存在。',404);return JSON.parse(row.body);}
  function snapshot(p,destination=path.join(paths(p.id).directory,'project.vstudio.json')){
    const out=copy(p), dir=path.dirname(destination);
    out.assets=out.assets.map(a=>({...a,path:path.relative(dir,a.path)}));
    delete out.threadId;
    const tmp=destination+'.'+randomUUID()+'.tmp';
    try{writeFileSync(tmp,JSON.stringify(out,null,2),{mode:0o600});renameSync(tmp,destination);}finally{rmSync(tmp,{force:true});}
    return destination;
  }
  function saveJob(j){db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?,?)').run(checkId(j.id),checkId(j.projectId),JSON.stringify(j));return j;}
  function saveCutPair(first,review){return transaction(()=>{saveJob(first);saveJob(review);});}
  function listJobs(id){const rows=id?db.prepare('SELECT body FROM jobs WHERE project=? ORDER BY rowid DESC').all(checkId(id)):db.prepare('SELECT body FROM jobs ORDER BY rowid DESC').all();return rows.map(r=>JSON.parse(r.body));}
  function getJob(id){const row=db.prepare('SELECT body FROM jobs WHERE id=?').get(checkId(id));if(!row)throw fault('找不到该任务。',404);return JSON.parse(row.body);}
  async function importSnapshot(file,styles) {
    const {readFile}=await import('node:fs/promises');const data=JSON.parse(await readFile(file,'utf8'));
    if(data.schema!==1||!Array.isArray(data.assets)||!Array.isArray(data.timeline?.clips))throw fault('工程文件格式无效。');
    const directory=await realpath(path.dirname(file));const validated=[];
    if(!['topic','script','interview'].includes(data.mode))throw fault('导入工程的类型无效。');
    for(const group of [data.assets,data.timeline.clips]){const ids=group.map(v=>checkId(v.id));if(new Set(ids).size!==ids.length)throw fault('工程含重复编号。');}
    for(const asset of data.assets){
      const name=path.resolve(directory,asset.path);const actual=await realpath(name);
      if(!actual.startsWith(directory+path.sep))throw fault('请从包含 assets 子目录的工程根目录打开。');
      const hash=createHash('sha256');for await(const block of createReadStream(actual))hash.update(block);
      if(hash.digest('hex')!==asset.sha256)throw fault('工程素材内容已改变。');
      validated.push({...asset,...await probeMedia(actual),path:actual});
    }
    // Publish the imported copy only after the media and all relationships validate.
    const id=randomUUID(), dirs=paths(id);
    try{
      for(const dir of Object.values(dirs))await mkdir(dir,{recursive:true,mode:0o700});
      const assets=[];
      for(const a of validated){checkId(a.id);const dest=path.join(dirs.assets,a.sha256+path.extname(a.path));await copyFile(a.path,dest,constants.COPYFILE_FICLONE);assets.push({...a,path:dest});}
      const p={...data,id,assets,revision:1,profile:profileOf(data.profile),settings:newSettings(data.mode,data.settings),createdAt:now(),updatedAt:now()};
      for(const clip of p.timeline.clips)validateClip(clip,p);
      delete p.threadId;delete p.directorState;
      if(p.style?.manifest){
        if(!styles)throw fault('打开此工程需要个人风格库。');
        await styles.restorePortable(p.style,directory);
      }
      return transaction(()=>persist(p,true));
    }catch(e){rmSync(dirs.directory,{recursive:true,force:true});throw e;}
  }
  return {root,db,paths,get,list,create,addAsset,history:id=>transaction(()=>journal.state(get(id)),true),undo:(id,base)=>playHistory(id,base,false),redo:(id,base)=>playHistory(id,base,true),apply:(id,base,commands,actor)=>apply(id,base,commands,actor),applySceneEdit,setMeta,configure,revision,snapshot,importSnapshot,saveJob,saveCutPair,getJob,listJobs,close:()=>db.close()};
}
