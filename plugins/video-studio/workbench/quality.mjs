import path from 'node:path';
import {constants} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {copyFile,mkdtemp,readFile,stat} from 'node:fs/promises';
import {contained,fileHash} from './media.mjs';

export const reviewMethods={visuals:'sampled_composited_frames',occlusion:'sampled_composited_frames',portrait_layout:'sampled_composited_frames',material_continuity:'sampled_source_windows',transitions:'boundary_frames_and_signal_scan',caption_flow:'boundary_frames_and_signal_scan',flicker:'boundary_frames_and_signal_scan',audio_listening:'objective_audio_metrics',av_sync:'timeline_words_and_audio_metrics',music_fit:'objective_mix_and_context',caption_sync:'word_alignment_and_frames',output_details:'export_and_boundary_inspection',facts:'source_review',style_match:'reference_comparison'};
const artifactRoles=new Set(['video','subtitles','cover_portrait','cover_landscape','copy']);
export const hasExportRecord=job=>!!job?.threadId&&!!job.toolCalls?.some(t=>/chatcut/i.test(t.server+' '+t.tool)&&/submit_export|track_export/.test(t.tool)&&t.status==='completed');
const planMetadata=new Set(['file','version','planHash','inputHash','stale']);
export function equivalentReusePlan(previous,current,noteApproval=null){
  if(!previous||!current)return false;
  const before=Object.fromEntries(Object.entries(previous).filter(([key])=>!planMetadata.has(key)));
  const after=Object.fromEntries(Object.entries(current).filter(([key])=>!planMetadata.has(key)));
  // Production notes are instructions. Only a host-reviewed, exact notes-only
  // amendment can be excluded; candidate output cannot grant this exception.
  if(noteApproval?.kind==='evidence_notes_only'&&noteApproval.fromPlanHash===previous.planHash&&noteApproval.toPlanHash===current.planHash
    &&isDeepStrictEqual(noteApproval.before,previous.notes)&&isDeepStrictEqual(noteApproval.after,current.notes)){
    delete before.notes;delete after.notes;
  }
  return isDeepStrictEqual(before,after);
}
function contributors(candidate){return [{jobId:candidate.producerJobId,threadId:candidate.producerThreadId},...(candidate.contributors||[])];}
function independentOf(candidate,jobId,threadId){return !!threadId&&!contributors(candidate).some(c=>c.jobId===jobId||c.threadId===threadId);}
export function producerConcerns(candidate){
  const messages=[...(candidate.unresolvedIssues||[]),...(candidate.qaStatus==='failed'?[candidate.summary||'制作方已报告未解决问题。']:[])];
  return [...new Set(messages.filter(text=>typeof text==='string'&&text.trim()))].map((text,index)=>({id:'producer-'+(index+1),text}));
}
function concernsResolved(candidate,review){
  const expected=producerConcerns(candidate),rows=review?.producer_concerns||[];
  return expected.every(c=>{
    const matching=rows.filter(r=>r.id===c.id&&r.text===c.text);
    return matching.length===1&&matching[0].disposition==='resolved'&&matching[0].observations?.trim()
      &&matching[0].evidencePaths?.length&&matching[0].evidencePaths.every(p=>review.evidence_files?.some(f=>f.path===p));
  });
}
async function observedVideoFrame(location,video,job,run,frames){
  if(!job.directory||typeof location!=='string')return null;
  try{
    const file=await contained(location,job.directory);
    if(!/^native-\d+\.png$/.test(path.basename(file)))return null;
    const manifest=await contained(path.join(path.dirname(file),'frames.json'),job.directory);
    const value=JSON.parse(await readFile(manifest,'utf8'));
    if(await contained(value.file,run)!==video.path||value.sha256!==video.sha256)return null;
    if(!Array.isArray(value.frames)||!value.frames.length||!value.frames.every(n=>Number.isInteger(n)&&n>=0&&n<frames)||new Set(value.frames).size!==value.frames.length)return null;
    const rows=(value.native_frames||[]).filter(row=>row.path===file),row=rows[0];
    if(rows.length!==1||!Number.isInteger(row.frame)||row.frame<0||row.frame>=frames||!value.frames.includes(row.frame)||value.native_frames.filter(r=>r.frame===row.frame).length!==1||await fileHash(file)!==row.sha256)return null;
    if(!(await readFile(file)).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return null;
    return {path:file,frame:row.frame,evidence:[{path:file,sha256:row.sha256},{path:manifest,sha256:await fileHash(manifest)}]};
  }catch{return null;}
}
export function assertCanProduce(cycle,planHash,inputHash){
  if(!cycle?.candidate||cycle.candidate.planHash!==planHash||cycle.candidate.inputHash!==inputHash)return;
  if(cycle.terminal==='quality_failed'||cycle.repairCompleted)throw Error('当前方案已完成一轮返工，请继续验收或处理问题并更新方案，不能再次返工。');
  if(cycle.report===null)throw Error('已有待验收成片，请继续独立验收，不要重新制作。');
}
export async function bindCandidate(result,run,job,recoverSubtitles,previousCandidate=null){
  return bindExportCandidate(result,run,job,recoverSubtitles,previousCandidate,job);
}
async function bindExportCandidate(result,run,job,recoverSubtitles,previousCandidate,exporter){
  if(result.status!=='exported'||!Array.isArray(result.files))throw Error('没有实际完成的导出。');
  if(!result.projectId||!result.timelineId||!job.threadId||!hasExportRecord(exporter))throw Error('缺少真实 ChatCut 工程、制作会话或导出调用记录。');
  const record=JSON.parse(await readFile(path.join(run,'run.json'),'utf8'));
  if(record.project?.projectId!==result.projectId||record.project?.timelineId!==result.timelineId)throw Error('候选与实际 ChatCut 工程不一致。');
  if(!job.planHash||!job.inputHash||record.project.planHash!==job.planHash||record.project.inputHash!==job.inputHash)throw Error('候选工程未绑定当前制作方案与输入。');
  if(previousCandidate){
    if(previousCandidate.projectId!==result.projectId||previousCandidate.timelineId!==result.timelineId||previousCandidate.planHash!==job.planHash||previousCandidate.inputHash!==job.inputHash)throw Error('补证候选与当前工程、方案或输入不一致。');
    await verifyCandidate(previousCandidate,run);
  }
  const files=[];let snapshotDirectory;
  for(const item of result.files){
    if(item.role==='subtitles' && record.settings?.captions && recoverSubtitles){
      try{const file=await contained(path.resolve(run,item.path),run);if(!(await readFile(file,'utf8')).trim())continue;}
      catch{continue;}
    }
    let file=await contained(path.resolve(run,item.path),run);const info=await stat(file);
    if(!info.isFile()||!info.size)throw Error('导出文件为空。');
    // Run/selection/review records are live state. Freeze their export-time bytes;
    // later host bookkeeping must not invalidate an unchanged delivered artifact.
    if(!artifactRoles.has(item.role)){
      const prior=previousCandidate?.files.find(f=>f.role===item.role&&(f.path===file||f.sourcePath===file));
      if(prior){files.push({...prior});continue;}
      const sourcePath=file,originalHash=await fileHash(file);
      snapshotDirectory??=await mkdtemp(path.join(run,'candidate-records-'));
      const snapshot=path.join(snapshotDirectory,files.length+'-'+path.basename(file));
      await copyFile(file,snapshot,constants.COPYFILE_EXCL);
      file=await contained(snapshot,run);
      if(await fileHash(file)!==originalHash||await fileHash(sourcePath)!==originalHash)throw Error('登记期间工程附件已变化，请重新登记导出。');
      files.push({...item,sourcePath,path:file,sha256:originalHash});continue;
    }
    files.push({...item,path:file,sha256:await fileHash(file)});
  }
  if(record.settings?.captions && recoverSubtitles && !files.some(item=>item.role==='subtitles')){
    try{
      const recovered=await recoverSubtitles(run),file=await contained(recovered.path,run);
      files.push({role:'subtitles',path:file,sha256:await fileHash(file)});
    }catch{
      result={...result,unresolvedIssues:[...(result.unresolvedIssues||[]),'未取得完整可见的原生字幕或有效 SRT。']};
    }
  }
  if(files.filter(f=>f.role==='video'&&path.extname(f.path)==='.mp4').length!==1)throw Error('需要唯一最终 MP4。');
  return {...result,files,producerJobId:exporter.id,producerThreadId:exporter.threadId,inputHash:job.inputHash,planHash:job.planHash};
}
export async function bindReusedCandidate({result,run,job,prior,producer,previousPlan,currentPlan,noteApproval=null,evidenceOnly=false}){
  if(!prior||prior.producerJobId!==producer?.id||prior.producerThreadId!==producer.threadId||!hasExportRecord(producer))throw Error('缺少原成片的真实导出来源，不能复用。');
  const original=prior.exportOrigin||prior;
  if(original.planHash!==producer.planHash||original.inputHash!==producer.inputHash||prior.inputHash!==job.inputHash)throw Error('原导出与当前输入或制作记录不一致。');
  if(prior.projectId!==result.projectId||prior.timelineId!==result.timelineId)throw Error('复用结果与原工程不一致。');
  if(evidenceOnly){if(prior.planHash!==job.planHash)throw Error('补证候选方案已变化。');}
  else if(previousPlan?.planHash!==prior.planHash||currentPlan?.planHash!==job.planHash||!equivalentReusePlan(previousPlan,currentPlan,noteApproval))throw Error('当前制作方案有实质变化，不能将原成片直接登记为新方案结果。');
  await verifyCandidate(prior,run);
  for(const role of artifactRoles){
    const old=prior.files.filter(f=>f.role===role),next=result.files.filter(f=>f.role===role);
    if(old.length>1||next.length!==old.length||role==='video'&&old.length!==1)throw Error('复用交付文件缺失、增加或重复：'+role);
    if(old.length&&await fileHash(await contained(path.resolve(run,next[0].path),run))!==old[0].sha256)throw Error('复用成片文件已变化：'+role);
  }
  const candidate=await bindExportCandidate(result,run,job,null,evidenceOnly?prior:null,producer);
  if(evidenceOnly&&prior.files.some(f=>!candidate.files.some(g=>g.role===f.role&&g.sha256===f.sha256)))throw Error('补证必须保留原候选全部附件。');
  return {...candidate,exportOrigin:{producerJobId:producer.id,producerThreadId:producer.threadId,planHash:original.planHash,inputHash:original.inputHash},
    registeredByJobId:job.id,registeredByThreadId:job.threadId,
    contributors:[...new Map([...contributors(prior),{jobId:job.id,threadId:job.threadId}].map(c=>[c.jobId+'|'+c.threadId,c])).values()],
    reusedFrom:{planHash:prior.planHash,files:prior.files.filter(f=>artifactRoles.has(f.role)).map(({role,sha256})=>({role,sha256}))},selectedVoice:prior.selectedVoice||null};
}
export async function verifyCandidate(candidate,run){
  if(!candidate?.files?.length)throw Error('缺少待验收成片。');
  for(const f of candidate.files)if(await fileHash(await contained(f.path,run))!==f.sha256)throw Error('待验收文件已变化（'+path.basename(f.path)+'），需要重新登记导出。');
  return candidate.files.find(f=>f.role==='video');
}
// Recover only already-registered independent results for this exact edit and evidence.
export async function recoverRecordedReview(audit,last,candidate,run){
  if(!independentOf(candidate,last.id,last.threadId))return null;
  let previous;
  try{previous=JSON.parse(await readFile(path.join(last.directory,'request.json'),'utf8'));}catch{return null;}
  const probe=previous?.probe;
  const video=candidate.files.find(f=>f.role==='video'),subtitle=candidate.files.find(f=>f.role==='subtitles');
  if(!probe||previous.candidate?.producerJobId!==candidate.producerJobId||probe.artifact_sha256!==video?.sha256||probe.subtitle_sha256!==(subtitle?.sha256||null))return null;
  if(['planHash','inputHash','projectId','timelineId'].some(key=>previous.candidate[key]!==candidate[key]))return null;
  const record=JSON.parse(await readFile(path.join(run,'run.json'),'utf8'));
  if(probe.revision!==record.revision||!probe.evidence_files?.length)return null;
  for(const ref of probe.evidence_files){
    try{if(await fileHash(await contained(ref.path,run))!==ref.sha256)return null;}catch{return null;}
  }
  if(audit.completed){
    if(audit.artifact_sha256!==video.sha256||audit.subtitle_sha256!==(subtitle?.sha256||null))return null;
    const recovered=await enforceIndependentReview({...audit,independentJobId:last.id,independentThreadId:last.threadId,
      producerJobId:candidate.producerJobId,limitations:['复用中断前已登记的同一成片独立验收；当前文件与证据已重新核对。']},run,candidate);
    return recovered.completed?recovered:null;
  }
  const rejected=Object.entries(audit.checks).some(([key,check])=>{
    const actual=record.reviews?.[key];
    return check.status==='fail'&&actual?.reviewer_job_id===last.id&&actual.reviewer===last.threadId
      &&actual.producer_job_id===candidate.producerJobId&&actual.artifact_sha256===video.sha256
      &&actual.revision===record.revision;
  });
  if(!rejected)return null;
  return enforceIndependentReview({...audit,completed:false,independentJobId:last.id,independentThreadId:last.threadId,
    producerJobId:candidate.producerJobId,limitations:['恢复了中断前登记的独立验收问题，未登记项目保留为待核验。']},run,candidate);
}

export async function registerIndependentReview({result,job,candidate,probe,run,bridge,methods=reviewMethods,referenceProbe=null,requiredChecks=null}){
  if(!independentOf(candidate,job.id,job.threadId))throw Error('缺少独立验收会话，拒绝使用制作或补证 Agent 自评。');
  await verifyCandidate(candidate,run);
  const record=JSON.parse(await readFile(path.join(run,'run.json'),'utf8'));
  if(record.revision!==probe.revision)throw Error('验收期间工程记录已变化，报告失效。');
  if(!Array.isArray(result.checks)||!result.checks.length)throw Error('独立验收未返回逐项检查。');
  const issueIds=new Set();
  for(const issue of result.issues||[]){if(!issue.id||issueIds.has(issue.id)||!Object.hasOwn(reviewMethods,issue.check)||!result.checks.some(c=>c.check===issue.check))throw Error('验收问题编号重复或所属检查不存在');issueIds.add(issue.id);}
  const manifestHash=await fileHash(probe.manifest),seen=new Set();
  for(const raw of result.checks){
    const issues=(result.issues||[]).filter(i=>i.check===raw.check||(raw.issueIds||[]).includes(i.id));
    if((raw.issueIds||[]).some(id=>!(result.issues||[]).some(i=>i.id===id)))throw Error('验收引用了不存在的问题编号');
    const check={...raw,observedSheets:raw.observedSheets?.length?raw.observedSheets:result.observedSheets||[],
      observedReferenceSheets:raw.observedReferenceSheets?.length?raw.observedReferenceSheets:result.observedReferenceSheets||[],
      issues:[...(raw.issues||[]),...issues],evidenceFiles:[...(raw.evidenceFiles||[])]};
    for(const location of raw.evidencePaths||[]){let file;try{file=await contained(location,run);}catch{file=await contained(location,job.directory);}check.evidenceFiles.push({path:file,sha256:await fileHash(file)});}
    // Fixed packet hashes are supplied by the host; visual observations still come only from the independent reviewer.
    for(const file of [probe.manifest,probe.metrics,...(check.check==='style_match'&&referenceProbe?[referenceProbe.manifest]:[])].filter(Boolean))check.evidenceFiles.push({path:file,sha256:await fileHash(file)});

    if(!Object.hasOwn(reviewMethods,check.check)||seen.has(check.check))throw Error('验收项目未知或重复。');seen.add(check.check);
    if(check.result==='not_applicable'&&requiredChecks&&!requiredChecks.includes(check.check))continue;
    if(!['pass','fail','unverified','not_applicable'].includes(check.result))throw Error('验收状态无效。');
    const evidence=[];
    for(const ref of check.evidenceFiles||[]){
      // The reviewer can cite the immutable run or its own isolated output directory only.
      let file;try{file=await contained(ref.path,run);}catch{file=await contained(ref.path,job.directory);}
      if(await fileHash(file)!==ref.sha256)throw Error('验收证据哈希不匹配。');evidence.push({path:file,sha256:ref.sha256});
    }
    const payload={check:check.check,result:check.result,method:methods[check.check],reviewer:job.threadId,reviewer_job_id:job.id,producer_job_id:candidate.producerJobId,artifact_sha256:probe.artifact_sha256,subtitle_sha256:probe.subtitle_sha256,probe_sha256:manifestHash,coverage_frames:[0,probe.frames],observed_sheets:check.observedSheets||[],observations:check.observations,evidence:check.observations,evidence_files:evidence,issues:check.issues||[],limitations:result.limitations||[],production_plan_sha256:record.production_plan?.sha256,style_plan_sha256:record.style_plan?.sha256,style:record.style_snapshot?.selector,rules:Object.fromEntries((check.rules||[]).map(r=>[r.id,{result:r.result,observations:r.observations}])),not_applicable_reason:check.notApplicableReason||''};
    if(check.check==='output_details'&&producerConcerns(candidate).length){
      payload.producer_concerns=[];
      for(const concern of producerConcerns(candidate)){
        const rows=(result.producerConcerns||[]).filter(r=>r.id===concern.id);
        if(rows.length!==1)continue;
        const row=rows[0],paths=[];
        for(const location of row.evidencePaths||[]){
          let file;try{file=await contained(location,run);}catch{file=await contained(location,job.directory);}
          payload.evidence_files.push({path:file,sha256:await fileHash(file)});paths.push(file);
        }
        payload.producer_concerns.push({...row,text:concern.text,evidencePaths:paths});
      }
      if(payload.result==='pass'&&!concernsResolved(candidate,payload)){
        payload.result='unverified';payload.observations+='；制作方遗留疑点尚未由独立验收逐项提供证据并裁定。';payload.evidence=payload.observations;
      }
    }
    if(check.check==='caption_flow')payload.caption_observations=check.captionObservations||[];
    payload.presentation_observations=check.presentationObservations||[];
    const titlePolicy=record.production_plan?.plan?.productionPlan;
    if(check.check==='output_details'&&titlePolicy?.layout?.mode==='portrait-centered'&&[2,3].includes(titlePolicy.layout.version)){
      const rows=check.titleObservations||[],roles=['video','cover_portrait','cover_landscape'];
      payload.title_observations=[];
      let valid=Array.isArray(rows)&&rows.length===3&&typeof titlePolicy.coverTitle==='string'&&!!titlePolicy.coverTitle.trim();
      for(const role of roles){
        const matches=Array.isArray(rows)?rows.filter(r=>r?.role===role):[],files=candidate.files.filter(f=>f.role===role),row=matches[0],file=files[0];
        const frame=role==='video'&&matches.length===1&&files.length===1&&row.path!==file.path?await observedVideoFrame(row.path,file,job,run,probe.frames):null;
        if(matches.length!==1||files.length!==1||row.path!==file.path&&!frame||typeof row.text!=='string'||row.text.replace(/\r\n|\n/g,'').trim()!==titlePolicy.coverTitle.trim()||(role==='video'&&(row.text.replace(/\r\n/g,'\n').split('\n').length>2||row.text.replace(/\r\n/g,'\n').split('\n').some(line=>!line.trim()||line.includes('\r'))))){valid=false;continue;}
        if(titlePolicy.layout.version===3&&row.emphasisText!==titlePolicy.titleEmphasis)valid=false;
        payload.title_observations.push({role,text:row.text,emphasisText:row.emphasisText,path:file.path,sha256:file.sha256,...(frame?{observed_path:frame.path,observed_frame:frame.frame}:{})});
        payload.evidence_files.push({path:file.path,sha256:file.sha256});
        if(frame)payload.evidence_files.push(...frame.evidence);
      }
      if(payload.result==='pass'&&!valid){payload.result='fail';payload.observations+='；缺少实际视频及两张封面同标题的逐字观察和文件绑定。';payload.evidence=payload.observations;}
    }
    if(check.check==='style_match'&&referenceProbe){
      const reference=await contained(referenceProbe.manifest,run);
      if(await fileHash(reference)!==referenceProbe.sha256)throw Error('风格参考证据已变化');
      for(const sheet of referenceProbe.contact_sheets)if(await fileHash(await contained(sheet.path,run))!==sheet.sha256)throw Error('风格参考抽帧已变化');
      const comparisons=check.referenceComparisons||[],observed=new Set(check.observedReferenceSheets||[]);
      const covered=referenceProbe.contact_sheets.every(s=>observed.has(s.id));
      const compared=['opening','development','ending'].every(section=>comparisons.some(c=>c.section===section&&Number.isInteger(c.candidateFrame)&&c.candidateFrame>=0&&c.candidateFrame<probe.frames&&Number.isInteger(c.referenceFrame)&&c.referenceFrame>=0&&c.referenceFrame<referenceProbe.frames&&typeof c.observations==='string'&&c.observations.trim()));
      const cited=evidence.some(e=>e.path===reference&&e.sha256===referenceProbe.sha256);
      payload.reference_comparisons=comparisons;payload.observed_reference_sheets=[...observed];payload.reference_probe_sha256=referenceProbe.sha256;
      if(payload.result==='pass'&&(!covered||!compared||!cited)){
        payload.result='fail';payload.observations+='；缺少试片实际画面对照：需要参考抽帧、开头/中段/收束的成片与参考帧比较及证据引用。';payload.evidence=payload.observations;
      }
    }
    // This worker only samples frames and measures audio. A legacy policy may
    // require playback/listening; it cannot acquire those capabilities by name.
    if(payload.result==='pass'&&methods[check.check]!==reviewMethods[check.check]){
      payload.result='unverified';
      payload.observations+='；旧项目要求 '+methods[check.check]+'，本次仅抽帧及客观音频检查，未完成该方法。';
      payload.evidence=payload.observations;
      payload.limitations=[...payload.limitations,'Legacy playback/listening policy was not satisfied by sampled review.'];
    }
    try{await bridge('record-review',{run,review:payload});}
    catch(error){
      // Objective evidence refusal is a failed check, not an excuse to bypass repair.
      if(!/Sampled review evidence invalid|Unresolved issues|Pass needs|Only music_fit without BGM/.test(error.message))throw error;
      payload.result='fail';payload.observations+='；客观验收拒绝：'+error.message;payload.evidence=payload.observations;
      await bridge('record-review',{run,review:payload});
    }
  }
  const video=candidate.files.find(f=>f.role==='video'),subtitles=candidate.files.find(f=>f.role==='subtitles');
  const audit=await bridge('review-audit',{run,file:video.path,subtitles:subtitles?.path});
  return enforceIndependentReview({...audit,independentJobId:job.id,independentThreadId:job.threadId,producerJobId:candidate.producerJobId,limitations:result.limitations||[]},run,candidate);
}
export async function enforceIndependentReview(report,run,candidate=null){
  if(candidate&&report.completed&&!independentOf(candidate,report.independentJobId,report.independentThreadId))throw Error('验收会话与制作或补证会话不独立。');
  const actual=JSON.parse(await readFile(path.join(run,'run.json'),'utf8'));
  const required=Object.entries(report.checks||{}).filter(([,check])=>check.method).map(([key])=>key);
  if(report.completed&&!required.length)throw Error('验收缺少逐项结果，不能交付。');
  const pending=required.filter(key=>{
    const review=actual.reviews?.[key];
    return !review||review.reviewer_job_id!==report.independentJobId||review.reviewer!==report.independentThreadId||review.producer_job_id!==report.producerJobId;
  });
  const policy=actual.production_plan?.plan?.productionPlan;
  if(report.completed&&candidate&&!concernsResolved(candidate,actual.reviews?.output_details)&&!pending.includes('output_details'))pending.push('output_details');
  if(report.completed&&policy?.layout?.mode==='portrait-centered'&&[2,3].includes(policy.layout.version)){
    const review=actual.reviews?.output_details;
    const rows=review?.title_observations||[],files=candidate?.files||[];
    const bound=review?.production_plan_sha256===actual.production_plan.sha256&&['video','cover_portrait','cover_landscape'].every(role=>{
      const matches=files.filter(f=>f.role===role),observed=rows.filter(r=>r.role===role);
      return matches.length===1&&observed.length===1&&matches[0].path===observed[0].path&&matches[0].sha256===observed[0].sha256&&typeof observed[0].text==='string'&&observed[0].text.replace(/\r\n|\n/g,'').trim()===String(policy.coverTitle||'').trim()&&(policy.layout.version!==3||observed[0].emphasisText===policy.titleEmphasis);
    });
    if(!bound&&!pending.includes('output_details'))pending.push('output_details');
  }
  return {...report,completed:report.completed&&!pending.length,review_pending:[...new Set([...(report.review_pending||[]),...pending])],checks:{...report.checks,...Object.fromEntries(pending.map(key=>[key,{...report.checks[key],status:'unverified',evidence_current:false,observations:'缺少本次独立验收记录；不能继承制作方或上轮结论。'}]))}};
}
class DeliveryPackageError extends Error{
  constructor(issues){super(issues.join('；'));this.issues=issues;}
}
export async function reviewDeliveryPackage(report,candidate,run,inspect){
  let issues=[];
  try{await validateDeliveryFiles(candidate,run,inspect);}
  catch(error){if(!(error instanceof DeliveryPackageError))throw error;issues=error.issues;}
  return {...report,completed:report.completed&&!issues.length,
    failures:[...(report.failures||[]),...(issues.length?['invalid_delivery_package']:[])],
    checks:{...report.checks,delivery_package:{status:issues.length?'fail':'pass',observations:issues.join('；')||'封面与发布文案文件校验通过。',issues}}};
}
export async function validateDeliveryFiles(candidate,run,inspect){
  await verifyCandidate(candidate,run);
  const issues=[];
  for(const [role,n,d] of [['cover_portrait',3,4],['cover_landscape',4,3]]){
    const files=candidate.files.filter(f=>f.role===role);if(files.length!==1){issues.push('缺少唯一封面：'+role);continue;}
    const bytes=await readFile(files[0].path);if(path.extname(files[0].path).toLowerCase()!=='.png'||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.includes(Buffer.from('acTL'))){issues.push('封面必须是实际静态 PNG：'+role);continue;}
    const info=await inspect(files[0].path);if(!info.width||!info.height||info.width*d!==info.height*n)issues.push('封面比例错误：'+role);
  }
  const copy=candidate.files.filter(f=>f.role==='copy');
  if(copy.length!==1)issues.push('缺少定稿发布文案 TXT。');
  else{
    const text=await readFile(copy[0].path,'utf8');
    if(path.extname(copy[0].path)!=='.txt'||!/^标题[：:]\s*\S.+/m.test(text)||!/^正文[：:]\s*\S[\s\S]+?^话题[：:]\s*#\S+/m.test(text))issues.push('发布文案需包含非空标题、正文及 #话题。');
  }
  if(issues.length)throw new DeliveryPackageError(issues);
}
