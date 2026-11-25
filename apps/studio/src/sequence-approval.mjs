import {createHash} from 'node:crypto';
import {sceneIdentity} from './storyboard.mjs';

const hash=o=>createHash('sha256').update(JSON.stringify(o)).digest('hex');
function proposalHash(p,proposal){
  return hash([p.id,p.revision,sceneIdentity(p),p.assets.map(a=>[a.id,a.sha256]),p.factSources||[],proposal]);
}
export function holdSequence(p,jobId,{beats,operation,fromFrame,toFrame,motionGap},frames,observed,observedText){
  const plan={jobId,revision:p.revision,operation,beats,...(operation==='replace-range'?{fromFrame,toFrame}:{}),
    ...(motionGap?.trim()?{motionGap}:{}),style:p.style};
  const evidence={frames:frames.filter(f=>f.source==='asset'),observed:[...observed],observedText:[...observedText]};
  return {plan,evidence,hash:proposalHash(p,[plan,evidence])};
}
export function checkProposal(p,jobId,approvedHash){
  const pending=p.pendingSequence;
  if(!pending||!jobId||jobId!==pending.plan.jobId||p.revision!==pending.plan.revision||
    proposalHash(p,[pending.plan,pending.evidence])!==pending.hash)
    throw Error('待确认分镜所属的工程版本、素材或事实已变化。请保留当前工程并重新发起审稿。');
  if(approvedHash!==undefined&&approvedHash!==pending.hash)throw Error('确认指纹与当前展示的整份分镜不一致。');
  return pending;
}
export function waitingForSequence(p,pending){
  return {project:p,engine:'codex',changed:false,needsReview:false,
    awaitingSequenceApproval:{...pending.plan,hash:pending.hash},
    message:'请查看这版的旁白、镜头和原片区间。确认后工作台按这份分镜制作。'};
}
