import {readFile,writeFile,rename,stat} from 'node:fs/promises';
import path from 'node:path';
import {contained,fileHash} from './media.mjs';

// A file checkpoint keeps the creative work in one model session. Only the host
// validates/adopts it and supplies the hashes that authorize the actual export.
export function productionCheckpointReader({job,context,adopt,event=()=>{}}){
  let seen='',prepared=null,pending=Promise.resolve();
  return ()=>{
    pending=pending.catch(()=>{}).then(async()=>{
      if(job.cancelRequested)return;
      const file=context.productionCheckpointPath;
      let raw;
      try{await contained(file,context.jobDirectory);if((await stat(file)).size>1800000)throw Error('制作检查点过大');raw=await readFile(file,'utf8');}
      catch(error){if(error.code==='ENOENT')return;throw error;}
      if(raw===seen)return;
      let value;try{value=JSON.parse(raw);}catch{return;} // Atomic writer is preferred; tolerate partial writes.
      let response;
      if(prepared?.raw===raw)response=prepared.response;
      else{
        try{
          if(!value||value.jobId!==job.id||value.schema!==1||typeof value.requestId!=='string'||!value.requestId.trim())throw Error('制作检查点不属于当前任务或缺少 requestId');
          response={ok:true,...await adopt(value)};event('checkpoint','选材与制作方案已保存，在当前会话继续剪辑');
        }catch(error){response={ok:false,error:String(error.message).slice(0,2000)};event('warning','制作检查点需局部修正：'+response.error);}
        prepared={raw,response};
      }
      if(job.cancelRequested)return;
      const output=context.productionCheckpointResultPath,tmp=output+'.tmp';
      await writeFile(tmp,JSON.stringify({schema:1,jobId:job.id,requestId:value?.requestId??null,...response}),{mode:0o600});await rename(tmp,output);
      seen=raw;
    });
    return pending;
  };
}

export async function inspectPreparation(value,run,requirements,inspect){
  if(!Array.isArray(value.sources)||!value.sources.length||value.sources.length>24)throw Error('需要本次实际使用的素材清单（最多 24 条）');
  if(!value.editorial?.title?.trim()||value.editorial.title.length>200||typeof value.editorial.rationale!=='string')throw Error('缺少具体选题及选择依据');
  if(!['none','source','instrumental'].includes(value.editorial.music)||typeof value.editorial.captions!=='boolean')throw Error('声音与字幕方案无效');
  const ids=new Set(),files=[];
  for(const source of value.sources){
    if(typeof source.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(source.id)||ids.has(source.id)||typeof source.title!=='string'||!source.title.trim())throw Error('素材编号或标题无效');
    ids.add(source.id);
    const file=await contained(source.localPath,run),actual=await inspect(file);
    if(source.sha256!==actual.sha256||source.sha256!==await fileHash(file))throw Error('素材哈希不匹配：'+source.id);
    if(actual.bytes>350*1024*1024)throw Error('素材超过单文件预算');
    const kind=/\.(png|jpe?g|webp|gif)$/i.test(file)?'image':actual.hasVideo?'video':'audio';
    const start=source.start??0;
    if(!Number.isFinite(start)||start<0)throw Error('原片起点无效');
    files.push({...source,...actual,localPath:file,kind,status:'ready',start,end:start+actual.duration});
  }
  const unique=[...new Map(files.filter(f=>f.kind==='video').map(f=>[f.sha256,f])).values()];
  if(unique.length>requirements.max_video_sources||unique.reduce((n,s)=>n+s.duration,0)>requirements.max_download_seconds+.1)throw Error('素材超过本期采集预算');
  if(value.plan?.gaps?.length)throw Error('先在本会话解决实际方案缺口：'+value.plan.gaps.join('；'));
  return files;
}

