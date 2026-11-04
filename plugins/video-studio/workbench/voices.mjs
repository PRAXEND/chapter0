import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {unlink} from 'node:fs/promises';
import {publicUrl,saveUpload} from './media.mjs';

const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const string={type:'string'};
export const voiceRequestSchema=object({
  kind:{type:'string',enum:['none','clone_choice','voice_choice','clone_recording']},message:string,
  candidates:{type:'array',maxItems:12,items:object({key:string,name:string,summary:string,sampleUrl:string,provider:string,voiceId:string,voiceType:{type:'string',enum:['official','custom']}})}
});
import {consentText,defaultPreview} from './public/voice-ui.js';
export {consentText,defaultPreview};
const audioExtensions=new Set(['.aac','.flac','.m4a','.mp3','.ogg','.wav','.webm']);
const bounded=(value,max,label)=>{if(typeof value!=='string'||!value.trim()||[...value.trim()].length>max)throw new Error(`${label}无效。`);return value.trim();};

export async function normalizeVoiceRequest(raw,job){
  if(!raw||raw.kind==='none')return null; // Older jobs have no voice request.
  if(!['clone_choice','voice_choice','clone_recording'].includes(raw.kind))throw new Error('音色交互类型无效。');
  const candidates=[];
  if(raw.kind==='voice_choice'){
    if(!Array.isArray(raw.candidates)||!raw.candidates.length||raw.candidates.length>12)throw new Error('请先查询真实可试听的音色。');
    for(const c of raw.candidates){
      if(!['official','custom'].includes(c.voiceType))throw new Error('音色类型无效。');
      const sampleUrl=await publicUrl(c.sampleUrl);
      if(!sampleUrl.startsWith('https://'))throw new Error('音色试听需要安全的 HTTPS 链接。');
      const key=bounded(c.key,200,'音色选项');if(candidates.some(c=>c.key===key))throw new Error('音色选项重复。');
      candidates.push({key,name:bounded(c.name,200,'音色名称'),summary:String(c.summary||'').slice(0,1000),sampleUrl,provider:bounded(c.provider,100,'音色记录'),voiceId:bounded(c.voiceId,300,'音色记录'),voiceType:c.voiceType});
    }
  }
  return {id:randomUUID(),kind:raw.kind,message:String(raw.message||'').slice(0,2000),candidates,inputHash:job.inputHash,planHash:job.planHash,voiceScope:job.voiceScope||null,createdAt:new Date().toISOString()};
}
export function voiceScope(project){return createHash('sha256').update(JSON.stringify({intent:project.voiceIntent||'saved',narration:project.narration,selectionId:project.voiceSelectionId||null})).digest('hex');}
export function savedVoiceChoices(catalog,intent='saved'){
  const entries=[catalog.profile?.voice,...(catalog.savedVoices||[])],seen=new Set(),choices=[];
  for(const voice of entries){
    if(!voice||voice.selected_by_user!==true||!['official','custom'].includes(voice.voiceType))continue;
    if(['official','custom'].includes(intent)&&voice.voiceType!==intent)continue;
    const clean={voiceType:voice.voiceType,selected_by_user:true};
    try{for(const key of ['provider','voiceId','name']){clean[key]=bounded(voice[key],300,'已保存音色');if(/[\x00-\x1f]/.test(clean[key]))throw Error('无效音色');}}catch{continue;}
    const key=createHash('sha256').update(JSON.stringify([clean.provider,clean.voiceId])).digest('hex');
    if(seen.has(key))continue;seen.add(key);
    choices.push({...clean,key,summary:'已保存的音色，可直接选用。',sampleUrl:''});
  }
  return choices;
}
export function savedVoiceRequest(project,candidates,inputHash){
  return {id:randomUUID(),kind:'voice_choice',source:'saved_catalog',message:'选择已保存的音色，无需后台查询。',candidates,inputHash,planHash:null,voiceScope:voiceScope(project),voiceIntent:project.voiceIntent||'saved',voiceSelectionId:project.voiceSelectionId||null,createdAt:new Date().toISOString()};
}
export function pendingVoiceRequest(project,inputHash){
  if(!project.narration)return null;
  const local=project.voiceSelectionRequest;
  if(local&&!local.answeredAt&&local.voiceScope===voiceScope(project))return local;
  const job=project.jobs.find(j=>['voice','produce','create'].includes(j.action)),r=job?.voiceRequest;
  if(['voice','create'].includes(job?.action))return job.status==='needs_input'&&r&&!r.answeredAt&&r.voiceScope===voiceScope(project)?r:null;
  return job?.status==='needs_input'&&r&&!r.answeredAt&&r.inputHash===inputHash&&r.planHash===project.approval?.planHash?r:null;
}
export function requireVoiceRequest(project,inputHash,id){
  const request=pendingVoiceRequest(project,inputHash);
  if(!request||request.id!==id)throw new Error('音色请求已处理或方案已变化，请刷新后继续。');
  return request;
}
export function voiceAnswer(request,payload){
  if(payload.action==='official'&&['clone_choice','clone_recording','voice_choice'].includes(request.kind))return {action:'official'};
  if(payload.action==='clone'&&['clone_choice','voice_choice'].includes(request.kind))return {action:'clone'};
  if(request.kind==='voice_choice'&&payload.action==='select'){
    const candidate=request.candidates.find(c=>c.key===payload.key);
    if(!candidate)throw new Error('请选择当前列表中的音色。');
    return {action:'select',voice:{...candidate,selected_by_user:true}};
  }
  if(request.kind==='clone_recording'&&payload.action==='recording'){
    if(payload.consent!==true)throw new Error('请确认音色授权后再提交录音。');
    const name=bounded(payload.name,80,'音色名称');
    const previewText=bounded(String(payload.previewText||'').trim()||defaultPreview,100,'试听文本（最多 100 字）');
    return {action:'recording',name,previewText,confirmedConsent:true,consentText};
  }
  throw new Error('当前音色步骤不支持这个操作。');
}
export function recordVoiceAnswer(project,request,answer){
  const answeredAt=new Date().toISOString();
  (project.voiceAnswers??=[]).push({...answer,requestId:request.id,voiceScope:request.voiceScope||null,inputHash:request.inputHash,planHash:request.planHash,answeredAt});
  request.answeredAt=answeredAt;
}
export function voiceContext(project,inputHash,savedVoice=null){
  return {intent:project.voiceIntent||'saved',savedVoice:project.voiceChoice||savedVoice,answers:(project.voiceAnswers||[]).filter(a=>a.voiceScope?a.voiceScope===voiceScope(project):a.inputHash===inputHash&&a.planHash===project.approval?.planHash)};
}
export async function saveVoiceRecording(readable,{name,run,inspect}){
  const ext=path.extname(name).toLowerCase();
  if(!audioExtensions.has(ext))throw new Error('录音支持 AAC、FLAC、M4A、MP3、OGG、WAV、WebM。');
  const file=path.join(run,'voice-references',randomUUID()+ext);
  try{
    await saveUpload(readable,file,25*1024*1024);
    const info=await inspect(file);
    if(!info.hasAudio||!Number.isFinite(info.duration)||info.duration<10||info.duration>180)throw new Error('请提供 10 秒至 3 分钟的有效录音，建议 30–60 秒清晰独白。');
    return {path:file,sha256:info.sha256,duration:info.duration,bytes:info.bytes};
  }catch(e){await unlink(file).catch(()=>{});throw e;}
}
