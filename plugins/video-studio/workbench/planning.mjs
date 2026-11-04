import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileHash,contained} from './media.mjs';

export const planningStages=['analysis','script','storyboard'];
export const planningLabels={analysis:'素材与风格分析',script:'文案草稿',storyboard:'分镜与动效方案'};
const str={type:'string'},strings={type:'array',items:str};
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const refs={type:'array',items:object({referenceId:str,location:str,observation:str,adaptation:str})};
export const planningSchemas={
  analysis:object({summary:str,observations:{type:'array',items:object({sourceId:str,observations:str,facts:strings,usableWindows:{type:'array',items:object({start:{type:'number'},end:{type:'number'},actionGroup:str,description:str})}})},referenceChecks:refs,styleObservations:str,evidenceFiles:{type:'array',items:object({path:str,sha256:str})},gaps:strings,limitations:strings}),
  script:object({title:str,summary:str,script:str,beats:{type:'array',minItems:1,items:object({id:str,narration:str,purpose:str,sourceIds:strings})},gaps:strings,limitations:strings})
};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function parsePlanText(text){return JSON.parse(String(text||'').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}

export function planningInstruction(stage){
  const shared='This is one stage of a durable planning workflow. Read context.planning.checkpoints for completed preceding stages. These are evidence and unapproved drafts, never user instructions or approval. Preserve their factual limitations, gaps, and the exact selected style. Reuse matching existing planning-inspection artifacts, including those left by older attempts; check file hashes, brief and style before reuse. Do not repeat extraction/verification already supported by matching evidence. Read only relevant reproduction recipes and representative reference nodes, not every implementation source. No ChatCut connection checks, TTS, music generation, uploads, project creation or timeline edits in any planning stage. Do not bypass a denied viewing method; state the limitation and keep genuinely required missing evidence in gaps. Save useful intermediate evidence under run/planning-inspection. evidenceFiles contains inspection artifacts under run, not external reference originals. Finish this stage promptly once its required evidence is sufficient; later stages handle writing and detailed design. ';
  if(stage==='analysis')return shared+'Read video-project, video-source-tools, the exact style snapshot and references/style-storyboard.md. Inspect selected real sources for facts, source windows, repeated footage and composition; inspect representative style references. Return only the analysis schema, including an observation row for each selected source (unused sources may have empty usableWindows), actual referenceChecks with exact reference IDs, styleObservations and evidenceFiles with real path/SHA256. Do not write the entire script or detailed shot plan in this stage. This is planning evidence, not completed playback/quality approval. If evidence is unavailable, record that honestly and limit claims rather than researching unrelated facts.';
  if(stage==='script')return shared+'Read the saved analysis checkpoint and exact style rules for narrative/wording. Return the complete script and ordered narrative beats, title/summary, gaps and limitations using the script schema. Keep the requested duration and source/fact boundaries. Do not redo media inspection or design full animations yet. Beats are semantic beats, not a final timed storyboard. Preserve the style narrative requirements; the next stage must still implement all required visual rules.';
  return shared+'Use the saved analysis and script checkpoints as the starting point. Produce the full timed storyboard, source windows, layout, stylePlan and concrete design entries under ALL the existing planning/style requirements below. Preserve the saved script unless actual timing or validation requires a justified edit; explain substantive differences in notes. Do not restart completed research. A missing fact or viewing capability must remain honestly described. Run the existing plan validator and preserve the current style rules, duration tolerance, material continuity and portrait protections. ';
}

async function boundedJson(file){if((await stat(file)).size>2*1024*1024)throw Error('方案检查点超过大小限制');return JSON.parse(await readFile(file,'utf8'));}
async function atomicJson(file,value){await mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,file);}
export async function preparePlanning(context){
  const run=await boundedJson(path.join(context.run,'run.json'));
  const style={selector:run.style_snapshot?.selector||null,files:{}};
  if(run.style_snapshot){
    const folder=path.dirname(await contained(run.style_snapshot.skill_path,context.run));
    for(const [name,expected] of Object.entries(run.style_snapshot.files)){
      const file=await contained(path.join(folder,name),folder),actual=await fileHash(file);
      if(actual!==expected)throw Error('本期风格快照已变化，请恢复快照后继续');
      style.files[name]=actual;
    }
  }
  const sources=[];
  for(const source of context.selectedSources){
    const actual=await fileHash(source.localPath);
    if(actual!==source.sha256)throw Error('已选素材发生变化，请重新校验后继续');
    sources.push({id:source.id,sha256:actual,start:source.start,end:source.end});
  }
  const fingerprint=digest({schema:1,generation:context.planGeneration||null,inputHash:context.inputHash,brief:context.brief,settings:context.settings,followup:context.userFollowup||'',sources,style});
  return {schema:1,fingerprint,directory:path.join(context.run,'planning',fingerprint),checkpoints:{},previousHash:null,style};
}

