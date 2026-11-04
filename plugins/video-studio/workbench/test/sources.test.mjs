import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {materialPlan,normalizeReview,materialSelection,verifySourceIdentity} from '../sources.mjs';

test('material needs must match the exact current topic and style before search results are accepted',async()=>{
  const run=await mkdtemp(path.join(os.tmpdir(),'source-needs-test-'));
  try{
    const needs={topic:'机器人进展',style:'real@2',needs:[{id:'action',purpose:'动作证据',query:'实际机器人演示',acceptance:'可溯源'}]};
    await writeFile(path.join(run,'run.json'),JSON.stringify({material_plan:needs}));
    assert.deepEqual(await materialPlan(run,{topic:needs.topic,style:needs.style}),needs);
    await assert.rejects(()=>materialPlan(run,{topic:'咖啡',style:needs.style}));
    await assert.rejects(()=>materialPlan(run,{topic:needs.topic,style:'real@1'}));
  }finally{await rm(run,{recursive:true,force:true});}
});
test('event grouping preserves original-to-web source identity and rejects duplicate rankings or hidden candidates',()=>{
  const sources=[{id:'repo-item'},{id:'official-item'},{id:'reserve'}],normalized=[{id:'web-1'},{id:'web-2'},{id:'web-3'}];
  const review={scope:'实际窗口',methods:['GitHub 只读 API'],gaps:[],events:[
    {event_id:'same-event',title:'同一事件',source_ids:['repo-item','official-item'],decision:'top5',rank:1,reason:'交叉核对',caveats:[]},
    {event_id:'other-event',title:'待核实',source_ids:['reserve'],decision:'hold',rank:0,reason:'缺少日期',caveats:['未核实']}
  ]};
  const context={jobId:'job',query:'需求',topic:'题材',style:'real@2'};
  const result=normalizeReview(review,sources,normalized,context);
  assert.deepEqual(result.events[0].source_ids,['web-1','web-2']);
  assert.deepEqual(result.top_event_ids,['same-event']);
  assert.throws(()=>normalizeReview({...review,events:[review.events[0]]},sources,normalized,context));
  assert.throws(()=>normalizeReview({...review,events:[review.events[0],{...review.events[1],decision:'top5',rank:1}]},sources,normalized,context));
  assert.throws(()=>normalizeReview({...review,events:[review.events[0],{...review.events[1],source_ids:['missing']}]},sources,normalized,context));
});
test('recommendations do not become user selections; only checked actual media are recorded',()=>{
  const p={topic:'题材',styleSelector:null,selected:[],sourceReview:{events:[{event_id:'recommended',source_ids:['a','b']}]}};
  assert.deepEqual(materialSelection(p).selected_event_ids,[]);
  p.selected=['b'];assert.deepEqual(materialSelection(p).selected_source_ids,['b']);assert.deepEqual(materialSelection(p).selected_event_ids,['recommended']);
});
test('repository media requires its pinned identity and matching actual bytes/hash before it can be ready',()=>{
  const actual={sha256:'a'.repeat(64),bytes:4017};
  const expected={sourceType:'x_repository',repositoryCommit:'b'.repeat(40),repositoryPath:'2026/day/007/videos/01.mp4',expectedSha256:actual.sha256,expectedBytes:actual.bytes};
  assert.doesNotThrow(()=>verifySourceIdentity(actual,expected));
  assert.throws(()=>verifySourceIdentity(actual,{...expected,expectedSha256:'c'.repeat(64)}));
  assert.throws(()=>verifySourceIdentity(actual,{...expected,expectedBytes:4016}));
  assert.throws(()=>verifySourceIdentity(actual,{...expected,repositoryCommit:''}));
  assert.doesNotThrow(()=>verifySourceIdentity(actual,{sourceType:'official'}));
});
