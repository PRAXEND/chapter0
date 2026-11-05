import path from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {contained,fileHash} from './media.mjs';

export const reviewMethods={visuals:'sampled_composited_frames',occlusion:'sampled_composited_frames',portrait_layout:'sampled_composited_frames',material_continuity:'sampled_source_windows',transitions:'boundary_frames_and_signal_scan',caption_flow:'boundary_frames_and_signal_scan',flicker:'boundary_frames_and_signal_scan',audio_listening:'objective_audio_metrics',av_sync:'timeline_words_and_audio_metrics',music_fit:'objective_mix_and_context',caption_sync:'word_alignment_and_frames',output_details:'export_and_boundary_inspection',facts:'source_review',style_match:'reference_comparison'};
export function assertCanProduce(cycle,planHash,inputHash){
  if(!cycle?.candidate||cycle.candidate.planHash!==planHash||cycle.candidate.inputHash!==inputHash)return;
  if(cycle.terminal==='quality_failed'||cycle.repairCompleted)throw Error('当前方案已完成一轮返工，请继续验收或处理问题并更新方案，不能再次返工。');
  if(cycle.report===null)throw Error('已有待验收成片，请继续独立验收，不要重新制作。');
}
export async function bindCandidate(result,run,job,recoverSubtitles){
  if(result.status!=='exported'||!Array.isArray(result.files))throw Error('没有实际完成的导出。');
  if(!result.projectId||!result.timelineId||!job.threadId||!job.toolCalls?.some(t=>/chatcut/i.test(t.server+' '+t.tool)&&/submit_export|track_export/.test(t.tool)&&t.status==='completed'))throw Error('缺少真实 ChatCut 工程、制作会话或导出调用记录。');
  const record=JSON.parse(await readFile(path.join(run,'run.json'),'utf8'));
  if(record.project?.projectId!==result.projectId||record.project?.timelineId!==result.timelineId)throw Error('候选与实际 ChatCut 工程不一致。');
  if(!job.planHash||!job.inputHash||record.project.planHash!==job.planHash||record.project.inputHash!==job.inputHash)throw Error('候选工程未绑定当前制作方案与输入。');
  const files=[];
  for(const item of result.files){
    if(item.role==='subtitles' && record.settings?.captions && recoverSubtitles){
      try{const file=await contained(path.resolve(run,item.path),run);if(!(await readFile(file,'utf8')).trim())continue;}
      catch{continue;}
    }
    const file=await contained(path.resolve(run,item.path),run),info=await stat(file);
    if(!info.isFile()||!info.size)throw Error('导出文件为空。');
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
  return {...result,files,producerJobId:job.id,producerThreadId:job.threadId||null,inputHash:job.inputHash,planHash:job.planHash};
}
export async function verifyCandidate(candidate,run){
  if(!candidate?.files?.length)throw Error('缺少待验收成片。');
  for(const f of candidate.files)if(await fileHash(await contained(f.path,run))!==f.sha256)throw Error('待验收文件已变化，需要重新登记导出。');
  return candidate.files.find(f=>f.role==='video');
}
// Recover only an already-registered rejection for this exact producer, edit and evidence.
export async function recoverFailedReview(audit,last,candidate,run){
  if(!last.threadId||last.threadId===candidate.producerThreadId||audit.completed)return null;
  let previous;
  try{previous=JSON.parse(await readFile(path.join(last.directory,'request.json'),'utf8'));}catch{return null;}
  const probe=previous?.probe;
  const video=candidate.files.find(f=>f.role==='video'),subtitle=candidate.files.find(f=>f.role==='subtitles');
  if(!probe||previous.candidate?.producerJobId!==candidate.producerJobId||probe.artifact_sha256!==video?.sha256||probe.subtitle_sha256!==(subtitle?.sha256||null))return null;
  const record=JSON.parse(await readFile(path.join(run,'run.json'),'utf8'));
  if(probe.revision!==record.revision||!probe.evidence_files?.length)return null;
  for(const ref of probe.evidence_files){
    try{if(await fileHash(await contained(ref.path,run))!==ref.sha256)return null;}catch{return null;}
  }
  const rejected=Object.entries(audit.checks).some(([key,check])=>{
    const actual=record.reviews?.[key];
    return check.status==='fail'&&actual?.reviewer_job_id===last.id&&actual.reviewer===last.threadId
      &&actual.producer_job_id===candidate.producerJobId&&actual.artifact_sha256===video.sha256
      &&actual.revision===record.revision;
  });
  if(!rejected)return null;
  return enforceIndependentReview({...audit,completed:false,independentJobId:last.id,independentThreadId:last.threadId,
    producerJobId:candidate.producerJobId,limitations:['恢复了中断前登记的独立验收问题，未登记项目保留为待核验。']},run);
}

export async function registerIndependentReview({result,job,candidate,probe,run,bridge,methods=reviewMethods,referenceProbe=null,requiredChecks=null}){
  if(!job.threadId||job.threadId===candidate.producerThreadId||job.id===candidate.producerJobId)throw Error('缺少独立验收会话，拒绝使用制作 Agent 自评。');
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
    if(check.check==='caption_flow')payload.caption_observations=check.captionObservations||[];
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
  return enforceIndependentReview({...audit,independentJobId:job.id,independentThreadId:job.threadId,producerJobId:candidate.producerJobId,limitations:result.limitations||[]},run);
}
export async function enforceIndependentReview(report,run){
  const actual=JSON.parse(await readFile(path.join(run,'run.json'),'utf8'));
  const required=Object.entries(report.checks||{}).filter(([,check])=>check.method).map(([key])=>key);
  if(report.completed&&!required.length)throw Error('验收缺少逐项结果，不能交付。');
  const pending=required.filter(key=>{
    const review=actual.reviews?.[key];
    return !review||review.reviewer_job_id!==report.independentJobId||review.reviewer!==report.independentThreadId||review.producer_job_id!==report.producerJobId;
  });
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
