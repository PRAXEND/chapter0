import { stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createAss, createSrt } from './text-tracks.mjs';
import { ffBase, inputArgs, mediaTool, requiredTool, run, scratch } from './media-runtime.mjs';

export { mediaTool };

export async function mediaCapabilities() {
  const [ffmpeg, ffprobe, melt] = await Promise.all(['ffmpeg', 'ffprobe', 'melt'].map(mediaTool));
  return { ffmpeg, ffprobe, melt, ready: Boolean(ffmpeg && ffprobe), engine: melt ? 'mlt' : 'ffmpeg' };
}

export async function probeMedia(file, { signal } = {}) {
  const location = path.resolve(file);
  if (!(await stat(location)).isFile()) throw new Error('请选择普通素材文件');
  const json = await run(await requiredTool('ffprobe'), ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', location], { signal });
  const { streams, format } = JSON.parse(json);
  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find(s => s.codec_type === 'audio');
  if (!audio && !video) throw new Error('素材不含可读的音视频流');
  const image = video && !audio && (/image2|_pipe|^ico$/.test(format.format_name) || /\.(heic|heif|avif)$/i.test(location) && !Number(video.duration));
  const duration = Number((image ? 0 : video?.duration) || audio?.duration || format.duration) || 0;
  const rotation = Math.abs(Number(video?.side_data_list?.find(s => s.rotation != null)?.rotation ?? video?.tags?.rotate ?? 0)) % 180;
  const width = video ? Number(rotation === 90 ? video.height : video.width) : 0;
  const height = video ? Number(rotation === 90 ? video.width : video.height) : 0;
  return { kind: image ? 'image' : video ? 'video' : 'audio', duration, width, height, hasAudio: Boolean(audio), videoCodec: video?.codec_name, audioCodec: audio?.codec_name, frames: Number(video?.nb_frames) || undefined, sampleRate: Number(audio?.sample_rate) || undefined };
}

export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function frameAt(file, seconds, output, { signal, maxWidth } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('预览时间无效');
  const ext = path.extname(output).toLowerCase();
  if (!['.jpg', '.jpeg', '.png'].includes(ext)) throw new Error('预览图片请使用 PNG 或 JPEG');
  await scratch(path.dirname(output), async work => {
    const target = path.join(work, 'frame' + ext);
    const scale = Number.isInteger(maxWidth) && maxWidth > 1 ? ['-vf', `scale='min(iw,${Math.min(8192, maxWidth)})':-2`] : [];
    await run(await requiredTool('ffmpeg'), [...ffBase, '-ss', String(seconds), ...inputArgs(path.resolve(file)), '-map', '0:v:0', '-an', ...scale, '-frames:v', '1', '-update', '1', target], { signal });
    if (!(await stat(target).catch(() => null))?.size) throw new Error('所选区间没有可读取的画面');
    signal?.throwIfAborted();
    await rename(target, output);
  });
  return output;
}

function validate(project) {
  const { width, height, fps } = project.profile ?? {};
  if (![width, height].every(v => Number.isInteger(v) && v >= 16 && v <= 8192 && v % 2 === 0) || !(Number.isInteger(fps) && fps >= 1 && fps <= 60)) throw new Error('工程尺寸须为偶数，帧率范围为 1–60');
  const clips = (project.timeline?.clips ?? []).filter(c => !c.hidden && c.enabled !== false);
  for (const c of clips) {
    if (!['video', 'narration', 'music', 'caption', 'graphic'].includes(c.track) || !Number.isInteger(c.start) || c.start < 0 || !Number.isInteger(c.duration) || c.duration < 1) throw new Error('时间线包含无效片段');
    if (!Number.isInteger(c.sourceIn ?? 0) || (c.sourceIn ?? 0) < 0 || !Number.isFinite(c.speed ?? 1) || (c.speed ?? 1) < 0.125 || (c.speed ?? 1) > 8 || !Number.isFinite(c.gain ?? 1) || (c.gain ?? 1) < 0 || (c.gain ?? 1) > 16) throw new Error('片段源区间、速率或音量无效');
  }
  const length = clips.reduce((end, c) => Math.max(end, c.start + c.duration), 0);
  if (!length) throw new Error('请先在时间线上加入素材');
  return { width, height, fps, clips, length };
}

function pictureSpans(clips, length) {
  const video = clips.filter(c => c.track === 'video').sort((a, b) => a.start - b.start);
  const cuts = new Set([0, length]);
  for (const c of video) {
    cuts.add(c.start); cuts.add(c.start + c.duration);
    if (['fade', 'crossfade', 'dissolve'].includes(c.transition?.type) && Number.isInteger(c.transition.duration) && c.transition.duration > 0) cuts.add(c.start + Math.min(c.transition.duration, c.duration));
  }
  const positions = [...cuts].sort((a, b) => a - b);
  return positions.slice(0, -1).map((start, i) => {
    const active = video.filter(c => c.start <= start && c.start + c.duration > start);
    return { start, duration: positions[i + 1] - start, top: active.at(-1), under: active.at(-2) };
  });
}

const rounded = n => String(Number(n.toFixed(7)));
const videoEncode = ['-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '16', '-threads', '2'];

function buildVisualInput(clip, span, asset, profile, index) {
  const { width, height, fps } = profile;
  const d = span.duration / fps;
  const rate = clip.speed ?? 1;
  const source = ((clip.sourceIn ?? 0) + (span.start - clip.start) * rate) / fps;
  const args = asset.kind === 'image' ? ['-loop', '1', '-framerate', String(fps), ...inputArgs(asset.path)] : ['-ss', rounded(source), ...inputArgs(asset.path)];
  const cover = clip.fit === 'cover';
  const size = cover ? `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${width}:${height}` : `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
  const chain = `[${index}:v:0]setpts=(PTS-STARTPTS)/${rounded(rate)},fps=${fps},${size},setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=${rounded(d)},trim=end_frame=${span.duration},setpts=N/(${fps}*TB)[v${index}]`;
  return { args, chain };
}

async function renderSpan(span, media, profile, ffmpeg, target, signal) {
  const { width, height, fps } = profile;
  const lavfi = ['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}`];
  const out = ['-frames:v', String(span.duration), ...videoEncode, target];
  if (!span.top) return run(ffmpeg, [...ffBase, ...lavfi, ...out], { signal });
  const top = span.top;
  const fade = ['fade', 'crossfade', 'dissolve'].includes(top.transition?.type) ? Math.min(top.duration, Math.max(0, Math.floor(top.transition.duration || 0))) : 0;
  const elapsed = span.start - top.start;
  const blend = fade > 0 && elapsed < fade;
  const upper = buildVisualInput(top, span, media.get(top.assetId), profile, 0);
  let args = upper.args;
  let filter = upper.chain;
  let outputLabel = 'v0';
  if (blend) {
    const lower = span.under ? buildVisualInput(span.under, span, media.get(span.under.assetId), profile, 1) : { args: lavfi, chain: '[1:v]format=yuv420p[v1]' };
    args = [...args, ...lower.args];
    // The timeline determines opacity even when another cut divides this transition.
    const weight = `min(1,(N+${elapsed})/${Math.max(1, fade)})`;
    filter += `;${lower.chain};[v0][v1]blend=all_expr='A*(${weight})+B*(1-${weight})':shortest=1[composed]`;
    outputLabel = 'composed';
  }
  return run(ffmpeg, [...ffBase, ...args, '-filter_complex', filter, '-map', `[${outputLabel}]`, ...out], { signal });
}

async function assemblePicture(spans, work, profile, ffmpeg, melt, signal) {
  const { width, height, fps } = profile;
  const geometry = { description: 'Video Studio', width, height, progressive: 1, sample_aspect_num: 1, sample_aspect_den: 1, display_aspect_num: width, display_aspect_den: height, frame_rate_num: fps, frame_rate_den: 1, colorspace: 709 };
  const out = path.join(work, 'picture.mp4');
  if (melt) {
    await writeFile(path.join(work, 'profile'), Object.entries(geometry).map(([k, v]) => k + '=' + v).join('\n') + '\n');
    const profileXml = Object.entries(geometry).map(([k, v]) => `${k}="${v}"`).join(' ');
    const producers = spans.map((_, i) => `<producer id="v${i}"><property name="resource">span-${i}.mp4</property><property name="mlt_service">avformat</property><property name="set.test_audio">1</property></producer>`).join('');
    const entries = spans.map((s, i) => `<entry producer="v${i}" in="0" out="${s.duration - 1}"/>`).join('');
    await writeFile(path.join(work, 'picture.mlt'), `<mlt producer="sequence"><profile ${profileXml}/>${producers}<playlist id="sequence">${entries}</playlist></mlt>`);
    await run(melt, ['-silent', '-profile', path.join(work, 'profile'), path.join(work, 'picture.mlt'), '-consumer', 'avformat:' + out, 'vcodec=libx264', 'pix_fmt=yuv420p', 'an=1', 'threads=2', 'real_time=-1', 'terminate_on_pause=1', 'preset=ultrafast', 'crf=16'], { cwd: work, signal, env: { QT_QPA_PLATFORM: 'offscreen' } });
  } else {
    await writeFile(path.join(work, 'picture.concat'), spans.map((_, i) => `file 'span-${i}.mp4'`).join('\n') + '\n');
    await run(ffmpeg, [...ffBase, '-f', 'concat', '-safe', '1', '-protocol_whitelist', 'file', '-i', 'picture.concat', '-an', '-c:v', 'copy', out], { cwd: work, signal });
  }
  return out;
}

function tempo(rate) {
  const filters = [];
  while (rate < 0.5) { filters.push('atempo=0.5'); rate *= 2; }
  while (rate > 2) { filters.push('atempo=2'); rate /= 2; }
  if (rate !== 1) filters.push(`atempo=${rounded(rate)}`);
  return filters;
}

async function renderMix(clips, media, work, fps, length, ffmpeg, signal) {
  const audioClips = clips.filter(c => ['video', 'narration', 'music'].includes(c.track) && media.get(c.assetId)?.hasAudio && (c.gain ?? 1) > 0 && !c.muted);
  const buses = { voice: [], music: [] };
  for (const [index, c] of audioClips.entries()) {
    const asset = media.get(c.assetId);
    const rate = c.speed ?? 1;
    const duration = c.duration / fps;
    const out = path.join(work, `sound-${index}.wav`);
    const filter = [`atrim=duration=${rounded(duration * rate)}`, 'asetpts=PTS-STARTPTS', 'aresample=48000', ...tempo(rate), `volume=${rounded(c.gain ?? 1)}`, 'apad', `atrim=end_sample=${Math.round(duration * 48000)}`].join(',');
    await run(ffmpeg, [...ffBase, '-ss', rounded((c.sourceIn ?? 0) / fps), ...inputArgs(asset.path), '-map', '0:a:0', '-vn', '-af', filter, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', out], { signal });
    buses[c.track === 'music' ? 'music' : 'voice'].push({ file: out, offset: Math.round(c.start * 48000 / fps) });
  }
  const samples = Math.round(length * 48000 / fps);
  async function mixBus(items, name) {
    let groupIndex = 0;
    while (items.length) {
      const batch = items.splice(0, 16);
      const split = batch.map((item, i) => `[${i}:a]adelay=${item.offset}S:all=1[a${i}]`);
      split.push(batch.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${batch.length}:normalize=0,apad,atrim=end_sample=${samples}[bus]`);
      const out = path.join(work, `${name}-${groupIndex++}.wav`);
      await run(ffmpeg, [...ffBase, ...batch.flatMap(item => inputArgs(item.file)), '-filter_complex', split.join(';'), '-map', '[bus]', '-c:a', 'pcm_f32le', out], { signal });
      if (!items.length) return out;
      items.push({ file: out, offset: 0 });
    }
    return null;
  }
  const voice = await mixBus(buses.voice, 'voice');
  const music = await mixBus(buses.music, 'music');
  const mix = path.join(work, 'mix.wav');
  if (voice && music) {
    await run(ffmpeg, [...ffBase, ...inputArgs(voice), ...inputArgs(music), '-filter_complex', '[0:a]asplit[v][key];[1:a][key]sidechaincompress=threshold=0.025:ratio=8:attack=12:release=320[bed];[v][bed]amix=inputs=2:normalize=0,alimiter=limit=0.96:latency=1[out]', '-map', '[out]', '-c:a', 'pcm_s24le', mix], { signal });
  } else if (voice || music) {
    await run(ffmpeg, [...ffBase, ...inputArgs(voice || music), '-af', 'alimiter=limit=0.96:latency=1', '-c:a', 'pcm_s24le', mix], { signal });
  } else {
    await run(ffmpeg, [...ffBase, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-af', `atrim=end_sample=${samples}`, '-c:a', 'pcm_s24le', mix], { signal });
  }
  return mix;
}

export async function renderProject(project, { directory, output, preview = false, signal, onProgress = () => {} }) {
  if (!path.isAbsolute(output) || path.extname(output).toLowerCase() !== '.mp4') throw new Error('导出目标须为 MP4 的绝对路径');
  const { width, height, fps, clips, length } = validate(project);
  const profile = { width, height, fps };
  const ffmpeg = await requiredTool('ffmpeg');
  const melt = process.env.VIDEO_STUDIO_RENDER_ENGINE === 'ffmpeg' ? null : await mediaTool('melt');
  const media = new Map();
  for (const c of clips.filter(c => ['video', 'narration', 'music'].includes(c.track))) {
    const asset = project.assets.find(a => a.id === c.assetId);
    if (!asset?.path) throw new Error(`片段 ${c.id} 缺少素材`);
    if (!media.has(asset.id)) {
      const file = path.resolve(directory, asset.path);
      media.set(asset.id, { ...asset, ...await probeMedia(file, { signal }), path: file });
    }
    const info = media.get(asset.id);
    if (c.track === 'video' ? info.kind === 'audio' : !info.hasAudio) throw new Error(`素材与 ${c.track} 轨道不匹配`);
    if (info.kind !== 'image' && ((c.sourceIn ?? 0) + c.duration * (c.speed ?? 1)) / fps > info.duration + Math.max(0.075, 1 / fps)) throw new Error(`片段 ${c.id} 超出原素材时长`);
  }
  const spans = pictureSpans(clips, length);
  const srtPath = output.slice(0, -4) + '.srt';
  await mkdir(path.dirname(output), { recursive: true });
  const result = await scratch(path.dirname(output), async work => {
    for (const [i, span] of spans.entries()) {
      onProgress((i / spans.length) * 0.45);
      await renderSpan(span, media, profile, ffmpeg, path.join(work, `span-${i}.mp4`), signal);
    }
    onProgress(0.45);
    const picture = await assemblePicture(spans, work, profile, ffmpeg, melt, signal);
    onProgress(0.6);
    const mix = await renderMix(clips, media, work, fps, length, ffmpeg, signal);
    const text = clips.some(c => ['caption', 'graphic'].includes(c.track));
    if (text) await writeFile(path.join(work, 'layers.ass'), createAss(clips, profile));
    const srt = createSrt(clips, fps);
    await writeFile(path.join(work, 'captions.srt'), srt);
    const final = path.join(work, 'final.mp4');
    const encoding = text ? ['-vf', 'ass=layers.ass', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', preview ? 'ultrafast' : 'veryfast', '-crf', preview ? '22' : '18', '-threads', '2'] : ['-c:v', 'copy'];
    onProgress(0.76);
    await run(ffmpeg, [...ffBase, ...inputArgs(picture), ...inputArgs(mix), '-map', '0:v:0', '-map', '1:a:0', ...encoding, '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-movflags', '+faststart', '-t', rounded(length / fps), final], { cwd: work, signal });
    const info = await probeMedia(final, { signal });
    if (!info.hasAudio || info.width !== width || info.height !== height || Math.abs(info.duration - length / fps) > 1 / fps || (info.frames && info.frames !== length)) throw new Error('导出结果与工程的帧数或规格不符');
    const sha256 = await fileHash(final);
    signal?.throwIfAborted();
    // Callers publish this pair by revision only after this function returns.
    await rename(path.join(work, 'captions.srt'), srtPath);
    await rename(final, output);
    onProgress(1);
    return { videoPath: output, srtPath, sha256, duration: info.duration, frames: length, engine: melt ? 'mlt' : 'ffmpeg', revision: project.revision };
  });
  return result;
}
