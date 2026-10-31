import http from 'node:http';
import {workbenchDataDirectory} from './paths.mjs';
import {readFile,writeFile,mkdir,rename,stat,copyFile,realpath,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {initialStudio,validateSettings,updateSettings,validatePlan,inputHash,brief,assertReady,taskNames,safeUrl,sourceId,approvalAuthority} from './studio-workflow.mjs';
import {findPlugin,createPluginBridge} from './plugin.mjs';
import {runAgent,cleanError,jobStopState} from './agent.mjs';
import {inspectCodex,sourceCapabilities,dependencyFailures,styleCapabilities,styleMediaChecks,failedDependencyReport} from './runtime.mjs';
import {rememberUsage} from './public/token-usage.js';
import {fileHash,contained,mediaExtensions,mimeTypes,streamFile,saveUpload,publicUrl,nativeMediaTool} from './media.mjs';
import {sourceDetails,materialPlan,normalizeReview,materialSelection,verifySourceIdentity} from './sources.mjs';
import {MediaLibrary,candidateId} from './library.mjs';
import {repositoryCatalog} from './repository.mjs';
import {ProjectStore} from './projects.mjs';
import {recoverLegacyProjects} from './recover-projects.mjs';
import {canCollectRepository,collectRepository,scopedCollectionContext} from './collection.mjs';
import {normalizeVoiceRequest,pendingVoiceRequest,requireVoiceRequest,voiceAnswer,recordVoiceAnswer,voiceContext,saveVoiceRecording} from './voices.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=workbenchDataDirectory();
const port=Number(process.env.PORT||4317);
const execute=promisify(execFile),stateFile=path.join(dataDir,'workbench-v2.json');
await mkdir(dataDir,{recursive:true});
// Plugin installs may rename/remove their code directory while this server runs.
// Keep all inherited subprocess working directories in persistent user storage.
process.chdir(dataDir);
const plugin=await findPlugin(root),bridge=createPluginBridge(plugin,path.join(dataDir,'requests'));
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
await library.rememberCandidates(project.sources,{run:project.run,topic:project.topic,style:project.styleSelector,query:project.sourceReview?.query||'',events:project.sourceReview?.events,reviewedAt:project.sourceReview?.reviewed_at,jobId:project.sourceReview?.jobId});
if(project.run)for(const source of project.sources.filter(s=>s.status==='ready'))await cacheMedia(source);
for(const job of project.jobs)if(['running','cancelling'].includes(job.status)){job.status='interrupted';job.error='服务已重启。远端状态可能尚未完成，请继续已有任务并核对插件记录。';job.completedAt=new Date().toISOString();}
const restoredAcquisitions=new Set();for(const job of project.jobs)if(job.candidateCacheId&&!restoredAcquisitions.has(job.candidateCacheId)){restoredAcquisitions.add(job.candidateCacheId);await library.markAcquisition(job.candidateCacheId,job);}
await refreshLibrary();
let writes=Promise.resolve(),active=null,mutation=false,catalog=null;
function persist(){rememberUsage(project);project.updatedAt=new Date().toISOString();const snapshot=JSON.stringify(project,null,2);writes=writes.catch(()=>{}).then(async()=>{await projectStore.save(JSON.parse(snapshot));await writeFile(stateFile+'.tmp',snapshot,{mode:0o600});await rename(stateFile+'.tmp',stateFile);});return writes;}
async function activateProject(next){await persist();const previous=project;project=next;try{await persist();}catch(e){project=previous;throw e;}}
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
  const cwd=project.run||path.join(dataDir,'runs');await mkdir(cwd,{recursive:true});
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
for(const job of project.jobs.filter(j=>j.action==='discover'&&j.status==='interrupted')){
  try{const directory=path.join(dataDir,'jobs',job.id),context=JSON.parse(await readFile(path.join(directory,'request.json'),'utf8'));
    if(context.jobId===job.id&&context.run===project.run&&context.brief.topic===project.topic&&context.brief.style===project.styleSelector&&context.sourceProgressPath===path.join(directory,'source-progress.json'))await saveSourceProgress(job,context,JSON.parse(await readFile(context.sourceProgressPath,'utf8')));
  }catch{}
}
function addEvent(job,type,message){job.events.push({type,message:cleanError(message),time:new Date().toISOString()});job.events=job.events.slice(-180);persist().catch(()=>{});}
function sourceRecord(s){return {id:s.id,kind:s.kind,title:s.title,url:s.url||undefined,local_path:s.localPath||undefined,author:s.author||'',rights:s.rights||'unknown',need_ids:s.needIds?.length?s.needIds:['workbench-selection'],topic_fit:s.topicFit||s.description||'用户选择',style_fit:s.styleFit||'按本期风格评估',source_type:s.sourceType||'other',event_date:s.eventDate||'',date_evidence:s.dateEvidence||'',...(s.acquisitionReport?{acquisition_report:s.acquisitionReport}:{}),verification:s.verification||'',caveats:s.caveats||[],repository_commit:s.repositoryCommit||'',repository_path:s.repositoryPath||'',expected_sha256:s.expectedSha256||'',expected_bytes:s.expectedBytes||0,sha256:s.sha256,bytes:s.bytes,duration:s.duration,width:s.width,height:s.height,source_start_seconds:s.start||0,source_end_seconds:s.end||0};}
async function saveMaterialSelection(){if(project.run)await writeFile(path.join(project.run,'material-selection.json'),JSON.stringify(materialSelection(project),null,2));}
async function ensureRun(){
  if(!project.run){const result=await bridge('create',{title:project.topic||'工作台连接检查',outputRoot:path.join(dataDir,'runs'),brief:brief({...project,topic:project.topic||'工作台连接检查'})});project.run=result.run;await persist();}
  if(project.topic)await bridge('sync',{run:project.run,brief:brief(project),sources:project.sources.filter(s=>project.selected.includes(s.id)).map(sourceRecord)});
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
  if(snapshot.schema!==1||snapshot.jobId!==job.id||snapshot.topic!==context.brief.topic||(snapshot.style||null)!==(context.brief.style||null)||!Array.isArray(snapshot.sources)||snapshot.sources.length>80)throw new Error('中间候选与当前任务不一致。');
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
  const basename=(project.topic.replace(/[^\p{L}\p{N}_-]+/gu,'-').slice(0,45)||'video')+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+job.id.slice(0,6);
  const directory=path.join(outputRoot,basename),staging=path.join(outputRoot,'.pending-'+basename);await mkdir(staging,{recursive:false});
  const extras={
    'sources.json':project.sources.filter(s=>project.selected.includes(s.id)).map(s=>({id:s.id,title:s.title,url:s.url,author:s.author,rights:s.rights,sha256:s.sha256,start:s.start,end:s.end})),
    'project.json':{projectId:result.projectId,timelineId:result.timelineId,editorUrl:cleanEditor(result.editorUrl),brief:brief(project),approval:project.approval},
    'delivery-report.json':{video:verified,notes:result.notes||[],qaStatus:result.qaStatus==='failed'?'failed':'needs_review',limitation:'文件/完整解码校验不等于完整观看与听审通过；以 qa-report.json 的实际证据为准。'}
  };
  for(const [file,value] of Object.entries(extras))await writeFile(path.join(staging,file),JSON.stringify(value,null,2));
  const files=[];
  async function add(file,name,role){if(files.some(f=>f.name===name))throw new Error('交付文件名重复，请核对导出结果。');const destination=path.join(staging,name);await copyFile(file,destination);files.push({id:randomUUID(),name,role,path:destination,bytes:(await stat(destination)).size,sha256:await fileHash(destination)});}
  for(const item of registered){const ext=path.extname(item.path).toLowerCase();if(!['.mp4','.srt','.json','.md','.txt','.png','.jpg','.jpeg','.webp'].includes(ext))continue;const name=item.role==='video'?'final.mp4':item.role==='subtitles'?'captions.srt':item.role==='qa'?'qa-report.json':`${files.length+1}-${path.basename(item.path)}`;await add(item.path,name,item.role);}
  const approval=await bridge('check-approval',{run:project.run,planHash:project.approval.planHash,inputHash:inputHash(project)});await add(approval.file,'script-storyboard.md','plan');
  for(const file of Object.keys(extras)){const p=path.join(staging,file);files.push({id:randomUUID(),name:file,role:file.startsWith('sources')?'sources':file.startsWith('project')?'project':'qa',path:p,bytes:(await stat(p)).size,sha256:await fileHash(p)});}
  await rename(staging,directory);for(const file of files)file.path=path.join(directory,file.name);
  const delivery={id:randomUUID(),directory,createdAt:new Date().toISOString(),jobId:job.id,editorUrl:cleanEditor(result.editorUrl),projectId:result.projectId,timelineId:result.timelineId,files,videoId:files.find(f=>f.role==='video').id,qaStatus:'needs_review',notes:result.notes||[],verified};
  project.deliveries.unshift(delivery);return delivery;
}
async function savePlan(plan){plan=validatePlan(plan,project);const saved=await bridge('save-plan',{run:await ensureRun(),plan,inputHash:inputHash(project)});project.plan={...plan,version:saved.version,planHash:saved.file_sha256,inputHash:saved.input_hash,file:saved.file};project.approval=null;project.revision++;return project.plan;}
async function finishJob(job,context,{code,error,finalText}){
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
    else if(job.action==='discover'){
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
      job.sourceIds=sources.map(s=>s.id);await bridge('sync',{run:project.run,brief:brief(project),sources:sources.map(sourceRecord)});job.status='completed';
    }
    else if(job.action==='plan'){await checkSelected();await savePlan(result);job.status='completed';}
    else if(job.action==='produce'){
      job.voiceRequest=project.narration&&result.status==='needs_input'?await normalizeVoiceRequest(result.voiceRequest,job):null;
      job.editorUrl=cleanEditor(result.editorUrl)||job.editorUrl;job.questions=Array.isArray(result.questions)?result.questions.map(String):[];
      if(result.status!=='exported'){job.status=result.status==='needs_input'?'needs_input':'blocked';job.error=result.summary||'制片步骤需要处理。';return;}
      await checkSelected();job.deliveryId=(await deliver(result,job)).id;job.status='completed';
    }
    addEvent(job,job.status==='completed'?'completed':'warning',job.status==='completed'?'任务结果已校验并保存':job.summary);
  }catch(e){job.status='failed';job.error=e instanceof SyntaxError?'Agent 未返回有效的结构化结果，请查看执行记录并重试。':cleanError(e.message);addEvent(job,'error',job.error);}
  finally{job.completedAt=new Date().toISOString();if(job.candidateCacheId)await library.markAcquisition(job.candidateCacheId,job).catch(e=>library.errors.push({title:'候选采集记录',error:cleanError(e.message)}));await refreshLibrary();await persist().catch(()=>{});if(active?.job.id===job.id)active=null;}
}
function adoptTopic(value){if(!project.topic.trim()&&String(value||'').trim())updateSettings(project,{topic:String(value).trim().slice(0,200),selected:project.selected});}
async function startJob(action,options={}){
  assertReady(project,action);
  if(runtime.preparing)throw preflightError('正在补齐下载依赖，完成并复检后才能开始任务。');
  if(action==='produce'&&pendingVoiceRequest(project,inputHash(project)))throw new Error('请先完成下方音色选择或录音提交。');
  const directCollection=action==='collect'&&canCollectRepository(project.sources.find(s=>s.id===options.sourceId));
  const capabilities=action==='collect'?sourceCapabilities(project.sources.find(s=>s.id===options.sourceId),{direct:directCollection}):action==='discover'?['python','media','downloader']:['plan','produce'].includes(action)?['python','media']:['python'];
  if(directCollection)rememberDependencies(await bridge('preflight',{capabilities}));else await checkLocal(capabilities,['discover','plan','produce'].includes(action)?project.styleSelector:null);
  if(!directCollection&&!runtime.compatible)throw preflightError(runtime.error||'请先完成 CLI 兼容检查。');
  requireDependencies([...capabilities,...(['discover','plan','produce'].includes(action)?styleCapabilities(project.styleSelector):[])]);
  if(action==='discover'){const query=String(options.query||project.topic).trim();if(!query)throw new Error('请输入要查找的素材关键词。');adoptTopic(query);}
  if(action==='collect'){const source=project.sources.find(s=>s.id===options.sourceId);if(!source)throw new Error('找不到选中的内容。');adoptTopic(source.title);}
  if(action==='plan'){adoptTopic(project.sources.find(s=>project.selected.includes(s.id))?.title);project.workflowVersion=1;project.portraitBottomInset??=.18;project.approval=null;}
  await ensureRun();
  if(['plan','produce'].includes(action))await checkSelected();
  if(action==='produce')await bridge('check-approval',{run:project.run,planHash:project.approval.planHash,inputHash:inputHash(project)});
  const job={id:randomUUID(),action,label:taskNames[action],status:'running',startedAt:new Date().toISOString(),events:[],toolCalls:[],inputHash:inputHash(project),planHash:action==='produce'?project.approval?.planHash:null,execution:{cliPath:runtime.codexPath,cliVersion:runtime.codexVersion,model:runtime.model,checkedAt:runtime.checkedAt}};
  if(directCollection){job.execution='direct_repository';job.usage={input_tokens:0,output_tokens:0};}
  const jobDirectory=path.join(dataDir,'jobs',job.id);await mkdir(jobDirectory,{recursive:true});
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
  const previousProduction=project.jobs.find(j=>j.action==='produce');
  let previousPlanHash=previousProduction?.planHash;
  if(previousProduction&&!previousPlanHash)try{previousPlanHash=JSON.parse(await readFile(path.join(dataDir,'jobs',previousProduction.id,'request.json'),'utf8')).planHash;}catch{}
  const productionMode=previousProduction&&previousProduction.inputHash===inputHash(project)&&previousPlanHash===project.approval?.planHash?'recover':'new';
  let context={environment:{python:runtime.dependencies?.python,programs:runtime.dependencies?.programs},jobId:job.id,sourceProgressPath:path.join(jobDirectory,'source-progress.json'),productionMode,previousProduction:previousProduction?{id:previousProduction.id,status:previousProduction.status,inputHash:previousProduction.inputHash,planHash:previousPlanHash}:null,pluginRoot:plugin.root,styleMedia:runtime.dependencies?.checks?.filter(c=>styleCapabilities(project.styleSelector).includes(c.id)),run:project.run,jobDirectory,brief:brief(project),settings:{music:project.music,voiceDirection:project.voiceDirection,styleDescription:project.styleDescription},query:String(options.query||project.topic).slice(0,2000),source,knownSources:['discover','collect'].includes(action)?project.sources:undefined,sourceReview:project.sourceReview||null,selectedSources:project.sources.filter(s=>project.selected.includes(s.id)),plan:project.plan,planHash:project.approval?.planHash||null,inputHash:inputHash(project),userFollowup:String(options.followup||'').slice(0,4000),outputDirectory:project.outputRoot};
  if(action==='collect'){
    const acquired=[...new Map(project.sources.filter(s=>s.status==='ready'&&s.kind==='video'&&s.sha256!==source.expectedSha256).map(s=>[s.sha256,s])).values()];
    context.acquisitionUsage={videoSources:acquired.length,videoSeconds:acquired.reduce((sum,s)=>sum+s.duration,0)};
    context=scopedCollectionContext(context);
  }
  if(action==='produce'){
    const currentCatalog=await getCatalog();
    context.voice=voiceContext(project,inputHash(project),currentCatalog.profile?.voice||null);
    for(const answer of context.voice.answers)if(answer.recording){const file=await contained(answer.recording.path,path.join(project.run,'voice-references'));if(await fileHash(file)!==answer.recording.sha256)throw new Error('已提交的音色录音发生变化，请恢复原录音后继续。');}
    await unlink(path.join(project.run,'workbench-cancelled.json')).catch(()=>{});await unlink(path.join(project.run,'workbench-progress.json')).catch(()=>{});}
  project.jobs.unshift(job);rememberUsage(project);project.jobs=project.jobs.slice(0,50);active={job,controller:null};addEvent(job,'queued',directCollection?'正在直接采集所选仓库媒体并校验固定版本':['discover','collect'].includes(action)?'网页已提交任务，正在加载插件的素材采集工具及适用来源规则':'网页已提交任务，正在加载 Video Studio 与 ChatCut 插件');await persist();
  active.controller=directCollection?runRepositoryCollection(job,context):runAgent({codex:runtime.codexPath,job,context,event:(type,message)=>addEvent(job,type,message),onSourceProgress:snapshot=>saveSourceProgress(job,context,snapshot),onFinish:value=>finishJob(job,context,value)});return job;
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
function publicState(){return {project,projects:projectStore.list(project.id),runtime,catalog:{version:catalog.version,styles:catalog.styles.options,styleErrors:catalog.styles.errors,styleBrowser:catalog.styleBrowser},library:libraryState(),activeJobId:active?.job.id||null,busy:!!active||mutation};}
async function openFolder(directory){directory=await realpath(directory);if(!project.deliveries.some(d=>d.directory===directory) && directory!==await realpath(project.outputRoot))throw new Error('只能打开本项目的输出文件夹。');const command=process.platform==='darwin'?['open',[directory]]:process.platform==='win32'?['explorer.exe',[directory]]:['xdg-open',[directory]];await execute(command[0],command[1],{timeout:10000});}
async function openMaterialFolder(id){const source=project.sources.find(s=>s.id===id&&s.status==='ready');if(!source)throw new Error('请选择已经采集的素材。');const directory=path.dirname(await contained(source.localPath,project.run));const command=process.platform==='darwin'?['open',[directory]]:process.platform==='win32'?['explorer.exe',[directory]]:['xdg-open',[directory]];await execute(command[0],command[1],{timeout:10000});}
const server=http.createServer(async(req,res)=>{
  try{
    const host=req.headers.host;if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return send(res,403,{error:'仅接受本机访问。'});
    const url=new URL(req.url,'http://'+host),route=url.pathname;
    if(req.method==='POST' && (req.headers['x-video-demo']!=='1'||(req.headers.origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(req.headers.origin))))return send(res,403,{error:'请求来源无效。'});
    if(req.method==='POST' && req.headers['x-video-project'] && req.headers['x-video-project']!==project.id)return send(res,409,{error:'当前项目已在其他页面切换。请刷新后再操作，待保存的内容仍留在此页面。'});
    if(req.method==='GET' && route==='/api/health')return send(res,200,{app:'video-studio-workbench',version:plugin.version,dataDirectory:dataDir,workingDirectory:process.cwd()});
    if(req.method==='GET' && route==='/api/state'){await refreshLibrary();return send(res,200,publicState());}
    if(req.method==='GET' && route==='/api/projects')return send(res,200,{projects:projectStore.list(project.id),errors:projectStore.errors});
    if(req.method==='GET' && route==='/api/library'){await refreshLibrary();return send(res,200,libraryState());}
    if(['GET','HEAD'].includes(req.method) && route.startsWith('/api/library/media/')){try{const {entry,file}=await library.resolve(route.split('/').pop(),url.searchParams.has('thumbnail'));return await streamFile(req,res,file,{download:url.searchParams.has('download'),name:path.basename(entry.localPath)});}catch(e){return send(res,404,{error:cleanError(e.message)});}}
    if(req.method==='GET' && route==='/api/source-skill'){const folder=path.join(plugin.root,'skills/video-source-tools');const skill=await readFile(path.join(folder,'SKILL.md'),'utf8');const names=[...new Set([...skill.matchAll(/\]\(references\/([a-z0-9-]+\.md)\)/g)].map(m=>m[1]))];const references=await Promise.all(names.map(async name=>({name,text:await readFile(path.join(folder,'references',name),'utf8')})));return send(res,200,{skill,references});}
    if(req.method==='GET' && route==='/api/styles/detail')return send(res,200,await bridge('style-details',{key:url.searchParams.get('key')}));
    if(req.method==='GET' && route==='/api/styles/reference')return send(res,200,await bridge('style-reference',{key:url.searchParams.get('key'),referenceId:url.searchParams.get('id')}));
    if(req.method==='GET' && route.startsWith('/api/jobs/')){const job=project.jobs.find(j=>j.id===route.split('/').pop());return send(res,job?200:404,job||{error:'任务不存在。'});}
    if(['GET','HEAD'].includes(req.method) && route.startsWith('/api/source-reports/')){const job=project.jobs.find(j=>j.id===route.split('/').pop());if(!job?.sourceReport)return send(res,404,{error:'检索记录不存在。'});return await streamFile(req,res,await contained(job.sourceReport,project.run),{download:true,name:'material-search-'+job.id.slice(0,8)+'.json'});}
    if(['GET','HEAD'].includes(req.method) && route.startsWith('/api/media/')){const source=project.sources.find(s=>s.id===route.split('/').pop());if(!source||source.status!=='ready')return send(res,404,{error:'素材尚未采集完成。'});const file=url.searchParams.has('thumbnail')?source.thumbnailPath:source.localPath;if(!file)return send(res,404,{error:'暂无预览。'});return await streamFile(req,res,await contained(file,project.run),{download:url.searchParams.has('download')});}
    if(['GET','HEAD'].includes(req.method) && route.startsWith('/api/files/')){const id=route.split('/').pop();let delivery,file;for(const d of project.deliveries){const found=d.files.find(f=>f.id===id);if(found){delivery=d;file=found;break;}}if(!file)return send(res,404,{error:'交付文件不存在。'});return await streamFile(req,res,await contained(file.path,delivery.directory),{download:url.searchParams.has('download'),name:file.name});}
    if(req.method==='POST' && route==='/api/voice/recording')return await exclusive(async()=>{
      const payload=JSON.parse(decodeURIComponent(req.headers['x-voice-intake']||''));
      const request=requireVoiceRequest(project,inputHash(project),payload.requestId),answer=voiceAnswer(request,{...payload,action:'recording'});
      await checkMedia();
      const recording=await saveVoiceRecording(req,{name:url.searchParams.get('name')||'',run:project.run,inspect:file=>bridge('inspect-media',{file})});
      recordVoiceAnswer(project,request,{...answer,recording});await persist();return send(res,201,{ok:true});
    });
    if(req.method==='POST' && route==='/api/upload')return await exclusive(async()=>{const name=path.basename(url.searchParams.get('name')||'');const ext=path.extname(name).toLowerCase();if(!mediaExtensions.has(ext))throw new Error('请上传视频、图片或音频文件。');await checkMedia();adoptTopic(name);await ensureRun();const file=path.join(project.run,'materials',randomUUID()+ext);await saveUpload(req,file);const source=await registerMedia(file,{title:name,description:'用户上传的本地素材',rights:'user_provided'});await persist();return send(res,201,{source});});
    if(req.method==='POST'){
      if(!/^application\/json/.test(req.headers['content-type']||''))return send(res,415,{error:'需要 JSON 请求。'});const payload=await body(req);
      if(req.headers['x-video-project'] && req.headers['x-video-project']!==project.id)return send(res,409,{error:'当前项目已在其他页面切换，请刷新后再操作。'});
      if(route==='/api/cancel'){if(active){active.job.status='cancelling';active.job.cancelRequested=true;await writeFile(path.join(project.run,'workbench-cancelled.json'),JSON.stringify({jobId:active.job.id,time:new Date().toISOString()}));active.controller?.cancel();await persist();}return send(res,200,{ok:true});}
      if(route==='/api/open-folder'){await mkdir(project.outputRoot,{recursive:true});await openFolder(payload.directory||project.outputRoot);return send(res,200,{ok:true});}
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
        if(route==='/api/project'){const oldStyle=project.styleSelector;updateSettings(project,validateSettings(payload,catalog.styles.options));if(oldStyle!==project.styleSelector)rememberDependencies(await bridge('preflight',{capabilities:['git_lfs',...styleMediaChecks],styleSelector:project.styleSelector}));await saveMaterialSelection();await persist();return send(res,200,{project});}
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
        if(route==='/api/styles/select'){const result=await bridge('style-select',{key:payload.key});await getCatalog();updateSettings(project,validateSettings({...project,styleSelector:result.selector},catalog.styles.options));rememberDependencies(await bridge('preflight',{capabilities:['git_lfs',...styleMediaChecks],styleSelector:project.styleSelector}));await persist();return send(res,200,{...publicState(),selection:result});}
        if(route==='/api/styles/import'){if(typeof payload.path!=='string'||!path.isAbsolute(payload.path))throw new Error('请填写风格包 manifest.json 的完整路径。');const result=await execute(process.env.VIDEO_STUDIO_PYTHON||'python3',[path.join(plugin.root,'scripts/studio.py'),'styles','import','--file',payload.path],{timeout:30000,maxBuffer:1024*1024});await getCatalog();return send(res,200,{result:JSON.parse(result.stdout),catalog:catalog.styles});}
        if(route==='/api/sources/url'){const sourceUrl=await publicUrl(payload.url);const entry={id:sourceId({url:sourceUrl}),title:String(payload.title||new URL(sourceUrl).hostname).slice(0,300),kind:'article',url:sourceUrl,mediaUrl:'',thumbnailUrl:'',description:'用户添加的内容链接',rights:'unknown',status:'candidate',start:0,end:0};if(!project.sources.some(s=>s.id===entry.id))project.sources.unshift(entry);await library.rememberCandidates([entry],{run:project.run,topic:project.topic,style:project.styleSelector,query:'手动添加链接'});await refreshLibrary();await persist();return send(res,201,{source:project.sources.find(s=>s.id===entry.id)});}
        if(route==='/api/sources/local'){let file=String(payload.path||'');if(file.startsWith('~/'))file=path.join(os.homedir(),file.slice(2));if(!path.isAbsolute(file))throw new Error('请输入本地素材绝对路径。');file=await realpath(file);const ext=path.extname(file).toLowerCase();if(!mediaExtensions.has(ext))throw new Error('请选择媒体文件。');if((await stat(file)).size>350*1024*1024)throw new Error('单个素材需小于 350 MB。');await checkMedia();adoptTopic(path.basename(file));await ensureRun();const destination=path.join(project.run,'materials',randomUUID()+ext);await mkdir(path.dirname(destination),{recursive:true});await copyFile(file,destination);const source=await registerMedia(destination,{title:path.basename(file),rights:'user_provided',description:'用户选择的本地文件'});await persist();return send(res,201,{source});}
        if(route==='/api/plan'){await ensureRun();await checkSelected();await savePlan(payload.plan);await persist();return send(res,200,{plan:project.plan});}
        if(route==='/api/approve'){if(!project.plan||project.plan.stale||project.plan.gaps.length)throw new Error('请先更新方案并解决素材缺口。');await checkSelected();if(payload.planHash!==project.plan.planHash||project.plan.inputHash!==inputHash(project))throw new Error('方案或素材已经变化，请重新审阅。');const authority=approvalAuthority(payload.authority);const approved=await bridge('approve',{run:project.run,planHash:project.plan.planHash,inputHash:inputHash(project),authority});project.approval={status:'confirmed',planHash:approved.file_sha256,inputHash:approved.input_hash,version:approved.version,confirmedAt:approved.confirmed_at,authority:approved.authority};await persist();return send(res,200,{approval:project.approval});}
        if(route==='/api/voice/answer'){const request=requireVoiceRequest(project,inputHash(project),payload.requestId);if(payload.action==='recording')throw new Error('请使用录音上传入口。');recordVoiceAnswer(project,request,voiceAnswer(request,payload));await persist();return send(res,200,{ok:true});}
        if(route==='/api/jobs'){const job=await startJob(payload.action,payload);return send(res,202,{job});}
        if(route==='/api/projects/switch'){const next=projectStore.load(payload.projectId);for(const job of next.jobs)if(['running','cancelling'].includes(job.status)){job.status='interrupted';job.error='该项目的本地会话已结束；继续前应核对已有远端任务。';}await activateProject(next);rememberDependencies(await bridge('preflight',{capabilities:['git_lfs',...styleMediaChecks],styleSelector:project.styleSelector}));return send(res,200,publicState());}
        if(route==='/api/reset'){const next=initialStudio();next.outputRoot=project.outputRoot;await activateProject(next);rememberDependencies(await bridge('preflight',{capabilities:['git_lfs',...styleMediaChecks],styleSelector:project.styleSelector}));return send(res,200,publicState());}
        return send(res,404,{error:'没有此操作。'});
      });
    }
    const files={'/':'index.html','/app.js':'app.js','/dependency-view.js':'dependency-view.js','/voice-ui.js':'voice-ui.js','/style-plan-view.js':'style-plan-view.js','/production-plan.js':'production-plan.js','/material-dates.js':'material-dates.js','/token-usage.js':'token-usage.js','/token-usage-view.js':'token-usage-view.js','/styles.css':'styles.css','/theme.js':'theme.js','/themes.css':'themes.css'};
    if(req.method==='GET' && files[route]){const file=files[route];res.writeHead(200,{'Content-Type':({html:'text/html',js:'text/javascript',css:'text/css'})[file.split('.').pop()]+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https:; media-src 'self' blob: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});return res.end(await readFile(path.join(root,'public',file)));}
    send(res,404,{error:'页面不存在。'});
  }catch(e){if(res.headersSent){res.destroy();return;}send(res,/已有操作/.test(e.message)?409:400,{error:cleanError(e.message),...(e.code==='preflight_failed'?{code:e.code,runtime}:{})});}
});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`端口 ${port} 已被占用，请关闭旧工作台后启动。`:e.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>{console.log(`Video Agent Demo: http://127.0.0.1:${port}`);console.log(`Video Studio ${plugin.version} · ${runtime.authenticated?'Codex 已登录':'请登录 Codex'}`);});
function shutdown(){if(active){active.job.status='interrupted';persist().catch(()=>{});}active?.controller?.cancel();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
