import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSrt, createAss } from '../src/text-tracks.mjs';
import { renderProject, mediaCapabilities, probeMedia, frameAt, fileHash } from '../src/media.mjs';
import { ffBase, mediaSlot, run } from '../src/media-runtime.mjs';
import { createMusicBed } from '../src/audio.mjs';

const exec = promisify(execFile);
const profile = { width: 160, height: 96, fps: 30 };

test('visible SRT and composed graphics use the same half-open frame clock', () => {
  const clips = [
    { track: 'caption', start: 2, duration: 3, text: '灯芯{点亮}' },
    { track: 'caption', start: 5, duration: 2, hidden: true, text: '隐藏' },
    { track: 'graphic', start: 0, duration: 8, text: '观察', keyframes: [{ frame: 0, opacity: 0, x: 0.2 }, { frame: 4, opacity: 1, x: 0.5 }] }
  ];
  assert.equal(createSrt(clips, 30), '1\n00:00:00,067 --> 00:00:00,167\n灯芯{点亮}\n');
  const ass = createAss(clips, profile);
  assert.match(ass, /0:00:00\.06,0:00:00\.16/);
  assert.match(ass, /灯芯\\\{点亮\\\}/);
  assert.match(ass, /\\move\(/);
  assert.doesNotMatch(ass, /隐藏/);
});

test('queued inference and renders can be cancelled before acquiring the shared GPU budget', async () => {
  let release;
  const first = mediaSlot(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const second = mediaSlot(() => assert.fail('cancelled job started'), controller.signal);
  controller.abort();
  await assert.rejects(second);
  release(); await first;
  assert.equal(await mediaSlot(() => 3), 3);
});

test('render two cuts and a dissolve, measure pixels, mix audio, read subtitles and reopen', { timeout: 90000 }, async t => {
  const caps = await mediaCapabilities();
  if (!caps.ready) { t.skip('FFmpeg/ffprobe with libass required'); return; }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-media-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const color of ['blue', 'red']) {
    await run(caps.ffmpeg, [...ffBase, '-f', 'lavfi', '-i', `color=c=${color}:s=160x96:r=30:d=3`, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, color + '.mp4')]);
  }
  const bed = await createMusicBed(path.join(dir, 'bed.wav'), { duration: 3, style: 'pulse' });
  const assets = [{ id: 'blue', path: 'blue.mp4' }, { id: 'red', path: 'red.mp4' }, { id: 'audio', path: 'bed.wav' }];
  const clips = [
    { id: 'a', track: 'video', assetId: 'blue', start: 0, duration: 60, sourceIn: 10, speed: 0.7 },
    { id: 'b', track: 'video', assetId: 'red', start: 45, duration: 45, sourceIn: 5, speed: 1.3, transition: { type: 'crossfade', duration: 15 } },
    { id: 'n', track: 'narration', assetId: 'audio', start: 30, duration: 40, sourceIn: 5, gain: 1 },
    { id: 'm', track: 'music', assetId: 'audio', start: 0, duration: 90, gain: 0.3 },
    { id: 't', track: 'caption', text: '进入下一幕', start: 62, duration: 15, style: { fontSize: 12 } }
  ];
  const project = { revision: 2, profile, assets, timeline: { clips } };
  const output = path.join(dir, '样片.mp4');
  const result = await renderProject(project, { output, directory: dir });
  assert.equal(result.frames, 90);
  assert.equal(result.engine, caps.engine);
  assert.equal(result.sha256, await fileHash(output));
  assert.equal(bed.sha256, await fileHash(path.join(dir, 'bed.wav')));
  const info = await probeMedia(output);
  assert.equal(info.duration, 3); assert.equal(info.audioCodec, 'aac');
  assert.match(await readFile(result.srtPath, 'utf8'), /00:00:02,067 --> 00:00:02,567/);
  async function sample(seconds) {
    const { stdout } = await exec(caps.ffmpeg, [...ffBase, '-ss', String(seconds), '-i', output, '-an', '-frames:v', '1', '-vf', 'crop=2:2:0:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
    return Array.from(stdout.subarray(0, 3));
  }
  const [before, mid, after] = await Promise.all([sample(0.5), sample(1.7), sample(2.7)]);
  assert.ok(before[2] > 220 && before[0] < 25, 'outgoing shot is blue');
  assert.ok(mid[0] > 30 && mid[2] > 30, 'both shots visible during dissolve');
  assert.ok(after[0] > 220 && after[2] < 25, 'incoming shot is red');
  const { stdout } = await exec(caps.ffmpeg, [...ffBase, '-i', output, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer' });
  assert.ok([...new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2))].some(n => Math.abs(n) > 600), 'mixed track carries an audible signal');
  const jpg = path.join(dir, 'frame.jpg');
  await frameAt(output, 2.5, jpg, { maxWidth: 80 });
  assert.equal((await probeMedia(jpg)).width, 80);
  const bad = structuredClone(project); bad.timeline.clips[0].sourceIn = 99999;
  await assert.rejects(renderProject(bad, { output, directory: dir }), /超出原素材时长/);
  assert.equal(await fileHash(output), result.sha256, 'invalid edit never replaces previous delivery');
  const ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(async () => renderProject(project, { output: path.join(dir, 'cancel.mp4'), directory: dir, signal: ctrl.signal }));
  assert.equal(await stat(path.join(dir, 'cancel.mp4')).catch(() => null), null);
});
