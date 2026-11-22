import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { requiredTool, mediaSlot, inputArgs } from './media-runtime.mjs';

const execute = promisify(execFile);
const width = 96, height = 60, rate = 2, maxSeconds = 160;
const version = 1;
const shapeCache = new Map();

// Use the reviewer's sampling grid and luminance transfer. Precompute indices once per image size.
function samplingGrid(w, h) {
  const key = w + 'x' + h;
  if (shapeCache.has(key)) return shapeCache.get(key);
  const center = [];
  for (let y = 6; y < h - 6; y += 2) for (let x = 9; x < w - 9; x += 2) {
    center.push(x + y * w);
  }
  const make = (zoom, dx, dy) => {
    const first = [], second = [];
    for (const offset of center) {
      const x = offset % w, y = Math.floor(offset / w);
      const tx = Math.round((x - w / 2) / zoom + w / 2 + dx);
      const ty = Math.round((y - h / 2) / zoom + h / 2 + dy);
      if (tx >= 0 && ty >= 0 && tx < w && ty < h) { first.push(offset); second.push(tx + ty * w); }
    }
    return { first: Uint32Array.from(first), second: Uint32Array.from(second), zoom, dx, dy };
  };
  const transforms = [];
  for (const zoom of [1, .92, .96, 1.04, 1.08])
    for (const dx of [0, -6, -3, 3, 6])
      for (const dy of [0, -4, -2, 2, 4]) transforms.push(make(zoom, dx, dy));
  const grid = { center, transforms, make, refined: new Map() };
  shapeCache.set(key, grid);
  return grid;
}

function luma(input, w, h) {
  if (input.length === w * h) return input;
  if (input.length !== w * h * 3) throw Error('运动比较需要相同大小的灰度或 RGB 帧。');
  const result = new Float64Array(w * h);
  for (let i = 0, j = 0; i < result.length; i++, j += 3)
    result[i] = .25 * input[j] + .52 * input[j + 1] + .23 * input[j + 2];
  return result;
}

function fit(a, b, transform, before = Infinity, exposure = 0) {
  const { first, second } = transform, len = first.length;
  const bound = before * len;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += Math.min(50, Math.abs(a[first[i]] - b[second[i]] - exposure));
    if (sum >= bound) return before;
  }
  return sum / Math.max(1, len);
}

function compare(a, b, grid, exposure = 0) {
  let best = Infinity, transform, raw;
  for (const t of grid.transforms) {
    const error = fit(a, b, t, best, exposure);
    if (raw === undefined) raw = error;
    if (error < best) { best = error; transform = t; }
    if (!best) break;
  }
  return { raw, best, transform };
}

// Used unchanged by final QA. Additional cut/exposure and persistence checks only rank source windows.
export function sceneChange(a, b, w, h) {
  const { raw, best } = compare(luma(a, w, h), luma(b, w, h), samplingGrid(w, h));
  return { change: +raw.toFixed(2), afterGlobalMotion: +best.toFixed(2) };
}

function averagedExposure(a, b, grid) {
  const differences = [];
  for (let i = 0; i < grid.center.length; i += 7) {
    const j = grid.center[i];
    differences.push(a[j] - b[j]);
  }
  differences.sort((x, y) => x - y);
  return differences[Math.floor(differences.length / 2)] || 0;
}

// Half-second shifts often fall between QA's coarse transform grid positions.
function refine(a, b, grid, coarse, exposure) {
  let { best, transform } = coarse;
  const current = transform;
  for (const zoom of [current.zoom, current.zoom - .02, current.zoom + .02])
    for (const dx of [current.dx, current.dx - 1, current.dx + 1, current.dx - 2, current.dx + 2])
      for (const dy of [current.dy, current.dy - 1, current.dy + 1]) {
        const key = [zoom.toFixed(2), dx, dy].join('/');
        if (!grid.refined.has(key)) grid.refined.set(key, grid.make(zoom, dx, dy));
        const t = grid.refined.get(key), error = fit(a, b, t, best, exposure);
        if (error < best) { best = error; transform = t; }
      }
  return { best, transform };
}

