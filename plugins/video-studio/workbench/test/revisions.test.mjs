import test from 'node:test';
import assert from 'node:assert/strict';
import {initialStudio} from '../studio-workflow.mjs';
import {revisionFeedback,confirmRevision,reviewDelta,currentRevision} from '../revisions.mjs';
import {revisionMarkup,provisionalMarkup} from '../public/revision-ui.js';
import {pendingEvidence} from '../evidence-resume.mjs';
import {inputHash} from '../studio-workflow.mjs';
import {beginAutomatic,requestHash} from '../automatic.mjs';

const fixture=()=>({...initialStudio(),topic:'本期事实',styleSelector:'sample@1',plan:{stale:false},approval:{planHash:'plan',inputHash:'inputs'},
  jobs:[{id:'new',action:'produce',status:'completed'},{id:'question',action:'produce',status:'needs_input',questions:['采用备用源 0.8–7.4 秒替换开头，改首句？']}],
  automatic:{id:'creative',status:'quality_failed'},qualityCycle:{terminal:'quality_failed',report:{completed:false,checks:{visuals:{status:'fail',issues:[{suggested_fix:'保留完整落点'}]}}}},deliveries:[{id:'past'}]});
test('unanswered replacement remains visible after a subsequent job; confirmation binds a single scoped revision',()=>{
  const p=fixture(),before=revisionFeedback(p);assert.equal(before.requestJobId,'question');assert.match(before.suggested,/备用源/);
  const payload={projectId:p.id,token:before.token,feedback:before.suggested};
  const r=confirmRevision(p,payload);assert.equal(r.creativeId,'creative');assert.equal(p.approval,null);assert.equal(p.plan.stale,true);
  assert.equal(p.qualityCycle,null);assert.equal(p.revisionHistory[0].qualityCycle.report.completed,false);assert.equal(p.deliveries[0].id,'past');
  assert.equal(revisionFeedback(p).questions.length,0);assert.equal(reviewDelta(p).previousReport.completed,false);
  assert.throws(()=>confirmRevision(p,payload),/已变化/);
});
test('another project, a changed suggestion, and a running job cannot be approved',()=>{
  const p=fixture(),token=revisionFeedback(p).token;
  assert.throws(()=>confirmRevision(p,{projectId:'other',token,feedback:'同意'}),/已变化/);
  p.jobs[1].questions=['另一片段'];assert.throws(()=>confirmRevision(p,{projectId:p.id,token,feedback:'同意'}),/已变化/);
  p.jobs[0].status='running';assert.throws(()=>confirmRevision(p,{projectId:p.id,token:revisionFeedback(p).token,feedback:'同意'}),/尚未结束/);
  assert.equal(p.qualityCycle.terminal,'quality_failed');
});
test('feedback remains editable while running and preview is unmistakably provisional',()=>{
  const p=fixture(),escape=s=>String(s??'').replaceAll('<','&lt;');
  const ui=revisionMarkup(p,revisionFeedback(p),'<user text>',true,escape);
  assert.match(ui,/&lt;user text>/);assert.match(ui,/data-revision-confirm disabled/);assert.doesNotMatch(ui,/<textarea[^>]*disabled/);
  assert.match(ui,/备用源/);assert.match(ui,/保存反馈不启动 AI/);
  const preview=provisionalMarkup({complete:true,files:[{id:'zip',role:'archive',name:'bundle.zip'}],directory:'/tmp/test'},escape);
  assert.match(preview,/尚未通过验收/);assert.match(preview,/完整临时交付 ZIP/);assert.doesNotMatch(preview,/独立验收通过/);
});

test('confirmed feedback cannot leak into a different topic or style',()=>{
  const p=fixture();confirmRevision(p,{projectId:p.id,token:revisionFeedback(p).token,feedback:'局部修改'});
  assert.equal(currentRevision(p).request,'局部修改');p.topic='另一主题';assert.equal(currentRevision(p),null);assert.equal(reviewDelta(p).requestedRevision,null);
});

test('AI prefill never turns rejected reviewer claims into user-approved quality exceptions',()=>{
  const p=fixture();p.qualityCycle.report.checks={caption_sync:{status:'fail',observations:'328ms 属于 intended；客观验收拒绝：Sampled review evidence invalid: caption_alignment_failed'},flicker:{status:'fail',observations:'已全部查看；客观验收拒绝：Sampled review evidence invalid: sampled_sheets_not_fully_reviewed'}};
  const text=revisionFeedback(p).suggested;assert.doesNotMatch(text,/328ms 属于 intended|已全部查看/);assert.match(text,/不能用/);assert.match(text,/实际查看/);
});

