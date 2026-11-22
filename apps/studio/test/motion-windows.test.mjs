import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mediaTool } from '../src/media-runtime.mjs';
import { motionSamplingPlan, scanMotionWindows, sceneChange } from '../src/motion-windows.mjs';

test('binary and RGB QA use the same luminance grid, motion compensation and thresholds', () => {
  const w = 96, h = 60;
  const a = Buffer.alloc(w * h), shifted = Buffer.alloc(w * h), raised = Buffer.alloc(w * h);
  const shade = (x, y) => 30 + ((x * 23 ^ y * 15) % 170);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    a[k] = shade(x, y); shifted[k] = shade(x + 3, y + 2); raised[k] = a[k] + 8;
  }
  assert.deepEqual(sceneChange(a, a, w, h), { change: 0, afterGlobalMotion: 0 });
  assert.deepEqual(sceneChange(a, raised, w, h), { change: 8, afterGlobalMotion: 8 });
  assert.equal(sceneChange(a, shifted, w, h).afterGlobalMotion, 0);
  const rgb = b => Buffer.from([...b].flatMap(v => [v, v, v]));
  assert.deepEqual(sceneChange(rgb(a), rgb(shifted), w, h), sceneChange(a, shifted, w, h));
});

test('short and multi-hour sources have a hard sample budget and cancellable scans', async () => {
  const sections = motionSamplingPlan(6 * 3600);
  assert.equal(sections.length, 10);
  assert.equal(sections[0].start, 0);
  assert.equal(sections.at(-1).start + sections.at(-1).duration, 21600);
  assert.equal(sections.reduce((n, s) => n + s.duration, 0), 160);
  assert.deepEqual(motionSamplingPlan(9.1), [{ start: 0, duration: 9.1 }]);
  assert.deepEqual(motionSamplingPlan(Infinity), []);
  await assert.rejects(scanMotionWindows({ path: 'unused', duration: 150 },
    { signal: AbortSignal.abort(Object.assign(Error('test cancelled'), { name: 'AbortError' })) }), /test cancelled/);
});

function syntheticFrame(time, includeAction) {
  const w = 96, h = 60, out = Buffer.alloc(w * h);
  const pan = time >= 7 && time < 15 ? Math.floor((time - 7) * 3) : 0;
  const cuts = time >= 15 && time < 20 ? Math.floor(time - 15) % 2 : 0;
  const zoom = time >= 28 && time < 35 ? 1 + (time - 28) * .023 : 1;
  const on = includeAction && ((time >= 20 && time < 28) || (time >= 36 && time < 44));
  const cx = Math.round(44 + Math.sin(time * 1.1) * 28), cy = Math.round(30 + Math.sin(time * .8) * 8);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const srcX = Math.round((x - 48) / zoom + 48 + pan), srcY = Math.round((y - 30) / zoom + 30);
    const tile = (Math.floor(srcX / 6) + Math.floor(srcY / 7) + cuts) % 2;
    const base = cuts ? (srcX * 31 + srcY * 47) % 240 : (tile ? 98 : 38);
    out[y * w + x] = on && Math.abs(x - cx) < 11 && Math.abs(y - cy) < 12 ? 227 : base;
  }
  return out;
}

test('decoded footage proposes separated object motion and rejects stills, camera pan, zoom and isolated cuts', async t => {
  const ffmpeg = await mediaTool('ffmpeg');
  if (!ffmpeg) return t.skip('FFmpeg unavailable');
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-motion-windows-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const action of [true, false]) {
    const input = Buffer.concat(Array.from({ length: 48 * 2 }, (_, i) => syntheticFrame(i / 2, action)));
    const file = path.join(directory, action ? 'action.mkv' : 'camera.mkv');
    const result = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-framerate', '2', '-s', '96x60',
      '-pix_fmt', 'gray', '-i', 'pipe:0', '-c:v', 'ffv1', file], { input });
    assert.equal(result.status, 0, result.stderr.toString());
    const sha256 = (action ? 'f' : 'a').repeat(64);
    const asset = { path: file, sha256, duration: 48 };
    const report = await scanMotionWindows(asset, { ffmpeg, cache: directory });
    const windows = report.candidates;
    assert.equal(report.decoded, 96);
    if (action) {
      assert.equal(windows.length, 2, JSON.stringify(windows));
      assert.ok(windows[0].sourceStart >= 19.5 && windows[0].sourceEnd <= 28.5);
      assert.ok(windows[1].sourceStart >= 35.5 && windows[1].sourceEnd <= 44.5);
      for (const w of windows) {
        assert.equal(w.sourceStart, w.fromSeconds);
        assert.ok(w.toSeconds > w.fromSeconds && w.toSeconds < w.sourceEnd);
      }
    } else assert.deepEqual(windows, [], JSON.stringify(windows));
    assert.ok(report.counts.camera);
    assert.ok(report.counts.still);
    assert.ok(report.counts['cut-or-global-change']);
    assert.deepEqual(await scanMotionWindows({ ...asset, path: 'removed' }, { ffmpeg, cache: directory }), report);
  }
  assert.equal((await readdir(path.join(directory, 'motion-windows'))).length, 2);
});
