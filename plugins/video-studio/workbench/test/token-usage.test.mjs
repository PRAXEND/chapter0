import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {tokenUsage, summarizeUsage, usageJobs, rememberUsage} from '../public/token-usage.js';
import {initialStudio} from '../studio-workflow.mjs';
import {ProjectStore} from '../projects.mjs';
import {renderTokenUsage} from '../public/token-usage-view.js';

test('cache and reasoning stay inside input/output totals; missing counts are never zero', () => {
  assert.deepEqual(tokenUsage({input_tokens:1000, cached_input_tokens:800, output_tokens:100, reasoning_output_tokens:40}),
    {input:1000, cached:800, output:100, reasoning:40, total:1100});
  assert.deepEqual(tokenUsage({input_tokens:1000, input_tokens_details:{cached_tokens:800}, output_tokens:100, output_tokens_details:{reasoning_tokens:40}}),
    {input:1000, cached:800, output:100, reasoning:40, total:1100});
  assert.equal(tokenUsage(null).total, null);
  assert.equal(tokenUsage({input_tokens:0, output_tokens:0}).total, 0);
  assert.equal(tokenUsage({input_tokens:100, output_tokens:-1}).total, null);
  assert.equal(tokenUsage({input_tokens:'100', output_tokens:20}).input, null);
  assert.equal(tokenUsage({input_tokens:100, cached_input_tokens:101}).cached, null);
});

test('project usage includes failed attempts and retries without duplicating ledger entries', () => {
  const p = initialStudio();
  p.tokenUsageJobs = [{id:'old', action:'produce', status:'failed', usage:{input_tokens:1000, output_tokens:100}}];
  p.jobs = [
    {id:'old', action:'produce', status:'failed', usage:{input_tokens:1000, output_tokens:100}},
    {id:'retry', action:'produce', status:'needs_input', usage:{input_tokens:2000, cached_input_tokens:1800, output_tokens:200}},
    {id:'cancelled', status:'cancelled'}, {id:'active', status:'running'}
  ];
  assert.equal(usageJobs(p).length, 4);
  assert.deepEqual(summarizeUsage(usageJobs(p)), {input:3000, output:300, cached:1800, total:3300, reported:2, pending:1, missing:1});
  assert.equal(summarizeUsage([{status:'failed'}]).total, null);
});

test('usage ledger survives event-log pruning, project switching and a store restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-usage-'));
  try {
    const p = initialStudio(), other = initialStudio();
    p.jobs = Array.from({length:52}, (_, i) => ({id:'job-'+i, action:'produce', status:'completed', usage:{input_tokens:10, output_tokens:2}}));
    rememberUsage(p); p.jobs = p.jobs.slice(0, 50);
    const store = new ProjectStore(directory); await store.init(p); await store.save(other);
    const restarted = new ProjectStore(directory); await restarted.init(other);
    const loaded = restarted.load(p.id);
    assert.equal(loaded.jobs.length, 50); assert.equal(usageJobs(loaded).length, 52);
    assert.equal(summarizeUsage(usageJobs(loaded)).total, 624);
    assert.equal(summarizeUsage(usageJobs(restarted.load(other.id))).total, null);
  } finally { await rm(directory, {recursive:true, force:true}); }
});

test('usage display distinguishes unknown from genuine zero and escapes saved labels', () => {
  const job={id:'real-zero',label:'<img src=x>',status:'completed',usage:{input_tokens:0,output_tokens:0,cached_input_tokens:0}};
  const html=renderTokenUsage({jobs:[job]},job,true);
  assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img src=x>/);
  assert.match(html,/本项目累计/);assert.match(html,/1 \/ 1 次任务已返回完整用量/);
  const missing={id:'missing',status:'interrupted'};
  assert.match(renderTokenUsage({jobs:[missing]},missing),/未完整上报/);
  assert.match(renderTokenUsage({jobs:[{...missing,status:'running'}]},{...missing,status:'running'}),/结束后显示/);
});
