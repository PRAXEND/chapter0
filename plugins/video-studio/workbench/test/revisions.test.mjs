import test from 'node:test';
import assert from 'node:assert/strict';
import {initialStudio} from '../studio-workflow.mjs';
import {revisionFeedback,confirmRevision,reviewDelta,currentRevision} from '../revisions.mjs';
import {revisionMarkup,provisionalMarkup} from '../public/revision-ui.js';

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
