import {revisionFeedback,confirmRevision,reviewDelta,currentRevision} from './revisions.mjs';
import {prepareReviewPacket} from './review-packet.mjs';
import {provisionalPackage} from './provisional.mjs';
import {beginAutomatic,nextAutomatic,advanceAutomatic,curateSelection,requestHash} from './automatic.mjs';
import {bindCandidate,verifyCandidate,recoverFailedReview,registerIndependentReview,reviewDeliveryPackage,validateDeliveryFiles,enforceIndependentReview,assertCanProduce} from './quality.mjs';
import http from 'node:http';
import {normalizeDownloadRequest} from './production-progress.mjs';
import {searchContext} from './search-context.mjs';
import {workbenchDataDirectory} from './paths.mjs';
import {readFile,writeFile,mkdir,mkdtemp,rename,stat,copyFile,realpath,unlink,rm,rmdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {initialStudio,validateSettings,validateSearchLimit,updateSettings,validatePlan,inputHash,brief,assertReady,taskNames,safeUrl,sourceId,approvalAuthority} from './studio-workflow.mjs';
import {createPluginBridge,workbenchIdentity} from './plugin.mjs';
import {runAgent as runCliAgent,cleanError,jobStopState} from './agent.mjs';
import {desktopSessions} from './desktop-session.mjs';
import {runDesktopAgent} from './desktop-agent.mjs';
import {submitNarration} from './narration.mjs';
import {inspectPreparation} from './continuous.mjs';
import {runPlanningAgent,savePlanningStage} from './planning.mjs';
import {inspectCodex,sourceCapabilities,dependencyFailures,styleCapabilities,styleMediaChecks,failedDependencyReport} from './runtime.mjs';
import {rememberUsage} from './public/token-usage.js';
import {fileHash,contained,mediaExtensions,mimeTypes,streamFile,saveUpload,publicUrl,nativeMediaTool} from './media.mjs';
import {sourceDetails,materialPlan,normalizeReview,materialSelection,verifySourceIdentity} from './sources.mjs';
import {MediaLibrary,candidateId} from './library.mjs';
import {repositoryCatalog} from './repository.mjs';
import {ProjectStore,historicalProject} from './projects.mjs';
import {recoverLegacyProjects} from './recover-projects.mjs';
import {canCollectRepository,collectRepository,scopedCollectionContext} from './collection.mjs';
import {normalizeVoiceRequest,pendingVoiceRequest,requireVoiceRequest,voiceAnswer,recordVoiceAnswer,voiceContext,saveVoiceRecording,voiceScope,savedVoiceChoices,savedVoiceRequest} from './voices.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=workbenchDataDirectory();
const port=Number(process.env.PORT||4317);
const execute=promisify(execFile),stateFile=path.join(dataDir,'workbench-v2.json');
await mkdir(dataDir,{recursive:true});
const runtimeIdentity=await workbenchIdentity(root);
const plugin={root:runtimeIdentity.pluginRoot,version:runtimeIdentity.version};
if(runtimeIdentity.styleHome)process.env.VIDEO_STUDIO_HOME=runtimeIdentity.styleHome;
if(runtimeIdentity.mediaRoot)process.env.VIDEO_STUDIO_MEDIA_ROOT=runtimeIdentity.mediaRoot;
if(runtimeIdentity.packRoot)process.env.VIDEO_STUDIO_PACK_ROOT=runtimeIdentity.packRoot;
// Plugin installs may rename/remove their code directory while this server runs.
// Keep all inherited subprocess working directories in persistent user storage.
process.chdir(dataDir);
const bridge=createPluginBridge(plugin,path.join(dataDir,'requests'));
const library=await new MediaLibrary(path.join(dataDir,'material-library'),file=>bridge('inspect-media',{file})).init();
await library.backfill(path.join(dataDir,'runs'));
let libraryEntries=await library.list(),libraryCandidates=await library.candidateList(libraryEntries);
async function refreshLibrary(){libraryEntries=await library.list();libraryCandidates=await library.candidateList(libraryEntries);}
let project;
try{project=JSON.parse(await readFile(stateFile,'utf8'));if(project.schema!==2)throw new Error('工作台状态版本不兼容。');}
catch(e){if(e.code!=='ENOENT')throw e;project=initialStudio();}
const projectStore=await new ProjectStore(dataDir).init(project);
project=projectStore.load(project.id);
await recoverLegacyProjects(dataDir,project,projectStore);
if(!historicalProject(project)){
  await library.rememberCandidates(project.sources,{run:project.run,topic:project.topic,style:project.styleSelector,query:project.sourceReview?.query||'',events:project.sourceReview?.events,reviewedAt:project.sourceReview?.reviewed_at,jobId:project.sourceReview?.jobId});
  if(project.run)for(const source of project.sources.filter(s=>s.status==='ready'))await cacheMedia(source);
  for(const job of project.jobs)if(['running','cancelling'].includes(job.status)&&job.execution?.backend!=='desktop'){job.status='interrupted';job.error='服务已重启。远端状态可能尚未完成，请继续已有任务并核对插件记录。';job.completedAt=new Date().toISOString();}
  if(project.automatic?.status==='running'&&!project.jobs.some(j=>['running','cancelling'].includes(j.status)&&j.execution?.backend==='desktop'))project.automatic.status='paused';
  const restoredAcquisitions=new Set();for(const job of project.jobs)if(job.candidateCacheId&&!restoredAcquisitions.has(job.candidateCacheId)){restoredAcquisitions.add(job.candidateCacheId);await library.markAcquisition(job.candidateCacheId,job);}
}
await refreshLibrary();
let writes=Promise.resolve(),active=null,mutation=false,catalog=null,cancelGeneration=0;
function persist({select=false}={}){
  const historical=historicalProject(project);
  if(historical&&!select)return writes;
  if(!historical){rememberUsage(project);project.updatedAt=new Date().toISOString();}
  const snapshot=JSON.stringify(project,null,2);
  writes=writes.catch(()=>{}).then(async()=>{
    if(!historical)await projectStore.save(JSON.parse(snapshot));
    await writeFile(stateFile+'.tmp',snapshot,{mode:0o600});
    await rename(stateFile+'.tmp',stateFile);
  });
  return writes;
}
async function activateProject(next){await persist();const previous=project;project=next;try{await persist({select:true});}catch(e){project=previous;throw e;}}
await persist();
async function exclusive(fn){if(mutation||active)throw new Error('已有操作正在进行，请等待完成后再试。');mutation=true;try{return await fn();}finally{mutation=false;}}
async function getCatalog(){catalog=await bridge('catalog');return catalog;}
await getCatalog();
const runtime={codex:false,authenticated:false,compatible:false,codexVersion:null,pluginVersion:plugin.version,chatcut:'not_checked',chatcutCheckedAt:null,message:'尚未检查 ChatCut 实际连接',dependencies:null,preparing:false};
let rejectedRuntime=null;
const rejectedRuntimeFile=path.join(dataDir,'incompatible-cli.json');
try{rejectedRuntime=JSON.parse(await readFile(rejectedRuntimeFile,'utf8'));}catch{}
function rememberDependencies(report){const previous=runtime.dependencies?.checks||[];const next=(report.checks||[]).map(check=>({...check,checkedAt:report.checkedAt}));runtime.dependencies={...report,checks:[...previous.filter(check=>!next.some(item=>item.id===check.id)),...next]};return runtime.dependencies;}
async function checkLocal(capabilities=['python','media','downloader','repository','repository_media','git_lfs',...styleMediaChecks],styleSelector=project.styleSelector){
  const cwd=(!historicalProject(project)&&project.run)||path.join(dataDir,'runs');await mkdir(cwd,{recursive:true});
  const [cli,dependencies]=await Promise.all([inspectCodex({cwd}),bridge('preflight',{capabilities,styleSelector}).catch(error=>failedDependencyReport(capabilities,styleSelector,cleanError(error.message)))]);
  Object.assign(runtime,cli);rememberDependencies(dependencies);
  if(rejectedRuntime&&rejectedRuntime.path===runtime.codexPath&&rejectedRuntime.version===runtime.codexVersion&&rejectedRuntime.model===runtime.model){runtime.compatible=false;runtime.error=rejectedRuntime.error;}
  else if(rejectedRuntime){rejectedRuntime=null;await unlink(rejectedRuntimeFile).catch(()=>{});}
  return runtime;
}
function preflightError(message){return Object.assign(new Error(message),{code:'preflight_failed'});}
function requireDependencies(capabilities){const missing=dependencyFailures(runtime.dependencies,capabilities);if(missing.length)throw preflightError(missing.map(item=>`${item.label}：${item.message}。${item.remedy||''}`).join('\n'));}
async function checkMedia(){rememberDependencies(await bridge('preflight',{capabilities:['python','media']}));requireDependencies(['python','media']);}
await checkLocal();
const desktop=desktopSessions({dataDir,codex:()=>runtime.codexPath});await desktop.load();
const desktopAction=action=>!['review','plan','plan_review'].includes(action)&&desktop.state().mode==='desktop';
function runAgent(options){return options.job.execution?.backend==='desktop'?runDesktopAgent({...options,reader:desktop.reader()}):runCliAgent(options);}
for(const job of project.jobs.filter(j=>!historicalProject(project)&&j.action==='discover'&&j.status==='interrupted')){
  try{const directory=path.join(dataDir,'jobs',job.id),context=JSON.parse(await readFile(path.join(directory,'request.json'),'utf8'));
    if(context.jobId===job.id&&context.run===project.run&&context.brief.topic===project.topic&&context.brief.style===project.styleSelector&&context.sourceProgressPath===path.join(directory,'source-progress.json'))await saveSourceProgress(job,context,JSON.parse(await readFile(context.sourceProgressPath,'utf8')));
  }catch{}
}
function addEvent(job,type,message){job.events.push({type,message:cleanError(message),time:new Date().toISOString()});job.events=job.events.slice(-180);persist().catch(()=>{});}
function sourceRecord(s){return {id:s.id,kind:s.kind,title:s.title,url:s.url||undefined,local_path:s.localPath||undefined,author:s.author||'',rights:s.rights||'unknown',need_ids:s.needIds?.length?s.needIds:['workbench-selection'],topic_fit:s.topicFit||s.description||'用户选择',style_fit:s.styleFit||'按本期风格评估',source_type:s.sourceType||'other',event_date:s.eventDate||'',date_evidence:s.dateEvidence||'',...(s.acquisitionReport?{acquisition_report:s.acquisitionReport}:{}),verification:s.verification||'',caveats:s.caveats||[],repository_commit:s.repositoryCommit||'',repository_path:s.repositoryPath||'',expected_sha256:s.expectedSha256||'',expected_bytes:s.expectedBytes||0,sha256:s.sha256,bytes:s.bytes,duration:s.duration,width:s.width,height:s.height,source_start_seconds:s.start||0,source_end_seconds:s.end||0};}
async function saveMaterialSelection(){if(project.run)await writeFile(path.join(project.run,'material-selection.json'),JSON.stringify(materialSelection(project),null,2));}
async function ensureRun(){
  if(!project.run){const result=await bridge('create',{title:project.topic||'工作台连接检查',outputRoot:path.join(dataDir,'runs'),brief:brief({...project,topic:project.topic||'工作台连接检查'})});project.run=result.run;await persist();}
  if(project.topic)await bridge('sync',{run:project.run,brief:brief(project),selectionAuthority:project.automatic?{kind:'delegated',request:project.automatic.authorization}:null,sources:project.sources.filter(s=>project.selected.includes(s.id)).map(sourceRecord)});
  await saveMaterialSelection();return project.run;
}
async function checkSelected(){for(const source of project.sources.filter(s=>project.selected.includes(s.id))){const actual=await contained(source.localPath,project.run);if(await fileHash(actual)!==source.sha256)throw new Error(`素材「${source.title}」已经变化，请重新采集并审阅方案。`);}}
async function cacheMedia(source){try{await library.remember(source,project.run);source.cacheStatus='saved';await refreshLibrary();}catch(e){source.cacheStatus='failed';source.cacheError=cleanError(e.message);library.errors.push({title:source.title,error:source.cacheError});}}
async function registerMedia(file,metadata={}){
  file=await contained(file,project.run);if(!mediaExtensions.has(path.extname(file).toLowerCase()))throw new Error('不支持的媒体格式。');
  const inspected=await bridge('inspect-media',{file});verifySourceIdentity(inspected,metadata);
  if(inspected.bytes>350*1024*1024)throw new Error('单个素材需小于 350 MB，请缩短采集范围。');
  const kind=mimeTypes[path.extname(file).toLowerCase()]?.startsWith('image/')?'image':inspected.hasVideo?'video':'audio';
  const existing=project.sources.find(s=>s.sha256===inspected.sha256 && s.status==='ready');if(existing&&(!metadata.id||metadata.id===existing.id)){await cacheMedia(existing);return existing;}
  const source={...sourceDetails(metadata),id:metadata.id || 's-'+randomUUID().slice(0,12),candidateCacheId:metadata.candidateCacheId||null,title:metadata.title||path.basename(file),kind,url:metadata.url||'',mediaUrl:metadata.mediaUrl||'',author:metadata.author||'',rights:metadata.rights||'unknown',publishedAt:metadata.publishedAt||'',description:metadata.description||'',start:Number(metadata.start)||0,end:Number(metadata.end)||inspected.duration,localPath:file,acquisitionReport:metadata.acquisitionReport||'',status:'ready',duration:inspected.duration,width:inspected.width,height:inspected.height,sha256:inspected.sha256,bytes:inspected.bytes,thumbnailPath:null};
  if(inspected.hasVideo){
    const thumbnail=path.join(project.run,'previews',source.id+'.jpg');await mkdir(path.dirname(thumbnail),{recursive:true});
    try{await execute(runtime.dependencies?.programs?.ffmpeg||await nativeMediaTool('ffmpeg'),['-v','error','-y','-ss',String(kind==='image'?0:Math.min(.5,inspected.duration/3)),'-i',file,'-frames:v','1','-vf','scale=480:-2',thumbnail],{timeout:30000});source.thumbnailPath=thumbnail;}catch{}
  }
  const index=project.sources.findIndex(s=>s.id===source.id);if(index>=0)project.sources[index]=source;else project.sources.push(source);
  project.revision++;if(project.selected.includes(source.id)){project.approval=null;if(project.plan)project.plan.stale=true;}await cacheMedia(source);return source;
}
async function normalizeCandidates(items){
  if(!Array.isArray(items)||items.length>80)throw new Error('素材候选格式不正确。');
  const normalized=[];
  for(const item of items){
    if(typeof item.title!=='string'||!['video','image','audio','article','paper'].includes(item.kind))throw new Error('素材候选缺少标题或类型。');
    const url=await publicUrl(item.url||item.mediaUrl);let mediaUrl='',thumbnailUrl='';
    if(item.mediaUrl)try{mediaUrl=await publicUrl(item.mediaUrl);}catch{}
    if(item.thumbnailUrl)try{thumbnailUrl=await publicUrl(item.thumbnailUrl);}catch{}
    const entry={...sourceDetails(item),id:sourceId({url}),title:item.title.slice(0,300),kind:item.kind,url,mediaUrl,thumbnailUrl,author:String(item.author||'').slice(0,200),publishedAt:String(item.publishedAt||''),description:String(item.description||'').slice(0,4000),rights:String(item.rights||'unknown').slice(0,1000),start:Math.max(0,Number(item.start)||0),end:Math.max(0,Number(item.end)||0),status:'candidate'};
    const existing=project.sources.find(s=>s.id===entry.id);normalized.push(existing?.status==='ready'?existing:entry);
  }
  return normalized;
}
async function saveSourceProgress(job,context,snapshot){
  if(snapshot.schema!==1||snapshot.jobId!==job.id||snapshot.topic!==context.brief.topic||(snapshot.style||null)!==(context.brief.style||null)||!Array.isArray(snapshot.sources)||snapshot.sources.length>(context.searchLimit??80))throw new Error('中间候选与当前任务不一致。');
  if(snapshot.sources.some(source=>source.localPath||source.local_path||source.status==='ready'))throw new Error('中间候选只能登记来源链接，不能声明媒体已经下载。');
  const unseen=snapshot.sources.filter(source=>!project.sources.some(existing=>existing.url===source.url));
  const sources=await normalizeCandidates(unseen.map(source=>({...source,verification:'检索中间记录，尚未完成本轮核验',caveats:[...(Array.isArray(source.caveats)?source.caveats:[]),'本轮检索尚未完成；候选未下载、未选用。']})));
  if(!sources.length)return;
  project.sources.push(...sources);job.partialSourceIds=[...new Set([...(job.partialSourceIds||[]),...sources.map(source=>source.id)])];
  job.partialSavedAt=new Date().toISOString();
  await library.rememberCandidates(sources,{run:project.run,topic:context.brief.topic,style:context.brief.style,query:context.query,jobId:job.id});
  await refreshLibrary();await persist();addEvent(job,'partial',`已保存 ${job.partialSourceIds.length} 条中间候选，仍在检索与核实；尚未下载。`);
}
function cleanEditor(raw){try{const url=new URL(raw);if(url.protocol!=='https:'||url.hostname!=='app.chatcut.io')return '';url.searchParams.delete('editor-boot-token');url.searchParams.delete('dockviewLayout');return url.href;}catch{return '';}}
async function deliver(result,job){
  if(!project.qualityCycle?.report?.completed||project.qualityCycle.candidate.producerJobId!==job.id)throw Error('独立验收未通过，不能交付。');
  await validateDeliveryFiles(result,project.run,file=>bridge('inspect-media',{file}));
  const audited=await enforceIndependentReview({...project.qualityCycle.report,...await bridge('review-audit',{run:project.run,file:result.files.find(f=>f.role==='video').path,subtitles:result.files.find(f=>f.role==='subtitles')?.path})},project.run);
  if(!audited.completed||audited.artifact_sha256!==project.qualityCycle.report.artifact_sha256)throw Error('验收证据已失效，不能交付。');
  if(!Array.isArray(result.files))throw new Error('没有收到真实导出文件。');
  if(!result.projectId || !result.timelineId || !job.toolCalls.some(t=>/chatcut/i.test(t.server+' '+t.tool)&&t.status==='completed'))throw new Error('缺少真实 ChatCut 工程或工具调用记录，不能当作已完成制片。');
  const runRecord=JSON.parse(await readFile(path.join(project.run,'run.json'),'utf8'));
  if(runRecord.project?.projectId!==result.projectId||runRecord.project?.timelineId!==result.timelineId)throw new Error('导出工程与插件保存的实际工程不一致。');
  if(!job.toolCalls.some(t=>/chatcut/i.test(t.server+' '+t.tool)&&/submit_export|track_export/.test(t.tool)&&t.status==='completed'))throw new Error('没有实际导出或导出状态查询记录。');
  const registered=[];for(const item of result.files){if(typeof item.path!=='string')continue;const file=await contained(item.path,project.run);const info=await stat(file);if(info.isFile())registered.push({...item,path:file,bytes:info.size});}
  if(registered.filter(f=>f.role==='video').length!==1)throw new Error('请返回唯一的最终视频文件，历史导出不能混为本次成片。');
  const video=registered.find(f=>f.role==='video' && path.extname(f.path).toLowerCase()==='.mp4');if(!video)throw new Error('没有实际存在的 MP4 成片。');
  addEvent(job,'verification','正在独立校验成片文件、尺寸、时长和完整解码');
  const verified=await bridge('verify-video',{file:video.path,requirements:brief(project).requirements});
  if(project.captions && !registered.some(f=>f.role==='subtitles'&&path.extname(f.path).toLowerCase()==='.srt'))throw new Error('本期启用了字幕，但没有导出实际 SRT。');
  const outputRoot=path.resolve(project.outputRoot);await mkdir(outputRoot,{recursive:true});
  const date=project.deliveryDate||new Intl.DateTimeFormat('sv-SE',{timeZone:project.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const basename=date+'_'+((project.editorial?.title||project.topic).replace(/[\/\\\x00-\x1f]+/g,'-').slice(0,80)||'video');
  const staging=await mkdtemp(path.join(outputRoot,'.pending-'+job.id+'-'));
  let directory=null,published=false;
  try{
    for(let n=1;n<10000;n++){
      const target=path.join(outputRoot,basename+(n===1?'':'（'+n+'）'));
      try{await mkdir(target);directory=target;break;}catch(error){if(error.code!=='EEXIST')throw error;}
    }
    if(!directory)throw Error('无法建立独立交付目录。');
    const extras={
      'sources.json':project.sources.filter(s=>project.selected.includes(s.id)).map(s=>({id:s.id,title:s.title,url:s.url,author:s.author,rights:s.rights,sha256:s.sha256,start:s.start,end:s.end})),
      'project.json':{projectId:result.projectId,timelineId:result.timelineId,editorUrl:cleanEditor(result.editorUrl),brief:brief(project),approval:project.approval},
      'qa-report.json':project.qualityCycle.report,
      'delivery-report.json':{video:verified,notes:result.notes||[],qaStatus:'passed',captionsEnabled:project.captions,review:project.qualityCycle.report,limitation:'通过抽帧视觉与客观音频验收；不表示实际完整观看或听审。'}
    };
    for(const [file,value] of Object.entries(extras))await writeFile(path.join(staging,file),JSON.stringify(value,null,2));
    const files=[];
    async function add(file,name,role){if(files.some(f=>f.name===name))throw new Error('交付文件名重复，请核对导出结果。');const destination=path.join(staging,name);await copyFile(file,destination);const expected=registered.find(f=>f.path===file)?.sha256;if(expected&&await fileHash(destination)!==expected)throw Error('交付复制后的文件与验收文件不一致。');files.push({id:randomUUID(),name,role,path:destination,bytes:(await stat(destination)).size,sha256:await fileHash(destination)});}
    for(const item of registered){const ext=path.extname(item.path).toLowerCase();if(!['.mp4','.srt','.json','.md','.txt','.png','.jpg','.jpeg','.webp'].includes(ext))continue;const name=item.role==='video'?'final.mp4':item.role==='subtitles'?'字幕.srt':item.role==='qa'?'producer-qa-report.json':item.role==='cover_portrait'?'封面_竖版_3x4.png':item.role==='cover_landscape'?'封面_横版_4x3.png':item.role==='copy'?'发布文案.txt':`${files.length+1}-${path.basename(item.path)}`;await add(item.path,name,item.role);}
    const approval=await bridge('check-approval',{run:project.run,planHash:project.approval.planHash,inputHash:inputHash(project)});await add(approval.file,'script-storyboard.md','plan');
    for(const file of Object.keys(extras)){const p=path.join(staging,file);files.push({id:randomUUID(),name:file,role:file.startsWith('sources')?'sources':file.startsWith('project')?'project':'qa',path:p,bytes:(await stat(p)).size,sha256:await fileHash(p)});}
    await rename(staging,directory);published=true;for(const file of files)file.path=path.join(directory,file.name);
    const delivery={id:randomUUID(),directory,createdAt:new Date().toISOString(),jobId:job.id,editorUrl:cleanEditor(result.editorUrl),projectId:result.projectId,timelineId:result.timelineId,files,videoId:files.find(f=>f.role==='video').id,qaStatus:'passed',captionsEnabled:project.captions,review:project.qualityCycle.report,notes:result.notes||[],verified};
    project.deliveryDate=date;project.deliveries.unshift(delivery);return delivery;
  }finally{
    // Only clean this attempt's private staging and its still-empty reservation.
    await rm(staging,{recursive:true,force:true}).catch(()=>{});
    if(directory&&!published)await rmdir(directory).catch(()=>{});
  }
}
async function savePlan(plan){plan=validatePlan(plan,project);const saved=await bridge('save-plan',{run:await ensureRun(),plan,inputHash:inputHash(project)});project.plan={...plan,version:saved.version,planHash:saved.file_sha256,inputHash:saved.input_hash,file:saved.file};project.approval=null;project.revision++;return project.plan;}
async function adoptProductionCheckpoint(job,context,value){
  const current=()=>{if(job.cancelRequested||active?.job.id!==job.id||project.automatic?.id!==job.automaticId||project.automatic.status!=='running')throw Error('制作授权已停止或不属于本任务');};current();
  const sources=await inspectPreparation(value,project.run,brief(project).requirements,file=>bridge('inspect-media',{file}));
  // Validate against a temporary selection before mutating the user's project.
  const proposed={...project,sources:[...project.sources.filter(s=>!sources.some(x=>x.id===s.id)),...sources],selected:sources.map(s=>s.id)};
  if(value.editorial.captions!==project.captions||value.editorial.music!==project.music)
    throw Error('检查点与项目设置不符：字幕='+project.captions+'，配乐='+project.music+'。请按本期设置修正方案。');
  const plan=validatePlan(value.plan,proposed);
  await bridge('validate-preparation',{run:project.run,brief:brief(proposed),sources:sources.map(sourceRecord),plan});current();
  // Pin evidence and validate the Python style/source contract before approving.
  Object.assign(project,{sources:proposed.sources,selected:proposed.selected,captions:proposed.captions,music:proposed.music,editorial:value.editorial});
  project.approval=null;if(project.plan)project.plan.stale=true;
  await savePlan(plan);
  current();
  const authority={kind:'delegated_review',authorizedByUser:true,userRequest:project.automatic.authorization,reviewerJobId:job.id};
  const approved=await bridge('approve',{run:project.run,planHash:project.plan.planHash,inputHash:inputHash(project),authority});
  project.approval={status:'confirmed',planHash:approved.file_sha256,inputHash:approved.input_hash,version:approved.version,confirmedAt:approved.confirmed_at,authority};
  job.inputHash=project.approval.inputHash;job.planHash=project.approval.planHash;
  context.inputHash=job.inputHash;context.planHash=job.planHash;context.plan=project.plan;context.approval=project.approval;
  context.selectedSources=sources;context.brief=brief(project);context.productionContext=await bridge('production-context',{run:project.run});
  project.planDraft=null;project.automatic.gaps=[];project.automatic.preparedBy=job.id;
  await persist();
  return {planHash:job.planHash,inputHash:job.inputHash,approval:project.approval,productionContext:context.productionContext};
}
async function finishJob(job,context,{code,error,finalText}){
  let followup=null;
  try{
    if(job.failureKind==='cli_incompatible'){
      rejectedRuntime={path:job.execution?.cliPath,version:job.execution?.cliVersion,model:job.execution?.model,error:cleanError(error)};
      runtime.compatible=false;runtime.error=rejectedRuntime.error;await writeFile(rejectedRuntimeFile,JSON.stringify(rejectedRuntime),{mode:0o600});
    }
    if(job.cancelRequested){Object.assign(job,jobStopState(job));addEvent(job,job.stopReason==='timeout'?'error':'cancelled',job.error);return;}
    if(code!==0)throw new Error(cleanError(error||'Codex 未完成任务。'));
    let text=finalText.trim();if(text.startsWith('```'))text=text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    const result=JSON.parse(text);job.summary=String(result.summary||result.message||'任务已返回');
    if(job.action==='connect'){
      const witnessed=job.toolCalls.some(t=>/chatcut/i.test(t.server+' '+t.tool)&&/list_projects/.test(t.tool)&&t.status==='completed');
      runtime.chatcut=result.connected&&witnessed?'connected':'failed';runtime.chatcutCheckedAt=new Date().toISOString();runtime.message=String(result.message);job.status=runtime.chatcut==='connected'?'completed':'blocked';
      if(result.connected&&!witnessed)job.error='没有实际的 ChatCut 只读调用证据，不能报告连接成功。';
    }
    else if(job.action==='voice'){
      job.voiceRequest=result.status==='needs_input'?await normalizeVoiceRequest(result.voiceRequest,job):null;
      job.questions=(result.questions||[]).map(String);
      if(result.status!=='ready'){job.status=result.status==='needs_input'?'needs_input':'blocked';job.error=result.summary;return;}
      if(!result.voice?.provider||!result.voice.voiceId||!['official','custom'].includes(result.voice.voiceType)||!job.toolCalls.some(t=>/voice/.test(t.tool)&&t.status==='completed'))throw Error('缺少实时音色就绪证据。');
      const answers=context.voice.answers,selected=answers.findLast(a=>a.action==='select'),recording=answers.findLast(a=>a.action==='recording');
      const saved=context.voice.savedVoice;
      if(!(selected&&selected.voice.voiceId===result.voice.voiceId&&selected.voice.provider===result.voice.provider)&&!(saved&&saved.voiceId===result.voice.voiceId&&saved.provider===result.voice.provider)&&!(recording?.confirmedConsent&&result.voice.voiceType==='custom'))throw Error('音色未被明确选择或授权创建。');
      project.voiceDirectoryPending=false;project.voiceChoice={...result.voice,selected_by_user:true};project.voiceReady={scope:voiceScope(project),checkedAt:new Date().toISOString(),jobId:job.id};
      await bridge('save-voice',{voice:project.voiceChoice});await ensureRun();await getCatalog();
      if(project.automatic)project.automatic.requestHash=requestHash(project);
      job.status='completed';
    }
    else if(job.action==='curate'){
      const choice=curateSelection(result,project);project.editorial=choice;project.automatic.sourceIds=choice.sourceIds;
      choice.captions=project.captions;choice.music=project.music;
      project.selected=choice.sourceIds.filter(id=>project.sources.find(s=>s.id===id)?.status==='ready');
      project.automatic.collected=[...project.selected];await ensureRun();job.status='completed';
    }
    else if(job.action==='plan_review'){
      if(result.approved!==true||result.issues?.length){
        project.automatic.planReviewAttempts=(project.automatic.planReviewAttempts||0)+1;
        job.summary=result.summary+' '+(result.issues||[]).join('；');
        if(project.automatic.planReviewAttempts<=2){job.status='completed';project.automatic.stage='plan';followup={action:'plan',followup:job.summary};return;}
        job.status='blocked';job.error='自动方案修订后仍未通过：'+job.summary;return;
      }
      const authority={kind:'delegated_review',authorizedByUser:true,userRequest:project.automatic.authorization,reviewerJobId:job.id};
      const approved=await bridge('approve',{run:project.run,planHash:project.plan.planHash,inputHash:inputHash(project),authority});
      project.approval={status:'confirmed',planHash:approved.file_sha256,inputHash:approved.input_hash,version:approved.version,confirmedAt:approved.confirmed_at,authority};job.status='completed';
    }
    else if(job.action==='review'){
      const cycle=project.qualityCycle;
      if(!context.preflightReport)await writeFile(path.join(job.directory,'review-response.json'),JSON.stringify(result),{mode:0o600});
      const review=context.preflightReport||await registerIndependentReview({result,job,candidate:cycle.candidate,probe:context.probe,run:project.run,bridge,methods:context.productionContext.review_methods,referenceProbe:context.referenceProbe,requiredChecks:context.requiredChecks});
      cycle.report=await reviewDeliveryPackage(review,cycle.candidate,project.run,file=>bridge('inspect-media',{file}));
      cycle.reviewJobId=job.id;
      if(!cycle.report.completed)await provisionalPackage(project,cycle.candidate,cycle.report,bridge);
      await writeFile(path.join(project.run,'independent-review.json'),JSON.stringify(cycle.report,null,2));
      if(cycle.report.completed){
        const producer=project.jobs.find(j=>j.id===cycle.candidate.producerJobId);if(!producer)throw Error('缺少原制作任务。');
        job.deliveryId=(await deliver(cycle.candidate,producer)).id;job.status='completed';
        if(project.automatic){project.automatic.status='completed';project.automatic.stage='delivery';}
      }else{
        cycle.terminal='quality_failed';job.status='quality_failed';
        job.error='验收未通过，完整临时交付与问题报告已保留。请确认修订建议后继续，或停止制作保留现有文件。';
        if(project.automatic)project.automatic.status='quality_failed';
      }
    }
    else if(job.action==='discover'){
      if(!Array.isArray(result.sources)||result.sources.length>context.searchLimit)throw new Error(`搜索结果超过本次确认的 ${context.searchLimit} 条上限，请缩小检索范围。`);
      const needs=await materialPlan(project.run,context.brief),sources=await normalizeCandidates(result.sources);
      const review=normalizeReview(result.review,result.sources,sources,{jobId:job.id,query:context.query,topic:project.topic,style:project.styleSelector});
      for(const source of sources){const i=project.sources.findIndex(s=>s.id===source.id);if(i<0)project.sources.push(source);else project.sources[i]=source;}
      project.sourceReview=review;job.sourceIds=sources.map(s=>s.id);job.skill='video-source-tools';
      const folder=path.join(project.run,'source-searches');await mkdir(folder,{recursive:true});job.sourceReport=path.join(folder,job.id+'.json');
      await writeFile(job.sourceReport,JSON.stringify({skill:job.skill,summary:job.summary,material_plan:needs,...review,sources},null,2));
      await library.rememberCandidates(sources,{...review,run:project.run,jobId:job.id});await refreshLibrary();
      await writeFile(path.join(project.run,'selection-review.json'),JSON.stringify(review,null,2));
      await writeFile(path.join(project.run,'material-picker.json'),JSON.stringify({surface:'workbench',jobId:job.id,events:review.events,sources:sources.map(s=>({id:s.id,title:s.title,preview_available:!!s.thumbnailUrl||s.status==='ready'})),recommendations_are_user_selection:false},null,2));
      job.status=sources.length?'completed':'blocked';if(!sources.length)job.error=job.summary;await saveMaterialSelection();
    }
    else if(job.action==='collect'){
      if(!Array.isArray(result.sources)||!result.sources.length){job.status='blocked';job.error=result.summary||'该内容没有找到可采集的媒体。';return;}
      await materialPlan(project.run,context.brief);
      const sources=[];for(const [i,item] of result.sources.entries()){const primary=context.source;const source=await registerMedia(item.localPath,{...primary,...item,candidateCacheId:job.candidateCacheId,sourceType:primary.sourceType==='x_repository'?'x_repository':item.sourceType,url:safeUrl(item.url)||primary.url,id:i===0?primary.id:sourceId({localPath:item.localPath})});sources.push(source);}
      job.sourceIds=sources.map(s=>s.id);if(job.automaticId)project.selected=[...new Set([...project.selected,...job.sourceIds])];await bridge('sync',{run:project.run,brief:brief(project),selectionAuthority:job.automaticId?{kind:'delegated',request:project.automatic?.authorization}:null,sources:sources.map(sourceRecord)});job.status='completed';
    }
    else if(job.action==='plan'){
      await checkSelected();
      const draftPath=path.join(context.jobDirectory,`plan-draft-${job.planRepairAttempts||0}.json`);
      await writeFile(draftPath,JSON.stringify(result,null,2));job.draftPath=draftPath;
      try{await savePlan(result);}catch(validationError){
        if((job.planRepairAttempts||0)>=2)throw validationError;
        job.planRepairAttempts=(job.planRepairAttempts||0)+1;
        const validationMessage=cleanError(validationError.message);
        await writeFile(path.join(context.jobDirectory,`plan-validation-${job.planRepairAttempts}.json`),JSON.stringify({error:validationMessage,draftPath}));
        addEvent(job,'warning',`方案校验未通过，正在自动修正（${job.planRepairAttempts}/2）：${validationMessage}`);
        const repairDirectory=path.join(context.jobDirectory,`repair-${job.planRepairAttempts}`);await mkdir(repairDirectory,{recursive:true});
        const repairedContext={...context,jobDirectory:repairDirectory,planRepair:{draftPath,validationError:validationMessage,attempt:job.planRepairAttempts}};
        const outcome=await new Promise(resolve=>{active.controller=runAgent({codex:runtime.codexPath,job,context:repairedContext,event:(type,message)=>addEvent(job,type,message),onFinish:resolve});});
        return await finishJob(job,repairedContext,outcome);
      }
      if(context.planningState)await savePlanningStage(context,'storyboard',result);
      project.planDraft=null;
      job.status='completed';
    }
    else if(['produce','create'].includes(job.action)){
      job.voiceRequest=project.narration&&result.status==='needs_input'?await normalizeVoiceRequest(result.voiceRequest,job):null;
      if(job.action==='create'&&job.voiceRequest){project.voiceReady=null;if(project.automatic)project.automatic.stage='voice';}
      job.downloadRequest=normalizeDownloadRequest(result);
      job.revisionProposal=result.revisionProposal||null;
      job.editorUrl=cleanEditor(result.editorUrl)||job.editorUrl;job.questions=Array.isArray(result.questions)?result.questions.map(String):[];
      const evidencePending=result.status==='needs_input'&&!job.voiceRequest&&!job.revisionProposal
        &&result.files?.some(f=>f.role==='video')&&result.projectId&&result.timelineId;
      if(result.status!=='exported'&&!evidencePending){job.status=result.status==='needs_input'?'needs_input':'blocked';job.error=job.downloadRequest?'':result.summary||'制片步骤需要处理。';return;}
      if(!project.approval||job.planHash!==project.approval.planHash||job.inputHash!==inputHash(project))throw Error('制作候选缺少当前已校验的制作检查点');
      await bridge('check-approval',{run:project.run,planHash:job.planHash,inputHash:job.inputHash});
      await checkSelected();
      const exported=evidencePending?{...result,status:'exported',qaStatus:'needs_review'}:result;
      const candidate=await bindCandidate(exported,project.run,job,run=>bridge('recover-subtitles',{run})),old=project.qualityCycle;
      candidate.selectedVoice=context.voice?.answers?.findLast(a=>a.action==='select')?.voice||context.voice?.savedVoice||null;
      if(evidencePending){
        await provisionalPackage(project,candidate,null,bridge);
        job.pendingExport=candidate;job.status='needs_input';job.error=result.summary;
        return;
      }
      project.qualityCycle={candidate,repairCount:context.repair?old.repairCount:0,repairCompleted:!!context.repair,repair:context.repair?old.repair:null,report:null,previous:old?.candidate?.inputHash===job.inputHash?{candidate:old.candidate,report:old.report,repair:old.repair}:null};
      await provisionalPackage(project,candidate,null,bridge);
      if(currentRevision(project))project.userRevision.status='candidate_ready';
      if(project.automatic)project.automatic.stage='review';
      await writeFile(path.join(project.run,'quality-cycle.json'),JSON.stringify(project.qualityCycle,null,2));
      job.status='completed';followup={action:'review'};
    }
    addEvent(job,job.status==='completed'?'completed':'warning',job.status==='completed'?'任务结果已校验并保存':job.summary);
  }catch(e){job.status='failed';job.error=e instanceof SyntaxError?'Agent 未返回有效的结构化结果，请查看执行记录并重试。':cleanError(e.message);addEvent(job,'error',job.error);}
  finally{job.completedAt=new Date().toISOString();if(job.candidateCacheId)await library.markAcquisition(job.candidateCacheId,job).catch(e=>library.errors.push({title:'候选采集记录',error:cleanError(e.message)}));await refreshLibrary();await persist().catch(()=>{});if(active?.job.id===job.id)active=null;
    if(!followup)advanceAutomatic(project,job);
    if(job.cancelRequested){if(project.automatic)project.automatic.status='paused';followup=null;}
    if(project.qualityCycle&&project.run)await writeFile(path.join(project.run,'quality-cycle.json'),JSON.stringify(project.qualityCycle,null,2));
    await persist();
    if(followup||project.automatic?.status==='running')queueMicrotask(()=>continuePipeline(followup?{...followup,automaticId:job.automaticId||null}:null).catch(async error=>{if(project.automatic?.status==='running')project.automatic.status='blocked';job.error=cleanError(error.message);addEvent(job,'error',job.error);await persist();}));
  }
}
async function continuePipeline(followup=null){
  const projectId=project.id,automaticId=project.automatic?.id;
  if((!followup||followup.automaticId)&&project.automatic&&project.automatic.status!=='running')return;
  if(active||mutation)return; // A newer user action owns the project; explicit resume retains the checkpoint.
  await exclusive(async()=>{
    if(project.id!==projectId||project.automatic?.id!==automaticId||(!followup||followup.automaticId)&&project.automatic&&project.automatic.status!=='running')return;
    const next=followup||nextAutomatic(project);if(!next||next.action==='delivery')return;
    await startJob(next.action,{...next,automaticId:followup?followup.automaticId:project.automatic?.status==='running'?project.automatic.id:null});
  });
}
async function startAutomatic(options={}){
  if(revisionFeedback(project).questions.length&&!String(options.followup||'').trim())throw Error('有待确认的修订建议，请在“修订与补充反馈”中确认后继续。');
  if(project.narration&&project.voiceReady?.scope!==voiceScope(project)&&!pendingVoiceRequest(project,inputHash(project))){
    const directory=await getCatalog(),saved=savedVoiceChoices({profile:{voice:project.voiceChoice||((project.voiceIntent||'saved')==='saved'?directory.profile?.voice:null)}})[0];
    if(saved)await selectExistingVoice(saved,'saved_catalog');
  }
  beginAutomatic(project);await persist();
  try{
    // A pending user input is shown without starting another model task.
    if(pendingVoiceRequest(project,inputHash(project))){project.automatic.status='needs_input';await persist();return null;}
    const next=nextAutomatic(project);if(!next)throw Error('没有可继续的自动阶段。');
    if(next.action==='delivery'){
      const cycle=project.qualityCycle,candidate=cycle.candidate;
      const producer=project.jobs.find(j=>j.id===candidate.producerJobId);
      if(!producer)throw Error('缺少原制作任务，不能恢复交付。');
      if(candidate.planHash!==project.approval?.planHash||candidate.inputHash!==inputHash(project))throw Error('成片与当前方案不一致，不能恢复交付。');
      await verifyCandidate(candidate,project.run);
      const delivery=await deliver(candidate,producer);
      const review=project.jobs.find(j=>j.id===cycle.reviewJobId);
      if(review){review.deliveryId=delivery.id;review.status='completed';review.error='';}
      project.automatic.stage='delivery';project.automatic.status='completed';
      addEvent(producer,'completed','已复用有效验收结果完成交付，未重新制作或调用验收模型');await persist();return null;
    }
    return await startJob(next.action,{...next,followup:String(options.followup||'').slice(0,4000),automaticId:project.automatic.id});
  }catch(error){if(project.automatic?.status==='running')project.automatic.status='blocked';await persist();throw error;}
}
async function selectExistingVoice(voice,source){
  const saved=await bridge('save-voice',{voice:{...voice,selected_by_user:true}});
  updateSettings(project,{selected:project.selected,voiceChoice:saved.voice});project.voiceDirectoryPending=false;
  project.voiceReady={scope:voiceScope(project),selectedAt:new Date().toISOString(),source};
  if(project.run)await ensureRun();
  if(project.automatic){project.automatic.requestHash=requestHash(project);if(project.automatic.stage==='voice')project.automatic.stage='create';}
  await getCatalog();await persist();
}
function adoptTopic(value){if(!project.topic.trim()&&String(value||'').trim())updateSettings(project,{topic:String(value).trim().slice(0,200),selected:project.selected});}
async function startJob(action,options={}){
  const startGeneration=cancelGeneration;
  assertReady(project,action);
  if(action==='create'&&(!options.automaticId||project.automatic?.id!==options.automaticId))throw Error('连续制作需要当前一键生成授权');
  if(['produce','create'].includes(action))assertCanProduce(project.qualityCycle,project.approval?.planHash,inputHash(project));
  if(options.automaticId&&project.automatic?.id===options.automaticId)project.automatic.stage=action;
  if(action==='discover'){options.searchLimit=validateSearchLimit(options.searchLimit??project.searchLimit??20);options.query=String(options.query||'').trim()||project.topic.trim();if(!options.query)throw new Error('请填写本期主题／想表达的观点，或输入素材关键词。');project.searchLimit=options.searchLimit;}
  if(runtime.preparing)throw preflightError('正在补齐下载依赖，完成并复检后才能开始任务。');
  if(['voice','produce','create'].includes(action)&&pendingVoiceRequest(project,inputHash(project)))throw new Error('请先完成下方音色选择或录音提交。');
  const directCollection=action==='collect'&&canCollectRepository(project.sources.find(s=>s.id===options.sourceId));
  const capabilities=action==='collect'?sourceCapabilities(project.sources.find(s=>s.id===options.sourceId),{direct:directCollection}):action==='discover'?['python','media','downloader']:['plan','produce','create','review','voice','plan_review','curate'].includes(action)?['python','media']:['python'];
  if(directCollection)rememberDependencies(await bridge('preflight',{capabilities}));else await checkLocal(capabilities,['discover','plan','produce','create'].includes(action)?project.styleSelector:null);
  if(!directCollection&&!runtime.compatible)throw preflightError(runtime.error||'请先完成 CLI 兼容检查。');
  requireDependencies([...capabilities,...(['discover','plan','produce','create'].includes(action)?styleCapabilities(project.styleSelector):[])]);
  if(action==='discover'){const query=String(options.query||project.topic).trim();if(!query)throw new Error('请输入要查找的素材关键词。');adoptTopic(query);}
  if(action==='collect'){const source=project.sources.find(s=>s.id===options.sourceId);if(!source)throw new Error('找不到选中的内容。');adoptTopic(source.title);}
  if(action==='plan'){adoptTopic(project.sources.find(s=>project.selected.includes(s.id))?.title);project.workflowVersion=1;project.portraitBottomInset??=.18;project.approval=null;if(project.plan)project.plan.stale=true;if(!project.planningGeneration||project.jobs.find(j=>j.action==='plan')?.status==='completed')project.planningGeneration=randomUUID();}
  const desktopExecution=!directCollection&&desktopAction(action)?await desktop.requireReady():null;
  await ensureRun();
  if(['plan','produce'].includes(action))await checkSelected();
  if(['produce','review'].includes(action))await bridge('check-approval',{run:project.run,planHash:project.approval.planHash,inputHash:inputHash(project)});
  const job={id:randomUUID(),action,requestHash:requestHash(project),sourceId:options.sourceId||null,searchLimit:action==='discover'?options.searchLimit:null,label:taskNames[action],status:'running',startedAt:new Date().toISOString(),events:[],toolCalls:[],inputHash:inputHash(project),planHash:['produce','review'].includes(action)?project.approval?.planHash:null,automaticId:options.automaticId||null,voiceScope:['voice','create'].includes(action)?voiceScope(project):null,voiceIntent:project.voiceIntent||'saved',voiceSelectionId:project.voiceSelectionId||null,execution:{cliPath:runtime.codexPath,cliVersion:runtime.codexVersion,model:runtime.model,reasoningEffort:runtime.reasoningEffort,checkedAt:runtime.checkedAt}};
  if(desktopExecution)Object.assign(job.execution,{backend:'desktop',desktopThreadId:desktopExecution.threadId,desktopTitle:desktopExecution.title,model:desktopExecution.model,reasoningEffort:desktopExecution.reasoningEffort});
  if(directCollection){job.execution='direct_repository';job.usage={input_tokens:0,output_tokens:0};}
  const jobDirectory=path.join(dataDir,'jobs',job.id);job.directory=jobDirectory;await mkdir(jobDirectory,{recursive:true});
  let source=project.sources.find(s=>s.id===options.sourceId)||null;
  if(source && action==='collect'){
    const start=Number(options.start??source.start??0),end=Number(options.end??source.end??0);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<0||(end>0&&end<=start))throw new Error('采集时间范围无效。');
    source={...source,start,end};
  }
  if(action==='collect'){
    const original=project.sources.find(s=>s.id===source.id),known=library.candidates.find(c=>c.url===original.url);
    if(options.candidateCacheId&&options.candidateCacheId!==original.candidateCacheId&&options.candidateCacheId!==candidateId(original))throw new Error('缓存候选与所选来源不一致。');
    const cached=(await library.rememberCandidates([original],{run:project.run,topic:project.topic,style:project.styleSelector,query:project.sourceReview?.query||'',reviewedAt:known?.lastSeenAt||project.sourceReview?.reviewed_at}))[0];
    job.candidateCacheId=options.candidateCacheId||cached?.id||null;if(job.candidateCacheId)await library.markAcquisition(job.candidateCacheId,job);await refreshLibrary();
  }
  const previousProduction=project.jobs.find(j=>['produce','create'].includes(j.action));
  let previousPlanHash=previousProduction?.planHash;
  if(previousProduction&&!previousPlanHash)try{previousPlanHash=JSON.parse(await readFile(path.join(dataDir,'jobs',previousProduction.id,'request.json'),'utf8')).planHash;}catch{}
  const productionMode=previousProduction&&previousProduction.inputHash===inputHash(project)&&previousPlanHash===project.approval?.planHash?'recover':'new';
  let context={taskAction:action,environment:{python:runtime.dependencies?.python,programs:runtime.dependencies?.programs},jobId:job.id,sourceProgressPath:path.join(jobDirectory,'source-progress.json'),productionMode,previousProduction:previousProduction?{id:previousProduction.id,status:previousProduction.status,inputHash:previousProduction.inputHash,planHash:previousPlanHash}:null,pluginRoot:plugin.root,styleMedia:runtime.dependencies?.checks?.filter(c=>styleCapabilities(project.styleSelector).includes(c.id)),run:project.run,jobDirectory,brief:brief(project),settings:{music:project.music,voiceDirection:project.voiceDirection,styleDescription:project.styleDescription},query:String(options.query||project.topic).slice(0,2000),source,knownSources:['discover','collect','curate','create'].includes(action)?project.sources:undefined,sourceReview:project.sourceReview||null,selectedSources:project.sources.filter(s=>project.selected.includes(s.id)),plan:project.plan,planHash:project.approval?.planHash||null,inputHash:inputHash(project),userFollowup:String(options.followup||'').slice(0,4000),outputDirectory:project.outputRoot};
  context.automatic=job.automaticId?project.automatic:null;context.editorial=project.editorial||null;context.preferences=(await getCatalog()).profile?.production_preferences||{};context.advancedOverrides=project.advancedOverrides||{};context.productionContext=await bridge('production-context',{run:project.run});
  if(['discover','create'].includes(action))Object.assign(context,searchContext(project,options,library));
  if(action==='create'||action==='produce'&&job.automaticId){
    context.knownSources=project.sources;
    context.searchLimit=undefined;context.sourceReview=null;
    context.cachedCandidates=(context.cachedCandidates||[]).slice(0,16);
    context.workingDraft=project.plan?.file||null;if(project.plan?.stale)context.plan=null;
    context.creativeId=project.automatic.id;context.approval=project.approval?.inputHash===inputHash(project)&&!project.plan?.stale?project.approval:null;
    job.planHash=context.approval?.planHash||null;
    context.productionCheckpointPath=path.join(jobDirectory,'production-checkpoint.json');
    context.productionCheckpointResultPath=path.join(jobDirectory,'production-checkpoint-result.json');
    context.productionCheckpointSchemaPath=path.join(jobDirectory,'production-checkpoint.schema.json');
    context.referenceProbe=await bridge('prepare-reference',{run:project.run});
  }
  if(action==='plan')context.planGeneration=project.planningGeneration;
  if(action==='collect'){
    const acquired=[...new Map(project.sources.filter(s=>s.status==='ready'&&s.kind==='video'&&s.sha256!==source.expectedSha256).map(s=>[s.sha256,s])).values()];
    context.acquisitionUsage={videoSources:acquired.length,videoSeconds:acquired.reduce((sum,s)=>sum+s.duration,0)};
    context=scopedCollectionContext(context);
  }
  if(['produce','create','voice'].includes(action)){
    job.productionStage='preparing';
    const runRecord=JSON.parse(await readFile(path.join(context.run,'run.json'),'utf8'));
    const recorded=runRecord.project;
    if(currentRevision(project)&&action==='create'){context.userRevision=currentRevision(project);context.creativeId=context.userRevision.creativeId||context.creativeId;context.revisionDelta=reviewDelta(project);}
    if(recorded?.planHash===context.planHash&&recorded?.inputHash===context.inputHash||action==='create'&&recorded?.creativeId===context.creativeId){context.existingProject={projectId:recorded.projectId,timelineId:recorded.timelineId,editorUrl:cleanEditor(recorded.editorUrl)};job.editorUrl=context.existingProject.editorUrl;if(action==='create')context.productionMode='recover';}
    if(action==='create'&&currentRevision(project)&&recorded?.projectId){context.existingProject={projectId:recorded.projectId,timelineId:recorded.timelineId,editorUrl:cleanEditor(recorded.editorUrl)};context.productionMode='recover';job.editorUrl=context.existingProject.editorUrl;}
    const currentCatalog=await getCatalog();
    context.voice=voiceContext(project,inputHash(project),(project.voiceIntent||'saved')==='saved'?currentCatalog.profile?.voice:null);
    if(action==='voice'&&['official','create'].includes(project.voiceIntent)&&!context.voice.answers.length)context.voice.savedVoice=null;
    if(action==='voice'&&project.voiceIntent==='custom'&&context.voice.savedVoice?.voiceType!=='custom')context.voice.savedVoice=null;
    if(action==='voice'&&(project.voiceDirectoryPending||['official','clone','recording'].includes(context.voice.answers.at(-1)?.action)))context.voice.savedVoice=null;
    if(action==='produce'&&project.qualityCycle?.repair&&project.qualityCycle.candidate.planHash===context.planHash&&project.qualityCycle.candidate.inputHash===context.inputHash){context.repair=project.qualityCycle.repair;context.productionMode='recover';}
    if(['produce','create'].includes(action)){
      const previous=project.jobs.find(j=>j.id!==job.id&&['create','produce'].includes(j.action)
        &&j.inputHash===job.inputHash&&j.planHash===project.approval?.planHash&&j.status!=='failed');
      if(previous?.status==='needs_input'&&previous.pendingExport){
        await verifyCandidate(previous.pendingExport,project.run);context.pendingExport=previous.pendingExport;
      }
    }
    for(const answer of context.voice.answers)if(answer.recording){const file=await contained(answer.recording.path,path.join(project.run,'voice-references'));if(await fileHash(file)!==answer.recording.sha256)throw new Error('已提交的音色录音发生变化，请恢复原录音后继续。');}
    await unlink(path.join(project.run,'workbench-cancelled.json')).catch(()=>{});await unlink(path.join(project.run,'workbench-progress.json')).catch(()=>{});}
  if(['create','produce'].includes(action)&&project.narration){
    context.narrationEndpoint={url:'http://127.0.0.1:'+port+'/api/narration',token:randomUUID()};
  }
  if(action==='review'){
    const candidate=project.qualityCycle?.candidate;await verifyCandidate(candidate,project.run);
    if(candidate.inputHash!==inputHash(project)||candidate.planHash!==project.approval?.planHash)throw Error('成片与当前确认方案不一致。');
    const lastReview=project.jobs.find(j=>j.id!==job.id&&j.action==='review'&&j.planHash===candidate.planHash&&j.inputHash===candidate.inputHash);
    if(lastReview?.status==='failed')context.interruptedReview={id:lastReview.id,threadId:lastReview.threadId,directory:lastReview.directory,summary:lastReview.summary};
    context.candidate=candidate;context.reviewDelta=reviewDelta(project);context.referenceProbe=await bridge('prepare-reference',{run:project.run});
    job.productionStage='reviewing';
  }
  if(startGeneration!==cancelGeneration)throw Error('任务在准备期间已取消。');
  project.jobs.unshift(job);rememberUsage(project);project.jobs=project.jobs.slice(0,50);active={job,controller:null};addEvent(job,'queued',directCollection?'正在直接采集所选仓库媒体并校验固定版本':['discover','collect'].includes(action)?'网页已提交任务，正在加载插件的素材采集工具及适用来源规则':'网页已提交任务，正在加载 Video Studio 与 ChatCut 插件');await persist();
  const agentOptions={codex:runtime.codexPath,job,context,event:(type,message)=>addEvent(job,type,message),onSourceProgress:snapshot=>saveSourceProgress(job,context,snapshot),onProductionCheckpoint:context.productionCheckpointPath?value=>adoptProductionCheckpoint(job,context,value):null,onFinish:value=>finishJob(job,context,value)};
  active.controller=directCollection?runRepositoryCollection(job,context):action==='review'?runReviewAgent(agentOptions):action==='plan'?runPlanningAgent({...agentOptions,runAgent,onCheckpoint:async(stage,result)=>{
    if(stage==='script')job.planDraft=project.planDraft={inputHash:context.inputHash,title:result.title,script:result.script,summary:result.summary,gaps:result.gaps,limitations:result.limitations,savedAt:new Date().toISOString()};
    await persist();
  }}):runAgent(agentOptions);return job;
}
function runReviewAgent(options){
  let child,cancelled=false;const {job,context}=options;
  const controller={cancel(reason='user'){cancelled=true;job.cancelRequested=true;job.stopReason=reason;child?.cancel(reason);}};
  (async()=>{
    addEvent(job,'verification','正在全片解码、抽帧并测量音频；完成后交给独立验收 Agent');
    const candidate=context.candidate;
    const file=candidate.files.find(f=>f.role==='video'),subtitles=candidate.files.find(f=>f.role==='subtitles');
    const last=context.interruptedReview;
    if(last){
      const audit=await bridge('review-audit',{run:context.run,file:file.path,subtitles:subtitles?.path});
      const recovered=await recoverFailedReview(audit,last,candidate,context.run);
      if(recovered&&!cancelled){
        context.preflightReport=recovered;
        addEvent(job,'verification','已恢复同一成片上独立验收员登记的问题，未重新启动模型。');
        await options.onFinish({code:0,finalText:JSON.stringify({summary:last.summary,checks:[],limitations:recovered.limitations})});return;
      }
    }
    context.probe=await bridge('prepare-review',{run:context.run,file:candidate.files.find(f=>f.role==='video').path,subtitles:candidate.files.find(f=>f.role==='subtitles')?.path,selectedVoice:candidate.selectedVoice,directory:path.join(context.run,'review-probes',job.id)});
    if(cancelled){await options.onFinish({code:1,error:'验收已停止',finalText:''});return;}
    context.requiredChecks=context.probe.required_checks;
    const prepared=await prepareReviewPacket(context,file=>bridge('inspect-media',{file}));
    context.reviewPacket={file:prepared.file,sha256:prepared.sha256};
    if(prepared.report){
      context.preflightReport=prepared.report;
      addEvent(job,'verification','客观预检发现未解决问题，已生成具体修复清单；不启动重复的模型验收');
      await options.onFinish({code:0,finalText:JSON.stringify({summary:'验收预检未通过，具体问题已写入报告。',checks:[],limitations:[]})});return;
    }
    addEvent(job,'verification','客观预检通过，独立验收将优先核对修复差异并覆盖当前全片');
    child=runAgent(options);
  })().catch(error=>options.onFinish({code:1,error:error.message,finalText:''}));
  return controller;
}
function runRepositoryCollection(job,context){
  const abort=new AbortController();
  const controller={cancel(reason='user'){job.cancelRequested=true;job.stopReason=reason;abort.abort();}};
  const timer=setTimeout(()=>controller.cancel('timeout'),180000);
  job.execution='direct_repository';
  (async()=>{
    let outcome;
    try{
      await writeFile(path.join(context.jobDirectory,'request.json'),JSON.stringify(context,null,2));
      await bridge('prepare-collection',{run:context.run,source:context.source});
      const result=await collectRepository(context,{signal:abort.signal,event:(type,message)=>addEvent(job,type,message),
        inspect:file=>bridge('inspect-media',{file}),
        decode:async file=>execute(await nativeMediaTool('ffmpeg'),['-v','error','-xerror','-i',file,'-f','null','-'],{timeout:60000,signal:abort.signal}),
        reuse:async source=>{const entry=library.entries.find(e=>e.sha256===source.expectedSha256&&e.bytes===source.expectedBytes);return entry?(await library.resolve(entry.id)).file:null;}});
      outcome={code:0,finalText:JSON.stringify(result)};
    }catch(e){abort.abort();outcome={code:1,error:cleanError(e.message)};}
    finally{clearTimeout(timer);}
    await finishJob(job,context,outcome);
  })().catch(e=>{job.status='failed';job.error=cleanError(e.message);job.completedAt=new Date().toISOString();if(active?.job.id===job.id)active=null;persist().catch(()=>{});});
  return controller;
}
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
async function body(req){let text='';for await(const block of req){text+=block;if(text.length>512000)throw new Error('请求内容过大。');}return JSON.parse(text||'{}');}
function libraryState(){return {entries:libraryEntries,candidates:libraryCandidates,repositorySync:library.repositorySync||null,errors:library.errors.slice(-20)};}
function publicState(){return {readOnly:historicalProject(project),feedback:revisionFeedback(project),project,projects:projectStore.list(project.id),runtime,desktop:desktop.state(),catalog:{savedVoice:catalog.profile?.voice||null,savedVoices:catalog.savedVoices||[],version:catalog.version,styles:catalog.styles.options,styleErrors:catalog.styles.errors,styleBrowser:catalog.styleBrowser},library:libraryState(),activeJobId:active?.job.id||null,busy:!!active||mutation};}
async function openFolder(directory){directory=await realpath(directory);if(![...project.deliveries,...(project.provisionalDeliveries||[])].some(d=>d.directory===directory) && directory!==await realpath(project.outputRoot))throw new Error('只能打开本项目的输出文件夹。');const command=process.platform==='darwin'?['open',[directory]]:process.platform==='win32'?['explorer.exe',[directory]]:['xdg-open',[directory]];await execute(command[0],command[1],{timeout:10000});}
async function openMaterialFolder(id){const source=project.sources.find(s=>s.id===id&&s.status==='ready');if(!source)throw new Error('请选择已经采集的素材。');const directory=path.dirname(await contained(source.localPath,project.run));const command=process.platform==='darwin'?['open',[directory]]:process.platform==='win32'?['explorer.exe',[directory]]:['xdg-open',[directory]];await execute(command[0],command[1],{timeout:10000});}
const historyActions=new Set(['/api/projects/switch','/api/reset','/api/open-folder','/api/open-material-folder','/api/library/open-folder','/api/runtime/check','/api/catalog/refresh','/api/desktop/configure']);
function rejectsHistoricalWrite(route){return historicalProject(project)&&!historyActions.has(route);}
const historyMessage='历史项目为只读。可以查看、下载已有文件，或新建项目制作。';
const server=http.createServer(async(req,res)=>{
  try{
    const host=req.headers.host;if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return send(res,403,{error:'仅接受本机访问。'});
    const url=new URL(req.url,'http://'+host),route=url.pathname;
    if(req.method==='POST' && (req.headers['x-video-demo']!=='1'||(req.headers.origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(req.headers.origin))))return send(res,403,{error:'请求来源无效。'});
    if(req.method==='POST' && req.headers['x-video-project'] && req.headers['x-video-project']!==project.id)return send(res,409,{error:'当前项目已在其他页面切换。请刷新后再操作，待保存的内容仍留在此页面。'});
    if(req.method==='POST'&&rejectsHistoricalWrite(route))return send(res,409,{error:historyMessage});
    if(req.method==='GET' && route==='/api/health')return send(res,200,{app:'video-studio-workbench',version:plugin.version,dataDirectory:dataDir,workingDirectory:process.cwd(),runtimeIdentity});
    if(req.method==='GET' && route==='/api/state'){await refreshLibrary();return send(res,200,publicState());}
    if(req.method==='GET' && route==='/api/desktop/sessions')return send(res,200,{sessions:await desktop.list()});
    if(req.method==='GET' && route==='/api/projects')return send(res,200,{projects:projectStore.list(project.id),errors:projectStore.errors});
    if(req.method==='GET' && route==='/api/library'){await refreshLibrary();return send(res,200,libraryState());}
    if(['GET','HEAD'].includes(req.method) && route.startsWith('/api/library/media/')){try{const {entry,file}=await library.resolve(route.split('/').pop(),url.searchParams.has('thumbnail'));return await streamFile(req,res,file,{download:url.searchParams.has('download'),name:path.basename(entry.localPath)});}catch(e){return send(res,404,{error:cleanError(e.message)});}}
    if(req.method==='GET' && route==='/api/source-skill'){const folder=path.join(plugin.root,'skills/video-source-tools');const skill=await readFile(path.join(folder,'SKILL.md'),'utf8');const names=[...new Set([...skill.matchAll(/\]\(references\/([a-z0-9-]+\.md)\)/g)].map(m=>m[1]))];const references=await Promise.all(names.map(async name=>({name,text:await readFile(path.join(folder,'references',name),'utf8')})));return send(res,200,{skill,references});}
    if(req.method==='GET' && route==='/api/styles/detail')return send(res,200,await bridge('style-details',{key:url.searchParams.get('key')}));
    if(req.method==='GET' && route==='/api/styles/reference')return send(res,200,await bridge('style-reference',{key:url.searchParams.get('key'),referenceId:url.searchParams.get('id')}));
    if(req.method==='GET' && route.startsWith('/api/jobs/')){const job=project.jobs.find(j=>j.id===route.split('/').pop());return send(res,job?200:404,job||{error:'任务不存在。'});}
    if(['GET','HEAD'].includes(req.method) && route.startsWith('/api/source-reports/')){const job=project.jobs.find(j=>j.id===route.split('/').pop());if(!job?.sourceReport)return send(res,404,{error:'检索记录不存在。'});return await streamFile(req,res,await contained(job.sourceReport,project.run),{download:true,name:'material-search-'+job.id.slice(0,8)+'.json'});}
    if(['GET','HEAD'].includes(req.method) && route.startsWith('/api/media/')){const source=project.sources.find(s=>s.id===route.split('/').pop());if(!source||source.status!=='ready')return send(res,404,{error:'素材尚未采集完成。'});const file=url.searchParams.has('thumbnail')?source.thumbnailPath:source.localPath;if(!file)return send(res,404,{error:'暂无预览。'});return await streamFile(req,res,await contained(file,project.run),{download:url.searchParams.has('download')});}
    if(['GET','HEAD'].includes(req.method) && route.startsWith('/api/files/')){const id=route.split('/').pop();let delivery,file;for(const d of [...project.deliveries,...(project.provisionalDeliveries||[])]){const found=d.files.find(f=>f.id===id);if(found){delivery=d;file=found;break;}}if(!file)return send(res,404,{error:'交付文件不存在。'});return await streamFile(req,res,await contained(file.path,delivery.directory),{download:url.searchParams.has('download'),name:file.name});}
    if(req.method==='POST' && route==='/api/voice/recording')return await exclusive(async()=>{
      const payload=JSON.parse(decodeURIComponent(req.headers['x-voice-intake']||''));
      const request=requireVoiceRequest(project,inputHash(project),payload.requestId),answer=voiceAnswer(request,{...payload,action:'recording'});
      await checkMedia();
      const recording=await saveVoiceRecording(req,{name:url.searchParams.get('name')||'',run:await ensureRun(),inspect:file=>bridge('inspect-media',{file})});
      recordVoiceAnswer(project,request,{...answer,recording});await persist();return send(res,201,{ok:true});
    });
    if(req.method==='POST' && route==='/api/upload')return await exclusive(async()=>{const name=path.basename(url.searchParams.get('name')||'');const ext=path.extname(name).toLowerCase();if(!mediaExtensions.has(ext))throw new Error('请上传视频、图片或音频文件。');await checkMedia();adoptTopic(name);await ensureRun();const file=path.join(project.run,'materials',randomUUID()+ext);await saveUpload(req,file);const source=await registerMedia(file,{title:name,description:'用户上传的本地素材',rights:'user_provided'});await persist();return send(res,201,{source});});
    if(req.method==='POST'){
      if(!/^application\/json/.test(req.headers['content-type']||''))return send(res,415,{error:'需要 JSON 请求。'});const payload=await body(req);
      if(req.headers['x-video-project'] && req.headers['x-video-project']!==project.id)return send(res,409,{error:'当前项目已在其他页面切换，请刷新后再操作。'});
      if(rejectsHistoricalWrite(route))return send(res,409,{error:historyMessage});
      if(route==='/api/narration'){
        const job=active?.job;
        if(!job||!['create','produce'].includes(job.action)||job.id!==payload.jobId||!project.narration)throw Error('需要当前制作任务。');
        const request=JSON.parse(await readFile(path.join(job.directory,'request.json'),'utf8'));
        if(!request.narrationEndpoint?.token||payload.token!==request.narrationEndpoint.token)throw Error('配音请求不属于当前任务。');
        const voice=request.voice.answers.findLast(a=>a.action==='select')?.voice||request.voice.savedVoice;
        if(!voice?.selected_by_user)throw Error('请先在工作台选择具体音色。');
        const check=async()=>{
          if(active?.job!==job||job.cancelRequested||!job.planHash||job.planHash!==project.approval?.planHash||job.inputHash!==inputHash(project))throw Error('制作已暂停或方案已变化。');
          await bridge('check-approval',{run:project.run,planHash:job.planHash,inputHash:job.inputHash});
          if(active?.job!==job||job.cancelRequested)throw Error('配音提交已停止。');
        };
        await check();
        const record=JSON.parse(await readFile(path.join(project.run,'run.json'),'utf8')).project;
        if(!record?.projectId||!record.timelineId||record.planHash!==job.planHash||record.inputHash!==job.inputHash)throw Error('请先登记当前已批准工程和时间线。');
        const result=await submitNarration({codex:runtime.codexPath,cwd:project.run,voice,request:payload.arguments,project:record,assertCurrent:check});
        if(active?.job!==job)return send(res,200,result);
        job.toolCalls.push({server:'chatcut',tool:'submit_voice',status:'completed',source:'locked_workbench_voice'});
        addEvent(job,'tool','已用本期选定音色提交旁白');
        return send(res,200,result);
      }
      if(route==='/api/feedback'){
        if(payload.projectId!==project.id)throw Error('当前项目已变化，请刷新');
        const feedback=String(payload.feedback??'');if(feedback.length>12000)throw Error('反馈最多 12000 字');
        project.feedbackDraft=feedback;await persist();return send(res,200,{saved:true});
      }
      if(route==='/api/cancel'){cancelGeneration++;if(project.automatic)project.automatic.status='paused';if(active){active.job.status='cancelling';active.job.cancelRequested=true;await writeFile(path.join(project.run,'workbench-cancelled.json'),JSON.stringify({jobId:active.job.id,time:new Date().toISOString()}));active.controller?.cancel();}await persist();return send(res,200,{ok:true});}
      if(route==='/api/open-folder'){if(!historicalProject(project))await mkdir(project.outputRoot,{recursive:true});await openFolder(payload.directory||project.outputRoot);return send(res,200,{ok:true});}
      if(route==='/api/open-material-folder'){await openMaterialFolder(payload.sourceId);return send(res,200,{ok:true});}
      if(route==='/api/library/open-folder'){const {file}=await library.resolve(payload.id);const directory=path.dirname(file),command=process.platform==='darwin'?['open',[directory]]:process.platform==='win32'?['explorer.exe',[directory]]:['xdg-open',[directory]];await execute(command[0],command[1],{timeout:10000});return send(res,200,{ok:true});}
      if(route==='/api/choose-folder'){if(process.platform!=='darwin')throw new Error('当前系统请直接填写输出文件夹的完整路径。');const result=await execute('osascript',['-e','POSIX path of (choose folder with prompt "选择视频输出文件夹")'],{timeout:180000});return send(res,200,{directory:result.stdout.trim()});}
      return await exclusive(async()=>{
        if(route==='/api/library/sync-repository'){rememberDependencies(await bridge('preflight',{capabilities:['python','repository']}));requireDependencies(['python','repository']);
          const {sources,coverage}=await repositoryCatalog();
          await library.rememberCandidates(sources,{query:'每日仓库完整目录',reviewedAt:coverage.checkedAt});
          library.repositorySync=coverage;await library.persist();await refreshLibrary();return send(res,200,libraryState());
        }
        if(route==='/api/library/collect'){
          const candidate=library.candidates.find(c=>c.id===payload.candidateId);if(!candidate)throw new Error('缓存候选不存在。');
          const start=Number(payload.start??candidate.start??0),end=Number(payload.end??candidate.end??0);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<0||(end>0&&end<=start))throw new Error('采集时间范围无效。');
          await refreshLibrary();if(libraryCandidates.find(c=>c.id===candidate.id)?.localCacheIds.length)return send(res,200,{reused:true,...publicState()});
          if(!project.topic.trim())updateSettings(project,{topic:candidate.title,selected:project.selected});
          const source=(await normalizeCandidates([candidate]))[0];
          if(source.status==='ready'){await cacheMedia(source);if(source.cacheStatus!=='saved')throw new Error(source.cacheError);await persist();return send(res,200,{reused:true,...publicState()});}
          const index=project.sources.findIndex(s=>s.id===source.id);if(index<0)project.sources.push(source);else project.sources[index]=source;
          await persist();const job=await startJob('collect',{sourceId:source.id,candidateCacheId:candidate.id,...(payload.start!==undefined?{start:payload.start}:{}),...(payload.end!==undefined?{end:payload.end}:{})});return send(res,202,{job});
        }
        if(route==='/api/library/use'){
          const {entry,file}=await library.resolve(payload.id);await checkMedia();adoptTopic(entry.title);await ensureRun();
          let source=project.sources.find(s=>s.status==='ready'&&s.sha256===entry.sha256);
          if(source){if(await fileHash(await contained(source.localPath,project.run))!==source.sha256)throw new Error('本期同一素材已经变化，请重新采集。');}
          else{
            const destination=path.join(project.run,'materials',randomUUID()+path.extname(file));await mkdir(path.dirname(destination),{recursive:true});await copyFile(file,destination);
            const candidate=project.sources.find(s=>s.status!=='ready'&&s.url&&s.url===entry.url);
            source=await registerMedia(destination,{...entry,id:candidate?.id||'s-'+randomUUID().slice(0,12)});
          }
          updateSettings(project,{selected:[...new Set([...project.selected,source.id])]});await ensureRun();await persist();return send(res,200,{source,...publicState()});
        }
        if(route==='/api/project'){const previousRequest=requestHash(project),previousVoiceScope=voiceScope(project),oldStyle=project.styleSelector;updateSettings(project,validateSettings(payload,catalog.styles.options));if(oldStyle!==project.styleSelector)rememberDependencies(await bridge('preflight',{capabilities:['git_lfs',...styleMediaChecks],styleSelector:project.styleSelector}));if(requestHash(project)!==previousRequest){project.automatic=null;project.editorial=null;}if(voiceScope(project)!==previousVoiceScope)project.voiceReady=null;await saveMaterialSelection();await persist();return send(res,200,{project});}
        if(route==='/api/desktop/configure'){if(payload.acknowledged!==true)throw Error('请阅读桌面会话配置说明。');return send(res,200,{desktop:await desktop.configure(payload.threadId)});}
        if(route==='/api/runtime/check'){await checkLocal();return send(res,200,{runtime});}
        if(route==='/api/runtime/prepare'){
          requireDependencies(['python']);
          if(!runtime.dependencies?.checks?.some(check=>check.id==='downloader'&&check.canPrepare))return send(res,200,{runtime});
          if(runtime.preparing)return send(res,202,{runtime});
          runtime.preparing=true;runtime.preparationError=null;
          bridge('bootstrap').then(()=>checkLocal()).catch(error=>{runtime.preparationError=cleanError(error.message);}).finally(()=>{runtime.preparing=false;runtime.preparedAt=new Date().toISOString();});
          return send(res,202,{runtime});
        }
        if(route==='/api/catalog/refresh'){await checkLocal();await getCatalog();return send(res,200,publicState());}
        if(route==='/api/styles/select'){const previousRequest=requestHash(project),result=await bridge('style-select',{key:payload.key});await getCatalog();updateSettings(project,validateSettings({...project,styleSelector:result.selector},catalog.styles.options));if(requestHash(project)!==previousRequest){project.automatic=null;project.editorial=null;}rememberDependencies(await bridge('preflight',{capabilities:['git_lfs',...styleMediaChecks],styleSelector:project.styleSelector}));await persist();return send(res,200,{...publicState(),selection:result});}
        if(route==='/api/styles/import'){if(typeof payload.path!=='string'||!path.isAbsolute(payload.path))throw new Error('请填写风格包 manifest.json 的完整路径。');const result=await execute(process.env.VIDEO_STUDIO_PYTHON||'python3',[path.join(plugin.root,'scripts/studio.py'),'styles','import','--file',payload.path],{timeout:30000,maxBuffer:1024*1024});await getCatalog();return send(res,200,{result:JSON.parse(result.stdout),catalog:catalog.styles});}
        if(route==='/api/sources/url'){const sourceUrl=await publicUrl(payload.url);const entry={id:sourceId({url:sourceUrl}),title:String(payload.title||new URL(sourceUrl).hostname).slice(0,300),kind:'article',url:sourceUrl,mediaUrl:'',thumbnailUrl:'',description:'用户添加的内容链接',rights:'unknown',status:'candidate',start:0,end:0};if(!project.sources.some(s=>s.id===entry.id))project.sources.unshift(entry);await library.rememberCandidates([entry],{run:project.run,topic:project.topic,style:project.styleSelector,query:'手动添加链接'});await refreshLibrary();await persist();return send(res,201,{source:project.sources.find(s=>s.id===entry.id)});}
        if(route==='/api/sources/local'){let file=String(payload.path||'');if(file.startsWith('~/'))file=path.join(os.homedir(),file.slice(2));if(!path.isAbsolute(file))throw new Error('请输入本地素材绝对路径。');file=await realpath(file);const ext=path.extname(file).toLowerCase();if(!mediaExtensions.has(ext))throw new Error('请选择媒体文件。');if((await stat(file)).size>350*1024*1024)throw new Error('单个素材需小于 350 MB。');await checkMedia();adoptTopic(path.basename(file));await ensureRun();const destination=path.join(project.run,'materials',randomUUID()+ext);await mkdir(path.dirname(destination),{recursive:true});await copyFile(file,destination);const source=await registerMedia(destination,{title:path.basename(file),rights:'user_provided',description:'用户选择的本地文件'});await persist();return send(res,201,{source});}
        if(route==='/api/plan'){await ensureRun();await checkSelected();await savePlan(payload.plan);await persist();return send(res,200,{plan:project.plan});}
        if(route==='/api/approve'){if(!project.plan||project.plan.stale||project.plan.gaps.length)throw new Error('请先更新方案并解决素材缺口。');await checkSelected();if(payload.planHash!==project.plan.planHash||project.plan.inputHash!==inputHash(project))throw new Error('方案或素材已经变化，请重新审阅。');const authority=approvalAuthority(payload.authority);const approved=await bridge('approve',{run:project.run,planHash:project.plan.planHash,inputHash:inputHash(project),authority});project.approval={status:'confirmed',planHash:approved.file_sha256,inputHash:approved.input_hash,version:approved.version,confirmedAt:approved.confirmed_at,authority:approved.authority};await persist();return send(res,200,{approval:project.approval});}
        if(route==='/api/voice/start'){
          const intent=payload.intent||'saved';if(!['saved','official','custom','create'].includes(intent))throw Error('请选择已保存、官方或克隆音色。');
          const directory=await getCatalog(),preferred=savedVoiceChoices({profile:{voice:project.voiceChoice||directory.profile?.voice}})[0];
          const choices=payload.refresh===true||intent==='create'?[]:savedVoiceChoices(directory,intent);
          project.voiceSelectionId=randomUUID();updateSettings(project,{selected:project.selected,voiceIntent:intent,voiceChoice:null});project.automatic=null;project.voiceReady=null;project.voiceSelectionRequest=null;project.voiceDirectoryPending=false;
          if(intent==='saved'&&preferred&&payload.refresh!==true){await selectExistingVoice(preferred,'saved_catalog');return send(res,200,{ready:true,job:null});}
          if(choices.length){project.voiceSelectionRequest=savedVoiceRequest(project,choices,inputHash(project));await persist();return send(res,200,{ready:false,job:null});}
          if(intent==='create'||intent==='custom'&&payload.refresh!==true){
            project.voiceSelectionRequest={...savedVoiceRequest(project,[],inputHash(project)),kind:'clone_recording',message:'录音先保存到本机；点击一键生成后检查创建资格，再执行克隆。'};
          }else project.voiceDirectoryPending=true;
          await persist();return send(res,200,{ready:false,job:null,pending:project.voiceDirectoryPending?'directory':'recording'});
        }
        if(route==='/api/voice/answer'){
          const request=requireVoiceRequest(project,inputHash(project),payload.requestId);if(payload.action==='recording')throw new Error('请使用录音上传入口。');
          const answer=voiceAnswer(request,payload),direct=answer.action==='select'&&!!request.voiceScope;
          if(direct){if(request.source!=='saved_catalog'&&!project.jobs.some(j=>j.voiceRequest?.id===request.id&&j.toolCalls?.some(t=>/voice/.test(t.tool)&&t.status==='completed')))throw Error('缺少实际音色目录查询记录，请在开始制作时重新查询。');await selectExistingVoice(answer.voice,request.source||'queried_catalog');}
          recordVoiceAnswer(project,request,answer);
          if(request.voiceScope&&['clone','official'].includes(answer.action)){
            if(answer.action==='clone')project.voiceSelectionRequest={...savedVoiceRequest(project,[],inputHash(project)),kind:'clone_recording',message:'录音先保存本机，开始制作后执行克隆。'};
            else project.voiceDirectoryPending=true;
          }
          if(direct){const job=project.jobs.find(j=>j.action==='voice'&&j.voiceRequest?.id===request.id);if(job){job.status='completed';job.error='';job.summary='已选用指定音色';addEvent(job,'completed','音色已由用户选择并保存，无需再次查询');}}await persist();return send(res,200,{ok:true,ready:direct});
        }
        if(route==='/api/revision/confirm'){
          // Preserve the current export before its approval/cycle is superseded.
          if(payload.projectId!==project.id||payload.token!==revisionFeedback(project).token)throw Error('修订建议或项目已变化，请刷新后重新确认。');
          if(project.qualityCycle?.candidate)await provisionalPackage(project,project.qualityCycle.candidate,project.qualityCycle.report,bridge);
          confirmRevision(project,payload);project.mode='automatic';project.userRevision.requestHash=requestHash(project);await persist();
          const job=await startAutomatic({followup:project.userRevision.request});return send(res,202,{job});
        }
        if(route==='/api/provisional'){
          const candidate=project.qualityCycle?.candidate;if(!candidate)throw Error('当前没有实际导出的视频');
          const delivery=await provisionalPackage(project,candidate,project.qualityCycle.report,bridge);await persist();return send(res,200,{delivery});
        }
        if(route==='/api/jobs'){if(project.mode==='automatic'&&payload.action!=='auto'&&!project.automatic)throw Error('一键模式只在点击一键生成后启动 Codex。');const job=payload.action==='auto'?await startAutomatic(payload):await startJob(payload.action,payload);return send(res,202,{job});}
        if(route==='/api/projects/switch'){const next=projectStore.load(payload.projectId);for(const job of next.jobs)if(!historicalProject(next)&&['running','cancelling'].includes(job.status)){job.status='interrupted';job.error='该项目的本地会话已结束；继续前应核对已有远端任务。';}await activateProject(next);rememberDependencies(await bridge('preflight',{capabilities:['git_lfs',...styleMediaChecks],styleSelector:project.styleSelector}));return send(res,200,publicState());}
        if(route==='/api/reset'){const next=initialStudio();next.outputRoot=project.outputRoot;await activateProject(next);rememberDependencies(await bridge('preflight',{capabilities:['git_lfs',...styleMediaChecks],styleSelector:project.styleSelector}));return send(res,200,publicState());}
        return send(res,404,{error:'没有此操作。'});
      });
    }
    const files={'/revision-ui.js':'revision-ui.js','/duration.js':'duration.js','/desktop-setup.js':'desktop-setup.js','/':'index.html','/app.js':'app.js','/dependency-view.js':'dependency-view.js','/planning-view.js':'planning-view.js','/voice-ui.js':'voice-ui.js','/style-plan-view.js':'style-plan-view.js','/production-plan.js':'production-plan.js','/material-dates.js':'material-dates.js','/token-usage.js':'token-usage.js','/token-usage-view.js':'token-usage-view.js','/styles.css':'styles.css','/theme.js':'theme.js','/themes.css':'themes.css'};
    if(req.method==='GET' && files[route]){const file=files[route];res.writeHead(200,{'Content-Type':({html:'text/html',js:'text/javascript',css:'text/css'})[file.split('.').pop()]+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https:; media-src 'self' blob: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});return res.end(await readFile(path.join(root,'public',file)));}
    send(res,404,{error:'页面不存在。'});
  }catch(e){if(res.headersSent){res.destroy();return;}send(res,/已有操作/.test(e.message)?409:400,{error:cleanError(e.message),...(e.code==='preflight_failed'?{code:e.code,runtime}:{})});}
});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`端口 ${port} 已被占用，请关闭旧工作台后启动。`:e.message);process.exitCode=1;});
// Reattach a desktop job before accepting another operation; never queue it again.
const recovering=!historicalProject(project)&&project.jobs.find(j=>['running','cancelling'].includes(j.status)&&j.execution?.backend==='desktop');
if(recovering){
  active={job:recovering,controller:null};
  try{const context=JSON.parse(await readFile(path.join(dataDir,'jobs',recovering.id,'request.json'),'utf8'));
    if(context.jobId!==recovering.id||context.run!==project.run)throw Error('恢复上下文与当前项目不一致');
    active.controller=runDesktopAgent({codex:runtime.codexPath,reader:desktop.reader(),job:recovering,context,restore:true,event:(type,message)=>addEvent(recovering,type,message),onSourceProgress:snapshot=>saveSourceProgress(recovering,context,snapshot),onProductionCheckpoint:context.productionCheckpointPath?value=>adoptProductionCheckpoint(recovering,context,value):null,onFinish:value=>finishJob(recovering,context,value)});
  }catch(error){addEvent(recovering,'warning','无法自动恢复桌面状态：'+error.message+'。请在桌面确认停止后再恢复，工作台暂不接受新任务。');}
}
server.listen(port,'127.0.0.1',()=>{console.log(`Video Agent Demo: http://127.0.0.1:${port}`);console.log(`Video Studio ${plugin.version} · ${runtime.authenticated?'Codex 已登录':'请登录 Codex'}`);});
function shutdown(){if(active?.job.execution?.backend==='desktop'){active.controller?.detach();persist().catch(()=>{});}else{if(active){active.job.status='interrupted';persist().catch(()=>{});}active?.controller?.cancel();}desktop.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
