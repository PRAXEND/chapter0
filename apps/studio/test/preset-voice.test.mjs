import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { audioCapabilities, synthesize } from '../src/audio.mjs';
import { presetFiles, presetModelReady } from '../src/qwen-preset.mjs';

test('a system voice or an installed clone does not masquerade as the publisher preset', async t => {
  const cache = await mkdtemp(path.join(os.tmpdir(), 'studio-preset-missing-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const previous = Object.fromEntries(['VIDEO_STUDIO_MEDIA_HOME','VIDEO_STUDIO_QWEN_MODEL','VIDEO_STUDIO_QWEN_PRESET_MODEL','VIDEO_STUDIO_MLX_PYTHON'].map(k => [k,process.env[k]]));
  t.after(() => { for (const [key,value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const base = path.join(cache, 'base'), preset = path.join(cache, 'empty-preset');
  const python = path.join(cache, 'fake-runtime');
  await mkdir(path.join(base, 'speech_tokenizer'), { recursive:true });
  await writeFile(path.join(base,'model.safetensors'), 'base');
  await writeFile(path.join(base,'speech_tokenizer/model.safetensors'), 'codec');
  await writeFile(python, '#!/bin/sh\nexit 0\n', { mode:0o700 });
  Object.assign(process.env, {VIDEO_STUDIO_MEDIA_HOME:cache, VIDEO_STUDIO_QWEN_MODEL:base,
    VIDEO_STUDIO_QWEN_PRESET_MODEL:preset, VIDEO_STUDIO_MLX_PYTHON:python});
  const caps = await audioCapabilities();
  assert.equal(caps.clone, true);
  assert.equal(caps.preset, false);
  const output = path.join(cache, 'candidate.wav');
  await assert.rejects(synthesize('这是预置试听。', {mode:'preset', output}), /准备本地 Qwen 预置音色/);
  await assert.rejects(synthesize('这是预置试听。', {mode:'preset', voice:'unknown', output}), /未识别/);
  assert.ok(!(await readdir(cache)).includes('candidate.wav'));
});

test('a truncated or same-size unverified preset installation cannot report ready', async t => {
  const cache = await mkdtemp(path.join(os.tmpdir(), 'studio-preset-identity-'));
  t.after(() => rm(cache, { recursive: true, force:true }));
  assert.equal(await presetModelReady(cache), false);
  // Sparse fake files match every size but contain no model or source data.
  for (const [name, [size]] of Object.entries(presetFiles)) {
    const target = path.join(cache,name);
    await mkdir(path.dirname(target), {recursive:true});
    await writeFile(target,'');
    await truncate(target,size);
  }
  assert.equal(await presetModelReady(cache), false);
});