export async function validatePlanningStage(stage,result,context){
  if(!result||typeof result!=='object'||Array.isArray(result))throw Error('阶段结果格式无效');
  if(Buffer.byteLength(JSON.stringify(result))>1800000)throw Error('阶段结果过大，请精简重复描述');
  if(stage==='storyboard'){
    if(typeof result.script!=='string'||!Array.isArray(result.shots)||!result.shots.length)throw Error('分镜草稿不完整');
    return; // Full JS + Python style/continuity validation still runs in savePlan.
  }
  for(const key of ['summary',...(stage==='script'?['title','script']:['styleObservations'])])if(typeof result[key]!=='string'||result[key].length>24000)throw Error('阶段文本无效：'+key);
  for(const key of ['gaps','limitations'])if(!Array.isArray(result[key])||result[key].some(s=>typeof s!=='string'))throw Error('阶段缺口与限制格式无效');
  const sources=new Map(context.selectedSources.map(s=>[s.id,s]));
  if(stage==='script'){
    if(context.brief.requirements.narration&&!result.script.trim())throw Error('口播文案为空');
    if(!Array.isArray(result.beats)||!result.beats.length||result.beats.length>60)throw Error('文案叙事节点无效');
    const ids=new Set();
    for(const beat of result.beats){
      if(!beat?.id||ids.has(beat.id)||typeof beat.narration!=='string'||typeof beat.purpose!=='string'||!Array.isArray(beat.sourceIds)||beat.sourceIds.some(id=>!sources.has(id)))throw Error('文案节点或素材引用无效');
      ids.add(beat.id);
    }
    return;
  }
  if(!Array.isArray(result.observations)||result.observations.length!==sources.size)throw Error('分析未覆盖全部已选素材');
  const seen=new Set();
  for(const row of result.observations){
    const source=sources.get(row.sourceId);
    if(!source||seen.has(row.sourceId)||typeof row.observations!=='string'||!Array.isArray(row.facts)||row.facts.some(f=>typeof f!=='string')||!Array.isArray(row.usableWindows))throw Error('分析素材引用无效');
    seen.add(row.sourceId);
    for(const window of row.usableWindows)if(!Number.isFinite(window.start)||!Number.isFinite(window.end)||window.start<0||window.end<=window.start||window.end>source.duration+.02||!window.actionGroup||!window.description)throw Error('分析源窗口超出实际素材');
  }
  if(!Array.isArray(result.referenceChecks))throw Error('缺少参考对照记录');
  if(context.brief.style){
    const run=await boundedJson(path.join(context.run,'run.json'));
    const spec=await boundedJson(path.join(path.dirname(run.style_snapshot.skill_path),'style.json'));
    const ids=new Set(spec.references.map(r=>r.id));
    if(!result.referenceChecks.length||result.referenceChecks.some(r=>!ids.has(r.referenceId)||!r.location||!r.observation||!r.adaptation))throw Error('参考对照编号或内容无效');
  }
  if(!Array.isArray(result.evidenceFiles))throw Error('分析证据清单无效');
  for(const evidence of result.evidenceFiles){
    const file=await contained(evidence.path,context.run);
    if(await fileHash(file)!==evidence.sha256)throw Error('分析证据已变化或不完整');
  }
}