export const continuousInstruction=`You own this automatic video from source choice through editable export in ONE continuous session. Do not run a separate discover/curate/analysis/script/storyboard/review-plan agent or generate a candidate-count report. Read references/continuous-production.md and the compact context.productionContext.style.guide first. Load specific source/audio/edit tool instructions only when using those tools.
Unless context.advancedOverrides.music is true, choose music from the selected style and saved preferences; the initial settings.music value is unresolved, not a user request for silence. A style requiring background music must receive its specified music. An explicit no-music override must be respected. Save the decision in editorial.music at the checkpoint. When context.advancedOverrides.captions is true, honor brief.requirements.captions exactly and return the same editorial.captions value: true requires synchronized speech captions and an actual SRT export; false disables generated captions. Style governs caption appearance and placement, never permission to silently disable an enabled caption setting. Choose a concrete story within the user's direction using visually strong real footage. If the topic is already a specific event, work on that event. Inspect a few useful source windows and a representative style benchmark; write and cut around what is actually visible. Reuse context.selectedSources, knownSources and matching cached files. Fetch only a real missing shot/fact. SearchLimit is not a quota in this mode. Enough factual support and usable action coverage means stop searching and start the cut. Respect the requested min_seconds/max_seconds range. When a minimum is set, select a story with enough useful content and varied source coverage, and estimate narration at the chosen speech rate before formal TTS. Verify actual audio and timeline length before export. If content is insufficient, supplement relevant facts/action or report the gap; never silently shorten below the minimum, loop footage, freeze frames, slow speech, extend silence or pad with empty cards. Only when min_seconds is null is duration solely a ceiling. Keep actual media/action readable and prominent; adapt the reference to the output ratio instead of shrinking everything into a fixed small inset. A safe bottom inset protects important bounds, not an instruction to add a permanent border or information panel.
Before spending on the full narration or building every scene, assemble the opening and one representative style-critical passage from actual footage in the existing editable project. Inspect its composed frames against the real reference for subject scale, text hierarchy, motion expression and protected bounds. Correct weak style locally before propagating the design. Put the actual composed timeline frame ranges, reference timestamps, observations and corrections in the checkpoint stylePlan.referenceChecks/contrastReview; distinguish observed rough-assembly results from planned treatments. Do this in the same session using editor frames, without a separate agent, trial render or full duplicate review. During later assembly check each new visual treatment at its actual word/action anchor; reuse validated components without repeating identical checks. Keep a small script/shot working draft in run, refine it while inspecting and assembling. The user's autonomous authorization includes source collection and editable rough assembly. Before formal TTS, and whenever the actual story/source selection changes, submit one compact production checkpoint with the full current plan to context.productionCheckpointPath using an atomic write. Its JSON schema is in context.productionCheckpointSchemaPath: {schema:1,jobId,requestId:new unique string,editorial:{title,rationale,captions,music},sources:[{id,title,localPath,sha256,url,author,rights,start,...source metadata}],plan:<plan schema>}. Sources must be real files inside run with actual hashes; start is their original source offset. Include only adopted media. The host verifies files and plan and writes context.productionCheckpointResultPath with the same requestId, ok, planHash, inputHash, approval, and productionContext, or a specific error. Wait for that exact response, fix only an actual error in this session, and use the returned hashes for all further project/operation/candidate records. Do not repeatedly resubmit an unchanged checkpoint. Do not write your own host response or approval. An accepted checkpoint is delegated self-review of the script, not final quality approval. Use the stable context.creativeId when recovering the same project; do not create another project because a checkpoint version changed. If context.approval is already current, recover its plan and existing operations directly. Persist actual project/timeline/task IDs immediately. The project record must include projectId, timelineId, creativeId, and the latest accepted planHash/inputHash; update those hashes when adopting a changed checkpoint on the same project.
Use the exact selected voice in context.voice and run settings; voice was resolved before this session. Do not ask for another voice or reinterpret an old null setting as a missing source. Never bypass an actual permission denial. Technical/permission/voice issues are blocked/needs_input with a precise recovery action, never a reason to restart topic research. Sampled visual review and objective audio are the active policy; no separate render/playback/listening gate before assembling the full cut. Inspect difficult effects using composed frames in the current editor and adjust locally.
Implement in hosted ChatCut, retaining independently editable source clips, speech, captions, music and graphics. Do not locally render the final film. Once the plan checkpoint is accepted, overlap independent music/narration submissions and media imports with visual editing that does not depend on their results. Save each operation ID immediately; do not poll tightly or duplicate submissions. Wait for actual audio before final timing and subtitle alignment. Reserve/recover actual external operations and query unknown status before resubmission. Follow installed hosted import/export tools for this environment. Browser availability is not editor-executor availability. A completed render awaiting download must be recovered by renderId/expectedFilename, not rerendered. Keep the user's model and style fixed. Record workbench-progress.json after meaningful milestones with this jobId and stage sourcing|drafting|importing|narration|editing|exporting.
Before full export run scripts/review_sync.py against actual words, source windows, caption cards and SRT and fix any existing text/coverage/timing failures without relaxing tolerances or inventing corrected word evidence. During editing inspect real motion extrema for cropping and overlays. After the actual export, save review-evidence.json, real word timestamps, full paginated timeline, actual voice_files and source-cuts.json as specified in production-policy.md/diagnostics.md, and actual beats/source_uses/layout_result/design_results. Return the candidate MP4, SRT when enabled, both PNG covers and publishing TXT inside run. Do not perform a second full self-audit or claim independent quality approval: the host starts the separate reviewer. Do not mark unobserved checks passed. If work is interrupted preserve the current project, checkpoint, source files and pending operation IDs for recovery.`;