function pairMotion(a, b, grid) {
  const exposure = averagedExposure(a, b, grid);
  let measured = compare(a, b, grid, exposure);
  if (measured.raw < 1.6) return { type: Math.abs(exposure) > 15 ? 'exposure' : 'still', strength: 0 };
  if (measured.best >= 3.2) measured = { ...measured, ...refine(a, b, grid, measured, exposure) };
  const { best, raw, transform } = measured;
  if (best < 3.2 || (best < 5 && best < raw * .35)) return { type: 'camera', strength: 0 };
  let affected = 0, near = 0, unexplained = 0;
  const cells = new Float32Array(12), counts = new Uint16Array(12);
  const { first, second } = transform;
  for (let i = 0; i < first.length; i++) {
    const d = Math.abs(a[first[i]] - b[second[i]] - exposure);
    const x = first[i] % width, y = Math.floor(first[i] / width);
    const cell = Math.floor((y - 6) * 3 / (height - 12)) * 4 + Math.floor((x - 9) * 4 / (width - 18));
    counts[cell]++; cells[cell] += Math.min(50, d);
    if (d >= 14) {
      affected++;
      // Resampling a photograph shifts high-contrast boundaries fractionally. A one-pixel
      // neighbourhood can explain those edges, but cannot replace a moving object's interior.
      const j = second[i], x1 = j % width;
      if (x1 > 0 && x1 < width - 1 && j >= width && j < b.length - width) {
        const target = a[first[i]] - exposure;
        let low = b[j], high = b[j];
        for (const offset of [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1]) {
          const neighbour = b[j + offset];
          low = Math.min(low, neighbour); high = Math.max(high, neighbour);
        }
        if (target < low - 9 || target > high + 9) unexplained++;
      }
    }
    if (d <= 7) near++;
  }
  const hot = affected / first.length;
  const busy = cells.filter((sum, i) => sum / Math.max(1, counts[i]) >= 6).length;
  if (hot > .57 || (near / first.length < .43 && busy > 9) || (best > 15 && busy === 12))
    return { type: 'cut-or-global-change', strength: 0 };
  const transformed = transform.zoom !== 1 || transform.dx !== 0 || transform.dy !== 0;
  if (hot > .035 && unexplained < affected * .12 && (transformed || busy > 6))
    return { type: 'camera', strength: 0 };
  if (hot < .035 || !busy) return { type: 'low-change', strength: 0 };
  return { type: 'local-change', strength: +Math.min(18, best).toFixed(2) };
}

export function motionSamplingPlan(duration) {
  if (!(Number.isFinite(duration) && duration > 0)) return [];
  if (duration <= maxSeconds) return [{ start: 0, duration }];
  const count = 10, chunk = maxSeconds / count;
  return Array.from({ length: count }, (_, i) => ({
    start: Math.floor((duration - chunk) * i / (count - 1) * rate) / rate, duration: chunk,
  }));
}

function rankedWindows(samples) {
  const windows = [];
  for (let first = 0; first < samples.length; first++) {
    let good = 0, strength = 0, quiet = 0;
    for (let last = first; last < Math.min(first + 14, samples.length); last++) {
      const s = samples[last], size = last - first + 1;
      if (s.cut || s.type === 'cut-or-global-change' || s.type === 'exposure') break;
      if (s.type === 'local-change') { good++; strength += s.strength; quiet = 0; } else quiet++;
      if (quiet >= 3) break;
      if (size < 4 || good / size < .72 || samples[first].type !== 'local-change' || s.type !== 'local-change') continue;
      const fromSeconds = samples[first].start;
      const toSeconds = s.end;
      windows.push({
        sourceStart: fromSeconds, sourceEnd: toSeconds,
        activeFraction: +(good / size).toFixed(2),
        score: good / size * 5 + Math.min(5.5, toSeconds - fromSeconds) * .7 + strength / good * .38,
      });
    }
  }
  return windows;
}

function selectWindows(windows, duration) {
  const chosen = [], gap = Math.max(1.5, Math.min(9, duration * .035));
  for (const item of windows.sort((a, b) => b.score - a.score || a.sourceStart - b.sourceStart)) {
    if (chosen.some(other => item.sourceEnd + gap > other.sourceStart && item.sourceStart < other.sourceEnd + gap)) continue;
    chosen.push(item);
    if (chosen.length === 4) break;
  }
  return chosen.sort((a, b) => a.sourceStart - b.sourceStart).map(({ score, ...item }) => item);
}