test('technical review preparation errors explain empty suggestions without requesting a creative revision',()=>{
  const p=fixture();p.jobs=[{id:'producer',action:'create',status:'completed',error:'待验收文件已变化（material-selection.json）'}];
  p.qualityCycle={candidate:{producerJobId:'producer',inputHash:inputHash(p),planHash:'plan',files:[]},report:null};
  p.automatic={id:'current-cycle',status:'blocked',stage:'review',requestHash:requestHash(p)};
  const view=revisionFeedback(p);
  assert.match(view.technicalBlocker.message,/material-selection/);assert.equal(view.suggested,'');assert.deepEqual(view.issues,[]);
  const ui=revisionMarkup(p,view,'',false,s=>String(s??''));
  assert.match(ui,/验收准备受阻/);assert.match(ui,/没有新增质量修改建议/);assert.match(ui,/data-feedback-suggestion disabled/);
  p.automatic.status='running';assert.equal(revisionFeedback(p).technicalBlocker,null);
  p.automatic.status='blocked';p.topic='another topic';assert.equal(revisionFeedback(p).technicalBlocker,null);p.topic='本期事实';
  p.automatic.stage='voice';assert.equal(revisionFeedback(p).technicalBlocker,null);p.automatic.stage='review';
  const oldReview={id:'old-review',action:'review',error:'old candidate error',inputHash:inputHash(p),planHash:'plan',automaticId:'old-cycle'};
  p.jobs.unshift(oldReview,{id:'new-producer',action:'create',status:'completed'});
  p.qualityCycle.candidate.producerJobId='new-producer';assert.equal(revisionFeedback(p).technicalBlocker,null);
  // Even the same cycle cannot borrow a review from before this producer.
  oldReview.automaticId='current-cycle';p.jobs.splice(0,1);p.jobs.splice(1,0,oldReview);assert.equal(revisionFeedback(p).technicalBlocker,null);
  p.qualityCycle.report={completed:true,checks:{}};assert.equal(revisionFeedback(p).technicalBlocker,null);
});

test('evidence-only continuation keeps approval and candidate; actual revisions still invalidate them',()=>{
  const p={...initialStudio(),topic:'原候选补证',styleSelector:'sample@1',plan:{stale:false}};
  const hash=inputHash(p);p.approval={planHash:'approved',inputHash:hash};
  p.automatic={id:'creative',stage:'create',status:'needs_input',requestHash:requestHash(p)};
  p.jobs=[{id:'producer',action:'create',status:'needs_input',inputHash:hash,planHash:'approved',requestHash:requestHash(p),questions:['请补齐音乐原件'],pendingExport:{producerJobId:'producer',planHash:'approved',inputHash:hash,files:[{role:'video',sha256:'unchanged'}]}}];
  const approval=structuredClone(p.approval),candidate=structuredClone(p.jobs[0].pendingExport);
  assert.equal(revisionFeedback(p).questions.length,0);assert.equal(revisionFeedback(p).evidencePending.jobId,'producer');
  beginAutomatic(p);assert.equal(p.automatic.stage,'create');assert.equal(p.automatic.id,'creative');
  assert.deepEqual(p.approval,approval);assert.deepEqual(p.jobs[0].pendingExport,candidate);
  assert.equal(pendingEvidence(p).id,'producer');
  p.jobs[0].revisionProposal={summary:'修改开头',changes:['换新素材']};
  assert.equal(pendingEvidence(p),null);assert.ok(revisionFeedback(p).proposal);
  confirmRevision(p,{projectId:p.id,token:revisionFeedback(p).token,feedback:'确认换开头'});assert.equal(p.approval,null);
});

test('a new input or already-reviewed candidate cannot borrow evidence-only recovery',()=>{
  const p={...initialStudio(),topic:'试片',styleSelector:'sample@1',plan:{stale:false}};
  const hash=inputHash(p);p.approval={planHash:'approved',inputHash:hash};
  p.jobs=[{id:'old',action:'produce',status:'needs_input',inputHash:hash,planHash:'approved',pendingExport:{producerJobId:'old',inputHash:hash,planHash:'approved'}}];
  assert.ok(pendingEvidence(p));p.topic='另一个视频';assert.equal(pendingEvidence(p),null);
  p.topic='试片';p.qualityCycle={candidate:p.jobs[0].pendingExport,terminal:'quality_failed'};assert.equal(pendingEvidence(p),null);
});

test('a newer creative decision overrides old pending evidence, technical retries do not',()=>{
 const p={...initialStudio(),topic:'试片',styleSelector:'sample@1',plan:{stale:false}};
 const hash=inputHash(p);p.approval={planHash:'approved',inputHash:hash};
 const old={id:'old',action:'produce',status:'needs_input',inputHash:hash,planHash:'approved',pendingExport:{producerJobId:'old',inputHash:hash,planHash:'approved'}};
 p.jobs=[{id:'new',action:'produce',status:'failed',inputHash:hash,planHash:'approved'},old];assert.equal(pendingEvidence(p).id,'old');
 p.jobs[0].status='needs_input';p.jobs[0].revisionProposal={summary:'原件不可恢复，需要替换声音',changes:['更换旁白']};
 assert.equal(pendingEvidence(p),null);assert.equal(revisionFeedback(p).proposal.summary,p.jobs[0].revisionProposal.summary);
});
