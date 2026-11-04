import {createHash,randomUUID} from 'node:crypto';
import {inputHash} from './studio-workflow.mjs';
import {requestHash} from './automatic.mjs';

function checkSuggestion(check,c){
  const detail=String(c.observations||'');
  if(/caption_alignment_failed/.test(detail))return '按真实词时间修正字幕文字及超出现有容差的字幕卡，核实 ASR 纠错来源；不能用“有意停留”免除同步失败。';
  if(/sampled_sheets_not_fully_reviewed/.test(detail))return '复验实际查看当前成片的全部联系表，并按统一格式登记覆盖；不得只用文字声明已看完。';
  if(check==='style_match')return '按本轮风格对照报告修复主体比例、文字层级、动作连续性和动效表达中的未通过项，保留原风格要求。';
  if(check==='visuals')return '修复本轮画面报告中未解决的裁切、遮挡或动作不完整问题，并查看修订后的合成帧。';
  return '处理 '+check+' 的未通过项，按本轮验收报告定位与复查，保持现有标准。';
}

export function revisionFeedback(p){
  const current=currentRevision(p),consumed=new Set(p.userRevision?.consumedJobs||[]);
  const scope=requestHash(p);
  const pending=p.jobs.find(j=>['create','produce'].includes(j.action)&&!consumed.has(j.id)&&(j.requestHash?j.requestHash===scope:!j.inputHash||j.inputHash===inputHash(p))&&(j.questions?.length||j.revisionProposal));
  const report=(!p.qualityCycle?.candidate||p.qualityCycle.candidate.inputHash===inputHash(p))?p.qualityCycle?.report:null;
  const issues=Object.entries(report?.checks||{}).filter(([,c])=>!['pass','not_applicable'].includes(c.status)).flatMap(([check,c])=>c.issues?.length?c.issues.map(i=>({check,text:typeof i==='string'?i:i.suggested_fix||i.symptom||JSON.stringify(i)})):[{check,text:checkSuggestion(check,c)}]);
  const proposal=pending?.revisionProposal||null;
  const suggestions=[...(proposal?[proposal.summary,...(proposal.changes||[])]:[]),...(pending?.questions||[]),...issues.map(i=>i.text)];
  const suggested=[...new Set(suggestions.filter(Boolean))].join('\n').slice(0,12000);
  const token=createHash('sha256').update(JSON.stringify({project:p.id,plan:p.approval?.planHash,input:p.approval?.inputHash,candidate:p.qualityCycle?.candidate?.files,report,request:pending?.id,proposal,suggested,revision:p.userRevision?.id})).digest('hex');
  return {token,proposal,questions:pending?.questions||[],issues,suggested,requestJobId:pending?.id||null,submitted:current?.request||'',hasCandidate:!!p.qualityCycle?.candidate};
}

// A click authorizes a bounded new revision, never converts a failed review to pass.
export function confirmRevision(p,{projectId,token,feedback}){
  if(projectId!==p.id||token!==revisionFeedback(p).token)throw Error('修订建议或项目已变化，请刷新后重新确认。');
  const request=String(feedback||'').trim();if(!request||request.length>12000)throw Error('请填写本轮修订要求（最多 12000 字）。');
  if(p.jobs.some(j=>['running','cancelling'].includes(j.status)))throw Error('当前任务尚未结束，请先停止或等待完成。');
  const old=p.userRevision,view=revisionFeedback(p);
  const history={id:randomUUID(),at:new Date().toISOString(),plan:p.plan,approval:p.approval,qualityCycle:p.qualityCycle,automatic:p.automatic,request};
  p.revisionHistory=[history,...(p.revisionHistory||[])];
  p.userRevision={id:history.id,request,proposal:view.proposal,status:'confirmed',confirmedAt:history.at,basePlanHash:p.approval?.planHash||null,
    requestHash:requestHash(p),creativeId:p.automatic?.id||old?.creativeId||null,consumedJobs:[...new Set([...(old?.consumedJobs||[]),...p.jobs.map(j=>j.id)])]};
  p.feedbackDraft='';p.approval=null;if(p.plan)p.plan.stale=true;p.qualityCycle=null;p.automatic=null;
  return p.userRevision;
}

export function reviewDelta(p){
  const previous=p.qualityCycle?.previous||(currentRevision(p)?p.revisionHistory?.[0]?.qualityCycle:null);
  const report=previous?.report;
  const previousReport=report?{completed:report.completed,failures:report.failures,checks:Object.fromEntries(Object.entries(report.checks||{}).filter(([,c])=>!['pass','not_applicable'].includes(c.status)).map(([key,c])=>[key,{status:c.status,observations:c.observations,issues:c.issues}]))}:null;
  return {previousReport,previousArtifact:previous?.candidate?.files?.find(f=>f.role==='video')?.sha256||null,
    requestedRevision:currentRevision(p)?.request||null,repair:previous?.repair||p.qualityCycle?.repair||null,
    instruction:'Use the previous issues to prioritize regression checks. All current-export objective checks and full visual coverage remain required; previous pass results are never current evidence.'};
}

export function currentRevision(p){return p.userRevision?.requestHash===requestHash(p)?p.userRevision:null;}
