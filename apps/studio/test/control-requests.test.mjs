import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../src/project.mjs';
import {createQueue} from '../src/jobs.mjs';

test('a retried creation returns the same current project, survives restart, and refuses a different request sharing its token',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-control-intent-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let store=createStore(root);t.after(()=>store.close());
  const input={mode:'script',title:'初版',requestId:'creation-key-0001',settings:{shareFrames:false,shareTranscript:true}};
  const first=store.create(input);store.configure(first.id,first.revision,{title:'已经手改'});
  assert.equal(store.create({...input,settings:{shareTranscript:true,shareFrames:false}}).title,'已经手改');
  store.close();store=createStore(root);
  assert.equal(store.create(input).id,first.id);
  assert.throws(()=>store.create({...input,title:'另一条'}),e=>e.status===409);
  assert.throws(()=>store.create({...input,requestId:'bad'}),/编号/);
  assert.equal(store.list().length,1);
});

test('a lost job response reconciles while queued, after completion, and after reopening the same SQLite project',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-control-job-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let store=createStore(root), q=createQueue({store});const p=store.create({mode:'script'});
  t.after(async()=>{await q.close();store.close();});
  const input={engine:'local',message:'保存一版',requestId:'job-key-0001',baseRevision:p.revision};
  const first=q.enqueue(p.id,'preview',input);assert.equal(q.enqueue(p.id,'preview',input).id,first.id);
  assert.throws(()=>q.enqueue(p.id,'render',input),e=>e.status===409);
  await q.close();store.saveJob({...store.getJob(first.id),status:'done'});store.close();
  store=createStore(root);q=createQueue({store});
  assert.equal(q.enqueue(p.id,'preview',input).id,first.id);assert.equal(store.listJobs(p.id).length,1);
});

test('changing only the registered reference audio never carries the previous recording consent or timing text',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-ref-switch-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createStore(root);t.after(()=>store.close());
  const p=store.create({mode:'script',settings:{voiceMode:'clone',voiceConsent:true,voiceReferenceText:'甲录音',voiceReferenceAssetId:'old'}});
  const now=store.configure(p.id,p.revision,{settings:{voiceReferenceAssetId:'new'}});
  assert.equal(now.settings.voiceConsent,false);assert.equal(now.settings.voiceReferenceText,'');
  const approved=store.configure(p.id,now.revision,{settings:{voiceReferenceAssetId:'third',voiceReferenceText:'丙录音',voiceConsent:true}});
  assert.equal(approved.settings.voiceConsent,true);assert.equal(approved.settings.voiceReferenceText,'丙录音');
});
