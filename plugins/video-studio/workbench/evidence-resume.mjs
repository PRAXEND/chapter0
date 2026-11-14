import {inputHash} from './studio-workflow.mjs';

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
    if(candidate.inputHash===hash&&candidate.planHash===approval.planHash&&producer?.inputHash===hash&&producer.planHash===approval.planHash)return job;
  }
  return null;
}
