import {createHash,randomUUID} from 'node:crypto';
import {voiceScope} from './voices.mjs';

export const automaticStages=['voice','create','review','delivery'];
export const automaticAuthorization='一键生成：由 AI 按本期主题方向、时长范围、画幅、指定风格与音色自主选题、选材、审阅具体文案分镜、制作及独立验收；授权上传本期选用素材、按已选音色配音和按风格生成配乐、编辑 ChatCut 时间线及下载导出；克隆仅限用户已提交完整授权的录音，不授权发布；验收失败即暂停并保留完整临时交付，用户确认具体修订后才继续；正式交付必须验收通过。';
export function requestHash(p){return createHash('sha256').update(JSON.stringify({mode:p.mode,topic:p.topic,duration:p.duration,...(p.durationMin!=null?{durationMin:p.durationMin}:{}),ratio:p.ratio,fps:p.fps,language:p.language,style:p.styleSelector,styleDescription:p.styleDescription,voice:p.voiceIntent||'saved',voiceChoice:p.voiceChoice||null,voiceDirection:p.voiceDirection,portraitBottomInset:p.portraitBottomInset,...(p.productionRules===2?{captions:p.captions,music:p.music,narration:p.narration}:{}),advanced:Object.fromEntries(Object.keys(p.advancedOverrides||{}).filter(k=>p.advancedOverrides[k]).sort().map(k=>[k,p[k]]))})).digest('hex');}
function hasCurrentCandidate(p){const c=p.qualityCycle?.candidate;return !!(c&&p.approval&&c.planHash===p.approval.planHash&&c.inputHash===p.approval.inputHash);}
function voiceReady(p){return !p.narration||!!(p.voiceChoice?.provider&&p.voiceChoice?.voiceId&&p.voiceChoice.selected_by_user&&p.voiceReady?.scope===voiceScope(p));}
export function beginAutomatic(p){
  if(!p.topic?.trim())throw Error('请填写主题方向。');
  if(!p.styleSelector)throw Error('请选择本期风格。');
  if(!['9:16','16:9'].includes(p.ratio))throw Error('一键模式请选择竖版或横版。');
  if(p.automatic?.requestHash===requestHash(p)&&p.qualityCycle?.terminal==='quality_failed'&&hasCurrentCandidate(p))throw Error('当前方案验收未通过，请在修订与补充反馈中确认修改后继续。');
  if(p.automatic?.requestHash===requestHash(p)&&p.automatic.status!=='completed'){
    if(p.automatic.status==='quality_failed')throw Error('验收未通过。请确认具体修订建议，不能通过普通继续按钮重复启动制作。');
    // Migrate unfinished preparation, never retrospectively approve old exports.
    if(['voice','discover','curate','collect','plan','plan_review'].includes(p.automatic.stage)){
      p.automatic.stage=voiceReady(p)?'create':'voice';p.automatic.workflow='continuous-v1';
      p.reviewPolicy='sampled-objective-v1';p.approval=null;if(p.plan)p.plan.stale=true;
      p.automatic.gaps=[];
    }
    p.automatic.status='running';return p.automatic;
  }
  p.reviewPolicy='sampled-objective-v1';
  // A new creative cycle keeps historical media/results, never their approval.
  p.approval=null;if(p.plan)p.plan.stale=true;
  p.automatic={id:randomUUID(),workflow:'continuous-v1',requestHash:requestHash(p),status:'running',stage:voiceReady(p)?'create':'voice',authorization:automaticAuthorization,authorizedAt:new Date().toISOString(),collected:[],collectionFailures:[],repairCount:0};
  return p.automatic;
}
export function nextAutomatic(p){
  const a=p.automatic;if(!a||a.status!=='running')return null;
  const cycle=p.qualityCycle;
  if(cycle?.report?.completed&&hasCurrentCandidate(p))return {action:'delivery'};
  // A saved candidate is the durable handoff; a stale stage must not rerender it.
  if(['create','produce'].includes(a.stage)&&cycle?.report===null&&hasCurrentCandidate(p))a.stage='review';
  if(a.stage==='collect'){
    const id=a.sourceIds.find(id=>!a.collected.includes(id)&&!a.collectionFailures.includes(id));
    if(id)return {action:'collect',sourceId:id};
    if(!p.selected.length)throw Error('自动选材没有取得可用媒体，已保留搜索和失败原因。');
    a.stage='plan';
  }
  return {action:a.stage};
}
export function curateSelection(result,p){
  if(typeof result.title!=='string'||!result.title.trim()||result.title.length>200||!Array.isArray(result.sourceIds)||!result.sourceIds.length||result.sourceIds.length>12)throw Error('自动选题或选材结果无效。');
  const ids=[...new Set(result.sourceIds)];
  if(ids.some(id=>!p.sources.some(s=>s.id===id&&['video','image','audio'].includes(s.kind))))throw Error('自动选材引用未知来源或将事实网页当作媒体。');
  if(!['none','source','instrumental'].includes(result.music)||typeof result.captions!=='boolean')throw Error('自动声音方案无效。');
  return {title:result.title.trim(),sourceIds:ids,music:result.music,captions:result.captions,rationale:String(result.rationale||''),limitations:result.limitations||[]};
}
export function advanceAutomatic(p,job){
  const a=p.automatic;if(!a||job.automaticId!==a.id)return;
  if(job.cancelRequested){a.status='paused';return;}
  if(job.status!=='completed'){
    if(job.action==='collect'&&['failed','blocked'].includes(job.status)){a.collectionFailures.push(job.sourceId);return;}
    const terminal=p.qualityCycle?.terminal==='quality_failed'&&hasCurrentCandidate(p);
    a.status=job.status==='quality_failed'||terminal?'quality_failed':job.status==='needs_input'?'needs_input':'blocked';return;
  }
  if(job.action==='voice')a.stage='create';
  else if(job.action==='create')a.stage='review';
  else if(job.action==='discover')a.stage='curate';
  else if(job.action==='curate')a.stage='collect';
  else if(job.action==='collect')a.collected.push(job.sourceId);
  else if(job.action==='plan'){
    if(p.plan?.gaps?.length){
      a.gaps=p.plan.gaps;a.status='blocked';
      job.error='方案仍有待处理项，继续时在同一制作流程中定位处理：'+p.plan.gaps.join('；');
    }else{a.stage='plan_review';a.gaps=[];}
  }
  else if(job.action==='plan_review')a.stage='produce';
  else if(job.action==='produce')a.stage='review';
  else if(job.action==='review')a.stage='delivery';
  else if(job.action==='delivery'){a.stage='delivery';a.status='completed';}
}
