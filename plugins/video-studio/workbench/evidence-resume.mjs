import {inputHash} from './studio-workflow.mjs';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {contained,fileHash} from './media.mjs';
const artifactRoles=new Set(['video','subtitles','cover_portrait','cover_landscape','copy']);

function registrationMatches(project,job,scope){
  const saved=job.pendingRegistration;
  return saved?.schema===1&&saved.projectId===project.id&&saved.jobId===job.id&&saved.threadId===job.threadId
    &&saved.run===project.run&&saved.requestHash===scope&&saved.inputHash===inputHash(project)
    &&saved.planHash===project.approval?.planHash&&project.approval?.inputHash===saved.inputHash&&!project.plan?.stale;
}
export function pendingRegistration(project,scope){
  const job=project.jobs.find(j=>['create','produce'].includes(j.action)&&j.requestHash===scope&&j.inputHash===inputHash(project)&&j.planHash===project.approval?.planHash);
  return job&&registrationMatches(project,job,scope)&&!job.pendingRegistration.completed?job:null;
}
export async function saveRegistrationResult(project,job,context,result){
  if(job.pendingRegistration)return; // A retry must consume the exact original result, never replace it.
  const directory=await mkdtemp(path.join(job.directory,'registration-'));
  const resultFile=path.join(directory,'result.json'),contextFile=path.join(directory,'context.json');
  await writeFile(resultFile,JSON.stringify(result),{mode:0o600});
  // Persist only fields needed by local registration. No narration endpoint token.
  const savedContext={run:context.run||project.run,taskAction:job.action,pendingExport:context.pendingExport||null,
    voice:context.voice?{savedVoice:context.voice.savedVoice,answers:context.voice.answers?.filter(a=>a.action==='select')}:null,
    repair:context.repair||null,historyReuseId:context.historyReuseId||project.userRevision?.id||null};
  await writeFile(contextFile,JSON.stringify(savedContext),{mode:0o600});
  job.pendingRegistration={schema:1,projectId:project.id,jobId:job.id,threadId:job.threadId,run:project.run,
    requestHash:job.requestHash,inputHash:job.inputHash,planHash:job.planHash,resultFile,contextFile,
    resultSha256:await fileHash(resultFile),contextSha256:await fileHash(contextFile),completed:false};
  // Bind bytes at result intake, not whatever happens to occupy the path later.
  job.pendingRegistration.artifacts=[];
  try{
    for(const item of result.files.filter(f=>artifactRoles.has(f.role))){
      // Empty/missing subtitle exports use the existing native-caption recovery.
      if(item.role==='subtitles')try{if(!(await stat(path.resolve(project.run,item.path))).size)continue;}catch(error){if(error.code==='ENOENT')continue;throw error;}
      const file=await contained(path.resolve(project.run,item.path),project.run);
      job.pendingRegistration.artifacts.push({role:item.role,path:file,sha256:await fileHash(file)});
    }
  }catch(error){job.pendingRegistration.captureError='导出文件尚未完整登记：'+error.message;throw error;}
}
export async function verifyRegistrationArtifacts(job,run,candidate=null){
  const saved=job.pendingRegistration;
  if(saved.captureError||!saved.artifacts?.some(f=>f.role==='video'))throw Error(saved.captureError||'待登记结果缺少成品文件快照。');
  for(const ref of saved.artifacts){
    if(await fileHash(await contained(ref.path,run))!==ref.sha256)throw Error('待登记成品文件已变化：'+path.basename(ref.path));
    if(candidate&&!candidate.files.some(f=>f.role===ref.role&&f.path===ref.path&&f.sha256===ref.sha256))throw Error('候选与待登记成品快照不一致。');
  }
}
export async function loadRegistrationResult(project,job,scope){
  if(!registrationMatches(project,job,scope))throw Error('待登记结果与当前项目、方案或制作任务不一致。');
  const saved=job.pendingRegistration;
  const resultFile=await contained(saved.resultFile,job.directory),contextFile=await contained(saved.contextFile,job.directory);
  if(await fileHash(resultFile)!==saved.resultSha256||await fileHash(contextFile)!==saved.contextSha256)throw Error('已保存的待登记结果发生变化，不能恢复登记。');
  await verifyRegistrationArtifacts(job,project.run);
  return {result:JSON.parse(await readFile(resultFile,'utf8')),context:JSON.parse(await readFile(contextFile,'utf8'))};
}

// Historical quality cycles remain on a project after its topic/plan changes.
// Recovery actions must select only an export bound to the current approval.
export function currentCandidate(project){
  const approval=project.approval,hash=inputHash(project);
  if(!approval||project.plan?.stale||approval.inputHash!==hash)return null;
  const candidate=project.qualityCycle?.candidate;
  if(candidate?.inputHash===hash&&candidate.planHash===approval.planHash)return candidate;
  return pendingEvidence(project)?.pendingExport||null;
}

// Only a still-approved, unreviewed export is evidence intake. A creative
// revision or a failed quality cycle must keep its normal approval gates.
export function pendingEvidence(project){
  const approval=project.approval,hash=inputHash(project);
  if(!approval||project.plan?.stale||approval.inputHash!==hash)return null;
  if(project.qualityCycle?.candidate?.inputHash===hash&&project.qualityCycle.candidate.planHash===approval.planHash)return null;
  for(const job of project.jobs){
    if(!['create','produce'].includes(job.action)||job.inputHash!==hash||job.planHash!==approval.planHash)continue;
    if(job.revisionProposal||job.voiceRequest)return null;
    const candidate=job.pendingExport;
    if(!['needs_input','failed','interrupted','cancelled'].includes(job.status)||!candidate)continue;
    const producer=project.jobs.find(p=>p.id===candidate.producerJobId);
    const origin=candidate.exportOrigin||candidate;
    if(candidate.inputHash===hash&&candidate.planHash===approval.planHash&&producer?.inputHash===hash&&producer.planHash===origin.planHash&&origin.inputHash===hash)return job;
  }
  return null;
}
