import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

const version = 1;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const lexical = /[\p{L}\p{N}]/u;
const clause = /[,，、。！？.!?；;：:…]/u;
const boundary = (text, i, tokens) => (i >= tokens.length ? text.length : i === 0 ? 0 : tokens[i].index);
const compact = (value) => Number(value.toFixed(4));

function tokensOf(text) {
  return [...text.matchAll(/[\p{L}\p{N}]/gu)].map((m) => ({
    index: m.index,
    key: m[0].normalize('NFKC').toLowerCase(),
  }));
}

// whisper.cpp may spell a proper name differently. Locate its timed boundaries in the
// approved script with a monotone character alignment; only original text becomes a cue.
function mappedRows(tokens, rows) {
  const heard = [],
    ends = [];
  for (const row of rows) {
    heard.push(...tokensOf(row.text).map((t) => t.key));
    ends.push(heard.length);
  }
  const cols = heard.length + 1;
  if (!heard.length || cols > 4000 || !tokens.length) return null;
  const table = new Uint16Array((tokens.length + 1) * cols);
  for (let i = 1; i <= tokens.length; i++) {
    for (let j = 1; j < cols; j++) {
      const at = i * cols + j;
      table[at] =
        tokens[i - 1].key === heard[j - 1] ? table[at - cols - 1] + 1 : Math.max(table[at - cols], table[at - 1]);
    }
  }
  let i = tokens.length,
    j = heard.length;
  const matches = [];
  while (i && j) {
    if (tokens[i - 1].key === heard[j - 1]) {
      matches.push([j - 1, i - 1]);
      i--;
      j--;
    } else if (table[i * cols + j - 1] >= table[(i - 1) * cols + j]) j--;
    else i--;
  }
  if (matches.length / Math.max(tokens.length, heard.length) < 0.42) return null;
  matches.reverse();
  const anchors = [[0, 0], ...matches.map(([a, b]) => [a + 1, b + 1]), [heard.length, tokens.length]];
  let from = 0,
    idx = 0;
  const result = [];
  for (const [k, row] of rows.entries()) {
    const end = ends[k];
    while (idx + 1 < anchors.length && anchors[idx + 1][0] <= end) idx++;
    const [x0, y0] = anchors[idx],
      [x1, y1] = anchors[idx + 1] || [x0, y0];
    const to = Math.max(
      from,
      k === rows.length - 1
        ? tokens.length
        : Math.round(x0 === x1 ? y0 : y0 + ((end - x0) * (y1 - y0)) / (x1 - x0))
    );
    if (to > from) result.push({ from, to, start: row.start, end: row.end });
    from = to;
  }
  return result.length ? result : null;
}

// Generated media is a local PCM WAV. Measure its audible outer edges so whisper's
// rounded segment boundaries do not fill leading or trailing silence with text.
export async function audibleBounds(file) {
  const info = await stat(file);
  if (info.size < 44 || info.size > 64 * 1024 * 1024) return null;
  const wav = await readFile(file);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt, data;
  for (let i = 12; i + 8 <= wav.length; ) {
    const len = wav.readUInt32LE(i + 4),
      key = wav.toString('ascii', i, i + 4),
      begin = i + 8;
    if (len > wav.length - begin) break;
    if (key === 'fmt ' && len >= 16)
      fmt = {
        type: wav.readUInt16LE(begin),
        channels: wav.readUInt16LE(begin + 2),
        rate: wav.readUInt32LE(begin + 4),
        bits: wav.readUInt16LE(begin + 14),
      };
    if (key === 'data') data = wav.subarray(begin, begin + len);
    i = begin + len + (len % 2);
  }
  if (!fmt || !data || fmt.type !== 1 || fmt.bits !== 16 || ![1, 2].includes(fmt.channels) || fmt.rate < 8000)
    return null;
  const step = Math.round(fmt.rate * 0.015),
    stride = 2 * fmt.channels,
    rms = [];
  for (let pos = 0; pos + stride <= data.length; pos += step * stride) {
    let total = 0,
      n = 0;
    for (let k = pos; k + stride <= Math.min(data.length, pos + step * stride); k += stride) {
      total += (data.readInt16LE(k) / 32768) ** 2;
      n++;
    }
    rms.push(Math.sqrt(total / n));
  }
  const peak = rms.reduce((m, x) => Math.max(m, x), 0),
    threshold = Math.max(0.0015, peak * 0.012);
  const first = rms.findIndex((x, i) => x > threshold && rms[i + 1] > threshold);
  const last = rms.findLastIndex((x, i) => x > threshold && rms[i - 1] > threshold);
  if (first < 0 || last < first) return null;
  return {
    start: compact(Math.max(0, ((first - 1) * step) / fmt.rate)),
    end: compact(Math.min(data.length / stride / fmt.rate, ((last + 2) * step) / fmt.rate)),
  };
}