function sourceWitness(window, sections) {
  const section = sections.find(s => s.start <= window.sourceStart && window.sourceEnd <= s.start + (s.frames.length - 1) / rate);
  const start = Math.round((window.sourceStart - section.start) * rate);
  const end = Math.round((window.sourceEnd - section.start) * rate);
  const grid = samplingGrid(width, height);
  let best = -1, toSeconds = window.sourceStart + 1;
  for (let index = start + rate; index < Math.min(end, start + 4 * rate); index++) {
    const pair = pairMotion(section.frames[start], section.frames[index], grid);
    if (pair.type === 'local-change' && pair.strength > best) {
      best = pair.strength;
      toSeconds = section.start + index / rate;
    }
  }
  return { ...window, fromSeconds: window.sourceStart, toSeconds };
}

function summarizeQuiet(samples) {
  const result = [];
  let start;
  const flush = () => {
    if (start && start.end - start.start >= 1.5) result.push([start.start, start.end]);
    start = undefined;
  };
  for (const pair of samples) {
    if (!pair.cut && ['still', 'camera', 'low-change'].includes(pair.type)) {
      if (start) start.end = pair.end; else start = { start: pair.start, end: pair.end };
    } else flush();
  }
  flush();
  return result;
}

export async function analyzeMotionSamples(frames, start, signal) {
  const samples = [], grid = samplingGrid(width, height);
  let previousCut = false;
  for (let i = 1; i < frames.length; i++) {
    if (i % 8 === 1) { signal?.throwIfAborted(); await nextTurn(); }
    const near = pairMotion(frames[i - 1], frames[i], grid);
    const cut = ['cut-or-global-change', 'exposure'].includes(near.type);
    if (i >= 2) {
      const pair = pairMotion(frames[i - 2], frames[i], grid);
      samples.push({ ...pair, start: start + (i - 2) / rate, end: start + i / rate,
        cut: cut || previousCut });
    }
    previousCut = cut;
  }
  return samples;
}

export async function scanMotionWindows(asset, { signal, cache, ffmpeg } = {}) {
  signal?.throwIfAborted();
  const plan = motionSamplingPlan(Number(asset.duration));
  const file = cache && /^[0-9a-f]{64}$/i.test(asset.sha256 || '') ?
    path.join(cache, 'motion-windows', 'v' + version + '-' + asset.sha256 + '.json') : null;
  if (file) {
    try {
      const hit = JSON.parse(await readFile(file, 'utf8'));
      signal?.throwIfAborted();
      if (hit.version === version && hit.duration === asset.duration && hit.sha256 === asset.sha256 && Array.isArray(hit.candidates))
        return hit;
    } catch { signal?.throwIfAborted(); /* An incomplete cache can be rebuilt from the registered media. */ }
  }
  const scan = await mediaSlot(async () => {
    const executable = ffmpeg || await requiredTool('ffmpeg');
    const local = AbortSignal.timeout(45000), active = signal ? AbortSignal.any([signal, local]) : local;
    const size = width * height, windows = [], quiet = [], counts = {}, sections = [];
    let decoded = 0, compared = 0;
    for (const section of plan) {
      active.throwIfAborted();
      const limit = Math.max(1, Math.ceil(section.duration * rate));
      const { stdout } = await execute(executable, ['-nostdin', '-v', 'error', '-ss', String(section.start),
        ...inputArgs(asset.path), '-t', String(section.duration), '-map', '0:v:0', '-an', '-sn', '-dn',
        '-vf', 'fps=' + rate + ':round=up,scale=' + width + ':' + height + ':flags=area,format=gray',
        '-filter_threads', '1', '-threads', '1', '-frames:v', String(limit), '-f', 'rawvideo', 'pipe:1'],
      { signal: active, encoding: 'buffer', maxBuffer: size * (limit + 2), timeout: 20000 });
      const count = Math.floor(stdout.length / size), frames = [];
      for (let i = 0; i < count; i++) frames.push(stdout.subarray(i * size, (i + 1) * size));
      decoded += count;
      sections.push({ start: section.start, frames });
      const samples = await analyzeMotionSamples(frames, section.start, active);
      compared += samples.length;
      for (const s of samples) {
        const key = s.cut ? 'cut-or-global-change' : s.type;
        counts[key] = (counts[key] || 0) + 1;
      }
      windows.push(...rankedWindows(samples));
      quiet.push(...summarizeQuiet(samples));
    }
    active.throwIfAborted();
    return { version, sha256: asset.sha256, duration: asset.duration, plan, width, height, rate, decoded,
      compared, counts, quiet, candidates: selectWindows(windows, asset.duration).map(w => sourceWitness(w, sections)) };
  }, signal);
  signal?.throwIfAborted();
  if (file) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(scan), { signal });
      signal?.throwIfAborted();
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  return scan;
}
