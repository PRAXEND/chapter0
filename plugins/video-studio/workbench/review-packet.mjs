import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileHash,contained} from './media.mjs';
import {reviewMethods,validateDeliveryFiles} from './quality.mjs';

export async function prepareReviewPacket(context,inspect){
  const {probe,candidate,run,jobDirectory}=context;
  const manifest=JSON.parse(await readFile(probe.manifest,'utf8')),metrics=JSON.parse(await readFile(probe.metrics,'utf8'));
  const issues=[];
  const add=(check,text)=>issues.push({check,text});
  for(const [check,message] of Object.entries(metrics.requirement_errors||{}))add(check,message);
  for(const message of candidate.unresolvedIssues||[])add('producer_unresolved',message);
  if(candidate.qaStatus==='failed')add('producer_unresolved',candidate.summary||'制作方已报告未解决问题。');
  try{await validateDeliveryFiles(candidate,run,inspect);}catch(error){add('delivery_package',error.message);}
  if(context.brief.requirements.captions&&!candidate.files.some(f=>f.role==='subtitles'))add('caption_sync','缺少实际字幕文件。');
  for(const name of ['audio','speech_activity','narration_alignment'])for(const error of metrics[name]?.hard_failures||[])add(name,error);
  if(context.brief.requirements.narration){
    for(const name of ['speech_activity','narration_alignment'])if(metrics[name]?.status!=='checked')add(name,'缺少完整的实际旁白与最终混音对齐证据。');
  }
  if(!manifest.timeline_complete)add('visuals','缺少完整时间线，不能覆盖所有实际边界。');
  const sync=metrics.sync;
  if(context.brief.requirements.captions){
    if(sync?.status!=='checked')add('caption_sync',sync?.reason||'缺少字幕对齐证据。');
    else{
      const r=sync.report||{},c=r.caption_sync;
      if(!c?.coverage_complete)add('caption_sync','字幕与实际词时间文字不一致：'+JSON.stringify(c?.text_differences||[]));
      if(c?.outside_frame_tolerance?.length)add('caption_sync','字幕超出现有时间容差，需调整这些字幕卡：'+c.outside_frame_tolerance.join('、'));
      if(r.source_window_issues?.length)add('caption_sync','旁白源窗口存在截词/重复：'+JSON.stringify(r.source_window_issues));
      if(!r.export_matches_cards?.matches)add('caption_sync','导出字幕与实际字幕卡不一致：'+JSON.stringify(r.export_matches_cards));
    }
  }
  const evidence=[];
  for(const file of [probe.manifest,probe.metrics,...candidate.files.filter(f=>['qa','sources'].includes(f.role)).map(f=>f.path)]){
    const safe=await contained(file,run);evidence.push({path:safe,sha256:await fileHash(safe)});
  }
  const objective=structuredClone(metrics);
  // Keep all conclusions/candidates; long successful measurement series stay in the hashed raw evidence.
  if(Array.isArray(objective.audio?.windows)){objective.audio.window_count=objective.audio.windows.length;delete objective.audio.windows;objective.audio.full_windows=probe.metrics+'#/audio/windows';}
  if(Array.isArray(objective.narration_alignment?.windows)){
    const windows=objective.narration_alignment.windows;
    objective.narration_alignment.window_count=windows.length;
    objective.narration_alignment.windows=windows.filter(w=>w.status!=='pass');
    objective.narration_alignment.full_windows=probe.metrics+'#/narration_alignment/windows';
  }
  const coverage={...manifest,sample_frame_count:manifest.sample_frames?.length};delete coverage.sample_frames;
  const packet={schema:1,artifactSha256:probe.artifact_sha256,subtitleSha256:probe.subtitle_sha256,
    requiredChecks:context.requiredChecks||Object.keys(reviewMethods),coverage,objective,preflightIssues:issues,
    delta:context.reviewDelta||null,evidence,
    instructions:'These are deterministic measurements, not independent visual approval. For each coverage.caption_samples frame, read the actual visible subtitle from that MP4 frame; use review-frames at native resolution if needed. Return captionObservations in the caption_flow check with frame and transcribed text; if invisible or illegible report failure. Inspect every listed contact sheet; declare actual globally observed sheet IDs once. Use original-size/native-rate frames for uncertain details. All contact sheets remain listed; read hashed detailed metrics when investigating measurements. Return concise observations and each issue once. Do not author report-building scripts, recompute already current deterministic metrics, or repeat schema/hash bookkeeping. Never relax a failing metric; return the precise failure or missing evidence.'};
  const file=path.join(jobDirectory,'review-packet.json');await writeFile(file,JSON.stringify(packet,null,2));
  return {file,sha256:await fileHash(file),packet,report:issues.length?{completed:false,preflight:true,artifact_sha256:probe.artifact_sha256,
    failures:issues.map(i=>i.check),checks:Object.fromEntries([...new Set(issues.map(i=>i.check))].map(check=>[check,{status:'fail',observations:issues.filter(i=>i.check===check).map(i=>i.text).join('；'),issues:issues.filter(i=>i.check===check).map(i=>i.text)}]))}:null};
}