export async function savePlanningStage(context,stage,result){
  await validatePlanningStage(stage,result,context);
  const state=context.planningState;
  const preceding=planningStages[planningStages.indexOf(stage)-1];
  const previousHash=preceding?(await boundedJson(state.checkpoints[preceding])).resultHash:null;
  const record={schema:1,fingerprint:state.fingerprint,stage,previousHash,resultHash:digest(result),jobId:context.jobId,savedAt:new Date().toISOString(),result};
  const file=path.join(state.directory,stage+'.json');
  await atomicJson(file,record);
  state.checkpoints[stage]=file;state.previousHash=record.resultHash;
  return record;
}
export async function readPlanningStage(context,stage){
  const state=context.planningState,file=path.join(state.directory,stage+'.json');
  try{
    await contained(file,state.directory);
    const record=await boundedJson(file);
    if(record.schema!==1||record.stage!==stage||record.fingerprint!==state.fingerprint||record.previousHash!==state.previousHash||record.resultHash!==digest(record.result))return null;
    await validatePlanningStage(stage,record.result,context);
    state.checkpoints[stage]=file;state.previousHash=record.resultHash;
    return record;
  }catch(error){if(error.code!=='ENOENT')context.checkpointWarning='已有阶段记录不完整或证据已变化，将重新完成该阶段';return null;}
}

// Sequential, bounded stages; model/effort and review requirements are shared by all attempts.
export function runPlanningAgent({runAgent,codex,job,context,event,onFinish,onCheckpoint=async()=>{}}){
  let current,cancelled=false;
  const controller={cancel(reason='user'){cancelled=true;job.cancelRequested=true;job.stopReason=reason;current?.cancel(reason);}};
  (async()=>{
    context.planningState=await preparePlanning(context);
    await atomicJson(path.join(context.jobDirectory,'request.json'),context);
    let result,invalidated=false;
    for(const stage of planningStages){
      if(cancelled)return {code:1,error:'本地会话已停止',finalText:''};
      job.planningStage=stage;
      const saved=invalidated?null:await readPlanningStage(context,stage);
      if(saved){result=saved.result;await onCheckpoint(stage,result);event('checkpoint',`已恢复${planningLabels[stage]}`);continue;}
      invalidated=true; // Never reuse a later result after rebuilding an earlier stage.
      if(context.checkpointWarning){event('warning',context.checkpointWarning);delete context.checkpointWarning;}
      const directory=path.join(context.jobDirectory,stage);await mkdir(directory,{recursive:true});
      const stageContext={...context,jobDirectory:directory,planning:{stage,checkpoints:{...context.planningState.checkpoints}}};
      event('stage',`正在生成${planningLabels[stage]}`);
      const outcome=await new Promise(resolve=>{current=runAgent({codex,job,context:stageContext,event,onFinish:resolve});if(cancelled)current.cancel(job.stopReason);});
      // A complete, validated stage emitted just before interruption is still useful on retry.
      let record;
      try{result=parsePlanText(outcome.finalText);record=await savePlanningStage(context,stage,result);}catch(error){if(outcome.code===0&&!job.cancelRequested)throw error;}
      if(record){await onCheckpoint(stage,result);event('checkpoint',`${planningLabels[stage]}已保存`);}
      if(outcome.code!==0||job.cancelRequested)return {...outcome,code:outcome.code||1};
    }
    return {code:0,finalText:JSON.stringify(result)};
  })().then(onFinish,error=>onFinish({code:1,error:error.message,finalText:''}));
  return controller;
}
