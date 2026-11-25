import test from 'node:test';
import assert from 'node:assert/strict';
import { measureMotion } from '../src/visual-review.mjs';
import { compositionSamples, pixelDifference } from '../src/composite-parity.mjs';
import { reviewStage } from '../src/review-stage.mjs';
const project = {
  style: { id: 'henry-hot-news', version: 8 },
  profile: { width: 1080, height: 1920, fps: 30 },
  timeline: { clips: [] },
};
const asset = { id: 'source', kind: 'video', path: 'original' };
const clip = {
  id: 'right',
  track: 'video',
  assetId: asset.id,
  start: 0,
  duration: 40,
  viewport: { x: 0.5, y: 0, width: 0.5, height: 1 },
};
const view = { from: 0, to: 39, shot: { clip, asset }, regions: [clip.viewport] };
const field = (t, w, h) =>
  Buffer.from(
    Array.from({ length: w * h * 3 }, (_, i) => ((i * 13 + Math.floor(t * 30) * 73) ^ (i >>> 5)) % 252),
  );

test('an animated title/background cannot certify action in a stationary portrait footage pane', async () => {
  const seen = [];
  const results = await measureMotion(project, [view], null, undefined, 'portrait', {
    readPixels: async (_ff, file, t, w, h, _signal, rect) => {
      if (file === 'original') return field(t, w, h);
      seen.push(rect);
      const inside = rect?.x === 540 && rect?.y === 656 && rect?.width === 540 && rect?.height === 608;
      return inside ? Buffer.alloc(w * h * 3, 77) : field(t, w, h);
    },
    checkFrozen: async (_ff, file, _at, _d, _fps, _n, _s, rect) => file === 'portrait' && rect?.y === 656,
  });
  assert.equal(results[0].sourceResult, 'changing-footage');
  assert.equal(results[0].candidateResult, 'no-detectable-change');
  assert.equal(results[0].confirmedFrozen, true);
  assert.deepEqual(seen, Array(3).fill({ x: 540, y: 656, width: 540, height: 608 }));
  assert.equal(results[0].sampledRegion.y, 656 / 1920);
});

test('portrait JSX/viewport parity compares the actual footage canvas and exposes a difference hidden by the title area', () => {
  const stage = reviewStage(project);
  assert.deepEqual(stage.viewport, { x: 0, y: 656, width: 1080, height: 608 });
  const c = {
    id: 'feature',
    track: 'graphic',
    start: 0,
    duration: 40,
    motion: { componentId: 'impact-title', cueFrames: [0] },
    geometry: { x: 0.25, y: 0.14, width: 0.2, height: 0.16 },
  };
  const p = { ...project, timeline: { clips: [c, clip] } };
  const samples = compositionSamples(p);
  const actual = samples.find((s) => s.clipId === 'feature').bounds;
  const w = 108,
    h = 192,
    before = Buffer.alloc(w * h * 3),
    after = Buffer.alloc(w * h * 3);
  for (let y = 70; y < 81; y++)
    for (let x = 17; x < 37; x++) for (let k = 0; k < 3; k++) after[3 * (y * w + x) + k] = 255;
  assert.equal(
    pixelDifference(before, after, w, h, { x: 0.15, y: 0.06, width: 0.2, height: 0.16 }).matches,
    true,
  );
  assert.equal(pixelDifference(before, after, w, h, actual).matches, false);
  assert.equal(samples.find((s) => s.clipId === 'right').bounds.y, 656 / 1920);
  const regular = reviewStage({ ...project, style: { id: 'neutral', version: 1 } });
  assert.equal(regular.viewport, null);
  assert.deepEqual(regular.rect({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 });
});
