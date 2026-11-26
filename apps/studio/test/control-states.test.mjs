import test from 'node:test';
import assert from 'node:assert/strict';
import {actionGate,dependencies,durationProblem,jobReason} from '../www/control-state.js';

test('mutually exclusive requests share a project gate and unrelated work stays available',()=>{
  const gate=actionGate();
  const finish=gate.begin('new','create');assert.ok(finish);
  assert.equal(gate.begin('new','create-run'),null);finish();assert.ok(gate.begin('new','create-run'));
  const done=gate.begin('A','direct');assert.ok(done);
  for(const op of ['local','render','preview','resume','pause','approve-plan','replan'])assert.ok(gate.has('A',op));
  assert.ok(!gate.has('B','direct'));assert.ok(!gate.has('A','search-assets'));done();
  const voice=gate.begin('A','audition');assert.equal(gate.begin('A','settings-save'),null);voice();
  const music=gate.begin('A','charged','one');assert.equal(gate.begin('A','not-charged','one'),null);music();
});
test('privacy, external sources, voice choice and local or cloud music remain independent',()=>{
  const alone=dependencies({frames:false,review:true,scope:'project',voice:'original',music:'none',cloud:false});
  for(const k of ['autoReview','finalReview','sourceUrls','narration','bgm','budget'])assert.ok(alone[k],k);
  const combined=dependencies({frames:true,review:false,scope:'search',voice:'import',music:'asset',cloud:true});
  assert.ok(combined.finalReview);
  for(const k of ['autoReview','sourceUrls','narration','bgm','budget'])assert.equal(combined[k],'',k);
  assert.equal(dependencies({frames:true,review:true}).finalReview,'');
});
test('timeline, render, steering, stopped progress and a stale manual plan expose their actual conditions',()=>{
  assert.ok(jobReason('render',{hasClips:false}));
  assert.equal(jobReason('direct',{hasClips:false}),'');
  const running={jobs:[{kind:'render',phase:'render',status:'running'}],hasClips:true};
  for(const act of ['render','preview','local','direct','resume'])assert.ok(jobReason(act,running),act);
  assert.equal(jobReason('direct',{...running,message:'change the opening'}),'');
  assert.ok(jobReason('direct',{jobs:[{status:'pausing'}],message:'later'}));
  assert.equal(jobReason('draft',running),'');
  assert.ok(jobReason('approve-plan',{approvalRevision:2,revision:3}));
  assert.equal(jobReason('approve-plan',{approvalRevision:3,revision:3}),'');
});
test('valid time bounds and scripts with attachments remain usable without unnecessary required values',()=>{
  for(const values of [[0,8,2],['',-1,''],[12,6,''],[2,6,8],[2,6,1],[2,86501,4]])assert.ok(durationProblem(...values));
  for(const values of [['','',''],[2,'',5],['',5,3],[2,5,''],[2,5,2]])assert.equal(durationProblem(...values),'');
});