function cutPoints(script, tokens, rows) {
  const punctuation = new Set(),
    spoken = new Set(),
    forced = new Set([tokens.length]);
  const words = new Set([
    0,
    ...Array.from(new Intl.Segmenter('zh', { granularity: 'word' }).segment(script), (s) => s.index),
  ]);
  for (const [i, t] of tokens.entries()) {
    const after = script.slice(t.index + t.key.length, boundary(script, i + 1, tokens));
    if (clause.test(after)) punctuation.add(i + 1);
  }
  for (let i = 0; i < rows.length - 1; i++) {
    const pos = rows[i].to;
    spoken.add(pos);
    if (rows[i + 1].start - rows[i].end >= 0.24) forced.add(pos);
  }
  const cuts = [0],
    width = (t) =>
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(t.key) ? 1 : 0.52;
  let start = 0;
  for (const limit of [...forced].sort((a, b) => a - b)) {
    while (start < limit) {
      let total = 0,
        stop = start,
        punctBreak,
        spokenBreak,
        wordBreak;
      while (stop < limit && total + width(tokens[stop]) <= 18) {
        total += width(tokens[stop++]);
        if (total < 6 || limit - stop < 3) continue;
        if (punctuation.has(stop)) punctBreak = stop;
        if (words.has(boundary(script, stop, tokens))) {
          wordBreak = stop;
          if (spoken.has(stop)) spokenBreak = stop;
        }
      }
      const end = stop === limit ? limit : punctBreak || spokenBreak || wordBreak || stop;
      cuts.push(end);
      start = end;
    }
  }
  return cuts;
}

export function alignScript(script, segments, duration, sound = null) {
  const tokens = tokensOf(script),
    rows = [];
  let last = 0;
  for (const s of segments || []) {
    const start = Math.max(last, 0, Number(s.start)),
      end = Math.min(duration, Number(s.end));
    if (lexical.test(String(s.text || '')) && Number.isFinite(start) && Number.isFinite(end) && end > start) {
      rows.push({ text: String(s.text), start: compact(start), end: compact(end) });
      last = end;
    }
  }
  const audioStart = sound?.start ?? 0,
    audioEnd = sound?.end ?? duration;
  const trimmed = rows
    .map((r) => ({ ...r, start: Math.max(audioStart, r.start), end: Math.min(audioEnd, r.end) }))
    .filter((r) => r.end > r.start);
  const measured = mappedRows(tokens, trimmed);
  const method = measured
    ? 'whisper.cpp'
    : trimmed.length
      ? 'whisper-unmatched'
      : sound
        ? 'waveform-only'
        : 'duration-fallback';
  const timed = measured || [
    {
      from: 0,
      to: Math.max(1, tokens.length),
      start: trimmed[0]?.start ?? audioStart,
      end: trimmed.at(-1)?.end ?? audioEnd,
    },
  ];
  const timing = (row, k) => row.start + ((row.end - row.start) * (k - row.from)) / (row.to - row.from);
  const cues = [];
  if (!tokens.length)
    cues.push({ text: script, start: timed[0].start, end: timed.at(-1).end, timing: 'estimated' });
  const cuts = cutPoints(script, tokens, timed);
  for (let i = 1; i < cuts.length; i++) {
    const from = cuts[i - 1],
      to = cuts[i],
      left = timed.find((r) => r.to > from),
      right = timed.find((r) => r.to >= to);
    const start = compact(timing(left, from)),
      end = compact(timing(right, to));
    const measuredEdges = measured && left.from === from && right.to === to;
    cues.push({
      text: script.slice(boundary(script, from, tokens), boundary(script, to, tokens)),
      start,
      end,
      timing: measuredEdges ? 'asr-segments' : measured ? 'within-segment' : 'estimated',
    });
  }
  return { method, segments: rows, audible: sound, cues };
}

export async function narrationAlignment(deps, projectId, asset, script, signal) {
  const key = asset.sha256 || asset.id,
    scriptHash = hash(script),
    current = await deps.store.get(projectId);
  const old = current.speechAlignments?.[key];
  if (old?.version === version && old.scriptHash === scriptHash && old.method === 'whisper.cpp') return old;
  signal?.throwIfAborted();
  const directory = (await deps.store.paths(projectId)).cache;
  let rows = [],
    reason;
  try {
    rows = await deps.audio.transcribe(asset.path, {
      directory,
      signal,
      maxChars: 8,
      language: /[\p{Script=Han}]/u.test(script) ? 'zh' : 'auto',
    });
  } catch {
    signal?.throwIfAborted();
    reason = 'whisper-unavailable';
  }
  const sound = await audibleBounds(asset.path).catch(() => null);
  signal?.throwIfAborted();
  const result = {
    version,
    assetId: asset.id,
    audioHash: asset.sha256,
    scriptHash,
    ...alignScript(script, rows, asset.duration, sound),
  };
  if (reason) result.reason = reason;
  const latest = await deps.store.get(projectId);
  await deps.store.setMeta(projectId, { speechAlignments: { ...latest.speechAlignments, [key]: result } });
  return result;
}

export function captionCues(alignment, { id, group, assetId, start, duration, fps, speed = 1 }) {
  const timed = [];
  for (const cue of alignment.cues) {
    const at = Math.max(timed.at(-1)?.end || 0, Math.min(duration - 1, Math.round((cue.start * fps) / speed)));
    if (at >= duration) {
      const previous = timed.at(-1);
      previous.clip.text += cue.text;
      continue;
    }
    const end = Math.min(duration, Math.max(at + 1, Math.round((cue.end * fps) / speed)));
    const i = timed.length;
    timed.push({
      end,
      clip: {
        id: i === 0 ? id : id + '-' + (i + 1),
        track: 'caption',
        text: cue.text,
        start: start + at,
        duration: end - at,
        sourceIn: 0,
        speed: 1,
        gain: 1,
        speechGroup: group,
        speechAssetId: assetId,
        speechCue: i,
        alignmentMethod: alignment.method,
        cueTiming: cue.timing,
      },
    });
  }
  return timed.map((x) => x.clip);
}

export const withinSegmentMessage = '语音段的起止已用本地转录核对；长句内部分换字幕时刻按段内字数估算。';
export function alignmentNote(alignment, group, frame) {
  const estimated = alignment.cues.some((c) => c.timing === 'within-segment');
  if (alignment.method === 'whisper.cpp' && !estimated) return null;
  const message =
    alignment.method === 'whisper.cpp'
      ? withinSegmentMessage
      : alignment.method === 'whisper-unmatched'
        ? '转录和原稿的文字无法可靠匹配，已采用语音段边界；请试听段内字幕。'
        : alignment.method === 'waveform-only'
          ? '本句缺少可核对的转录，字幕按本地波形的有声范围估算。'
          : '本句缺少可核对的语音时码，字幕按音频总时长估算。';
  return { type: 'suggestion', kind: 'speech-alignment', speechGroup: group, frame, message };
}
