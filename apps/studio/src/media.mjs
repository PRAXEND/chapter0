import {fileURLToPath} from 'node:url';
import {portraitLayout,portraitScript,portraitGraph,portraitEnding} from './presentation.mjs';
import {shakeFilter,newsTransition} from './news-effects.mjs';
import {activeStyleMusicCredit} from './style-audio.mjs';
import { stat, mkdir, writeFile, rename, link, unlink, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createAss, createSrt } from './text-tracks.mjs';
import { framingFilter, transitionEnvelope } from './framing.mjs';
import { viewportRect,compositionOrder } from './viewport.mjs';
import { ffBase, inputArgs, mediaSlot, mediaTool, requiredTool, run, scratch } from './media-runtime.mjs';

export { mediaTool };

export async function mediaCapabilities() {
  const [ffmpeg, ffprobe, melt] = await Promise.all(['ffmpeg', 'ffprobe', 'melt'].map(mediaTool));
  return { ffmpeg, ffprobe, melt, ready: Boolean(ffmpeg && ffprobe), engine: melt && process.env.VIDEO_STUDIO_RENDER_ENGINE !== 'ffmpeg' ? 'mlt' : 'ffmpeg' };
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
  const [sarX, sarY] = (video?.sample_aspect_ratio ?? '').split(':').map(Number);
  const pixelAspect = sarX > 0 && sarY > 0 ? (rotation === 90 ? sarY/sarX : sarX/sarY) : 1;
  const [numerator, denominator] = (video?.avg_frame_rate ?? '').split('/').map(Number);
  const frameRate = video?.r_frame_rate === video?.avg_frame_rate && denominator > 0 ? numerator / denominator : undefined;
  return { kind: image ? 'image' : video ? 'video' : 'audio', duration, width, height, ...(pixelAspect !== 1 && {pixelAspect}), hasAudio: Boolean(audio), videoCodec: video?.codec_name, audioCodec: audio?.codec_name, frames: Number(video?.nb_frames) || undefined, sampleRate: Number(audio?.sample_rate) || undefined, frameRate };
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
    // Seeking to zero on a single-frame JPEG can advance the demuxer to EOF.
    const seek=seconds>0?['-ss',String(seconds)]:[];
    await run(await requiredTool('ffmpeg'), [...ffBase, ...seek, ...inputArgs(path.resolve(file)), '-map', '0:v:0', '-an', ...scale, '-frames:v', '1', '-update', '1', target], { signal });
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
    if (c.viewport != null) {
      if (c.track !== 'video') throw Error('只有视频轨道使用分屏窗口。');
      viewportRect(c.viewport, project.profile);
    }
    if (!['video', 'narration', 'music', 'caption', 'graphic'].includes(c.track) || !Number.isInteger(c.start) || c.start < 0 || !Number.isInteger(c.duration) || c.duration < 1) throw new Error('时间线包含无效片段');
    if (!Number.isInteger(c.sourceIn ?? 0) || (c.sourceIn ?? 0) < 0 || !Number.isFinite(c.speed ?? 1) || (c.speed ?? 1) < 0.125 || (c.speed ?? 1) > 8 || !Number.isFinite(c.gain ?? 1) || (c.gain ?? 1) < 0 || (c.gain ?? 1) > 16) throw new Error('片段源区间、速率或音量无效');
  }
  const length = clips.reduce((end, c) => Math.max(end, c.start + c.duration), 0);
  if (!length) throw new Error('请先在时间线上加入素材');
  return { width, height, fps, clips, length };
}

function pictureSpans(clips, length, fromFrame, toFrame, profile) {
  const video = compositionOrder(clips.filter(c => c.track === 'video'));
  const cuts = new Set([0, length]);
  for (const c of video) {
    cuts.add(c.start); cuts.add(c.start + c.duration);
    const transitionFrames = transitionEnvelope(c).duration;
    if (transitionFrames) cuts.add(c.start + transitionFrames);
  }
  const positions = [...cuts].sort((a, b) => a - b);
  return positions.slice(0, -1).flatMap((origin, i) => {
    const start = Math.max(origin, fromFrame), end = Math.min(positions[i + 1], toFrame);
    if (end <= start) return [];
    const active = video.filter(c => c.start <= start && c.start + c.duration > start);
    // A fully opaque full-frame shot covers everything below it. Keep the
    // traditional two-shot transition path when the visible stack has no panes.
    const opaqueBase = active.findLastIndex(c => {
      const rect = viewportRect(c.viewport, profile);
      return rect.width === profile.width && rect.height === profile.height && start - c.start >= transitionEnvelope(c).duration;
    });
    const layers = active.slice(Math.max(0, opaqueBase));
    return [{ origin, start, duration: end - start, top: active.at(-1), under: active.at(-2),
      ...(layers.some(c => c.viewport) && { layers }) }];
  });
}

const rounded = n => String(Number(n.toFixed(7)));
const videoEncode = ['-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '16', '-threads', '2'];

function buildVisualInput(clip, span, asset, profile, index) {
  const { width, height, fps } = profile;
  const rate = clip.speed ?? 1;
  // Retimed and variable-rate footage must keep the same fps sampling phase as the full span.
  const anchor = asset.kind === 'image' || (rate === 1 && asset.frameRate === fps) ? span.start : clip.start;
  const skip = span.start - anchor;
  const source = ((clip.sourceIn ?? 0) + (anchor - clip.start) * rate) / fps;
  const args = asset.kind === 'image' ? ['-loop', '1', '-framerate', String(fps), ...inputArgs(asset.path)] : ['-ss', rounded(source), ...inputArgs(asset.path)];
  const cover = clip.fit === 'cover';
  const size = cover ? `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${width}:${height}` : `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
  const square = clip.viewport && asset.pixelAspect && asset.pixelAspect !== 1 ?
    `scale=${Math.max(2, 2 * Math.round(asset.width * asset.pixelAspect / 2))}:${asset.height},setsar=1,` : '';
  const view = clip.framing ? framingFilter(clip, asset, profile, span.start) : square + size;
  const fx=shakeFilter(clip,span.start,profile);
  const chain = `[${index}:v:0]setpts=(PTS-STARTPTS)/${rounded(rate)},fps=${fps},tpad=stop_mode=clone:stop=-1,trim=start_frame=${skip}:end_frame=${skip + span.duration},setpts=N/(${fps}*TB),${view}${fx?','+fx:''},setsar=1,format=yuv420p[v${index}]`;
  return { args, chain };
}

function blendFilter(clip, start) {
  const fade = transitionEnvelope(clip);
  const weight = `min(1,(N+${start-clip.start+fade.offset})/${fade.total})`;
  const native=newsTransition(clip.transition.type,`clip((N-1+${start-clip.start+fade.offset})/${Math.max(1,fade.total-1)},0,1)`);
  if(native)return native;
  const expression = clip.transition.type === 'wipe-right' ? `if(lt(X,W*(${weight})),A,B)` : `A*(${weight})+B*(1-${weight})`;
  return `blend=all_expr='${expression}':shortest=1`;
}

function composePanes(span, media, profile) {
  const args = [], chains = [];
  let picture = null;
  for (const [i, clip] of span.layers.entries()) {
    const rect = viewportRect(clip.viewport, profile);
    const full = rect.width === profile.width && rect.height === profile.height;
    const fade = span.start - clip.start < transitionEnvelope(clip).duration;
    const {args: input, chain} = buildVisualInput(clip, span, media.get(clip.assetId), {...profile,...rect}, i);
    args.push(...input);
    chains.push(chain);
    let source = 'v' + i;
    if (!picture && (fade || !full)) {
      chains.push(`color=c=black:s=${profile.width}x${profile.height}:r=${profile.fps},format=yuv420p[canvas]`);
      picture = 'canvas';
    }
    if (fade) {
      let under = picture;
      if (!full) {
        chains.push(`[${picture}]split[back${i}][part${i}]`,
          `[part${i}]crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}[under${i}]`);
        picture = 'back' + i;
        under = 'under' + i;
      }
      chains.push(`[${source}][${under}]${blendFilter(clip,span.start)}[fade${i}]`);
      source = 'fade' + i;
    }
    if (full) picture = source;
    else {
      chains.push(`[${picture}][${source}]overlay=x=${rect.x}:y=${rect.y}:shortest=1[stage${i}]`);
      picture = 'stage' + i;
    }
  }
  return [...args, '-filter_complex', chains.join(';'), '-map', `[${picture}]`];
}

async function renderSpan(span, media, profile, ffmpeg, target, signal) {
  const { width, height, fps } = profile;
  const lavfi = ['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}`];
  const out = ['-frames:v', String(span.duration), ...videoEncode, target];
  if (span.layers) return run(ffmpeg, [...ffBase, ...composePanes(span, media, profile), ...out], {signal});
  if (!span.top) return run(ffmpeg, [...ffBase, ...lavfi, ...out], { signal });
  const top = span.top;
  const fade = transitionEnvelope(top);
  const elapsed = span.start - top.start;
  const blend = elapsed < fade.duration;
  const upper = buildVisualInput(top, span, media.get(top.assetId), profile, 0);
  let args = upper.args;
  let filter = upper.chain;
  let outputLabel = 'v0';
  if (blend) {
    const lower = span.under ? buildVisualInput(span.under, span, media.get(span.under.assetId), profile, 1) : { args: lavfi, chain: '[1:v]format=yuv420p[v1]' };
    args = [...args, ...lower.args];
    // The timeline determines opacity even when another cut divides this transition.
    filter += `;${lower.chain};[v0][v1]${blendFilter(top,span.start)}[composed]`;
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

async function renderMix(clips, media, work, fps, mixStart, mixEnd, ffmpeg, signal, ending) {
  const audioClips = clips.filter(c => ['video', 'narration', 'music'].includes(c.track) && media.get(c.assetId)?.hasAudio && (c.gain ?? 1) > 0 && !c.muted);
  const buses = { voice: [], music: [], fixed: [] };
  const sampleAt = frame => Math.round(frame * 48000 / fps);
  for (const [index, c] of audioClips.entries()) {
    const first = Math.max(c.start, mixStart), end = Math.min(c.start + c.duration, mixEnd);
    if (end <= first) continue;
    const asset = media.get(c.assetId);
    const rate = c.speed ?? 1;
    const skip = sampleAt(first) - sampleAt(c.start);
    const count = sampleAt(end) - sampleAt(first);
    // Keep atempo's phase for retimed dialogue. Ordinary audio can seek directly.
    const seek = rate === 1 ? skip : 0;
    const source = (c.sourceIn ?? 0) / fps + seek / 48000;
    const duration = rate * c.duration / fps - seek / 48000;
    const out = path.join(work, `sound-${index}.wav`);
    const filter = [`atrim=duration=${rounded(duration)}`, 'asetpts=PTS-STARTPTS', 'aresample=48000', ...tempo(rate), `volume=${rounded(c.gain ?? 1)}`, 'apad', `atrim=start_sample=${skip - seek}:end_sample=${skip - seek + count}`, 'asetpts=PTS-STARTPTS'].join(',');
    // Fade only background music, on the project clock and before the final black hold.
    const bed=c.track==='music'&&c.role!=='sfx';
    const gainEnvelope=ending&&bed?',volume='+ "'clip(("+ending.black+"/"+fps+"-t-"+first+"/"+fps+")/("+Math.max(1,ending.black-ending.musicFade)+"/"+fps+"),0,1)':eval=frame" : '';
    await run(ffmpeg, [...ffBase, '-ss', rounded(source), ...inputArgs(asset.path), '-map', '0:a:0', '-vn', '-af', filter+gainEnvelope, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', out], { signal });
    const bus = c.track === 'music' ? (c.ducking === false ? 'fixed' : 'music') : 'voice';
    buses[bus].push({ file: out, offset: sampleAt(first) - sampleAt(mixStart) });
  }
  const samples = sampleAt(mixEnd) - sampleAt(mixStart);
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
  const fixed = await mixBus(buses.fixed, 'fixed');
  const mix = path.join(work, 'mix.wav');
  const inputs = [voice,music,fixed].filter(Boolean);
  if (inputs.length) {
    const filters=[], streams=inputs.map((_,i)=>'['+i+':a]');
    if (voice && music) {
      filters.push('[0:a]asplit[v][key]','[1:a][key]sidechaincompress=threshold=0.025:ratio=8:attack=12:release=320[bed]');
      streams.splice(0,2,'[v]','[bed]');
    }
    const merge=streams.length>1?'amix=inputs='+streams.length+':normalize=0,':'';
    filters.push(streams.join('')+merge+'alimiter=limit=0.96:latency=1[out]');
    await run(ffmpeg,[...ffBase,...inputs.flatMap(file=>inputArgs(file)),'-filter_complex',filters.join(';'),
      '-map','[out]','-c:a','pcm_s24le',mix],{signal});
  } else {
    await run(ffmpeg, [...ffBase, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-af', `atrim=end_sample=${samples}`, '-c:a', 'pcm_s24le', mix], { signal });
  }
  return mix;
}

export function renderProject(project, options) {
  return mediaSlot(() => render(project, options), options.signal);
}

async function render(project, { directory, output, preview = false, window, signal, onProgress = () => {} }) {
  if (!path.isAbsolute(output) || path.extname(output).toLowerCase() !== '.mp4') throw new Error('导出目标须为 MP4 的绝对路径');
  const { width, height, fps, clips, length: projectLength } = validate(project);
  const { fromFrame, toFrame } = window ?? { fromFrame: 0, toFrame: projectLength };
  if (!Number.isSafeInteger(fromFrame) || !Number.isSafeInteger(toFrame) || fromFrame < 0 || toFrame <= fromFrame || toFrame > projectLength) throw new Error('预览区间须为工程内的非空帧区间');
  const length = toFrame - fromFrame;
  const layout=portraitLayout(project);
  const profile = {width,height:layout?.contentHeight||height,fps};
  const spans = pictureSpans(clips, projectLength, fromFrame, toFrame, profile);
  // Start the 320 ms ducking release before the sample and keep limiter lookahead at its end.
  const mixStart = Math.max(0, fromFrame - 3 * fps), mixEnd = Math.min(projectLength, toFrame + fps);
  const audible = clips.filter(c => ['video', 'narration', 'music'].includes(c.track) && c.start < mixEnd && c.start + c.duration > mixStart && (c.gain ?? 1) > 0 && !c.muted);
  const relevant = window ? new Set([...audible, ...spans.flatMap(s => s.layers || [s.top, s.under]).filter(Boolean)]) : clips.filter(c => ['video', 'narration', 'music'].includes(c.track));
  const ffmpeg = await requiredTool('ffmpeg');
  const melt = process.env.VIDEO_STUDIO_RENDER_ENGINE === 'ffmpeg' ? null : await mediaTool('melt');
  const media = new Map();
  for (const c of relevant) {
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
    const mix = await renderMix(audible, media, work, fps, mixStart, mixEnd, ffmpeg, signal, layout && portraitEnding(projectLength,fps));
    const layers = clips.filter(c => ['caption', 'graphic'].includes(c.track) && c.start < toFrame && c.start + c.duration > fromFrame);
    const stageLayers=layout||project.settings?.captionDisplay==='sidecar'?layers.filter(c=>c.track!=='caption'):layers;
    if (layout) {
      await symlink(fileURLToPath(new URL('./fonts',import.meta.url)),path.join(work,'fonts'));
      await writeFile(path.join(work,'portrait.ass'),portraitScript(project,layout,fromFrame,toFrame,projectLength));
    }
    let motion;
    if (stageLayers.some(c => c.track === 'graphic' && c.motion)) {
      const {prepareMotionOverlay} = await import('./motion-render.mjs');
      motion = await prepareMotionOverlay(stageLayers, profile, {work, directory, projectId: project.id, fromFrame, toFrame, signal});
    } else if (stageLayers.length) await writeFile(path.join(work, 'layers.ass'), createAss(stageLayers, profile));
    const srt = createSrt(layers, fps, { fromFrame, toFrame });
    await writeFile(path.join(work, 'captions.srt'), srt);
    const final = path.join(work, 'final.mp4');
    const overlay = fromFrame ? `settb=1/${fps},setpts=N+${fromFrame},ass=layers.ass,setpts=N` : 'ass=layers.ass';
    let map=motion?.map??'0:v:0';
    let filters=motion?['-filter_complex',motion.filter]:stageLayers.length?['-vf',overlay]:[];
    if(layout){
      const base=motion?.map || (stageLayers.length?'[vstage]':'[0:v]');
      const before=motion?.filter || (stageLayers.length?'[0:v]'+overlay+'[vstage]':'');
      filters=['-filter_complex',[before,portraitGraph(project,layout,base,fromFrame,projectLength)].filter(Boolean).join(';')];
      map='[outportrait]';
    }
    const encoding = layout || layers.length ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', preview ? 'ultrafast' : 'veryfast', '-crf', preview ? '22' : '18', '-threads', '2'] : ['-c:v', 'copy'];
    const sampleAt = frame => Math.round(frame * 48000 / fps);
    const mixWindow = window ? ['-af', `atrim=start_sample=${sampleAt(fromFrame) - sampleAt(mixStart)}:end_sample=${sampleAt(toFrame) - sampleAt(mixStart)},asetpts=PTS-STARTPTS`] : [];
    onProgress(0.76);
    const trackCredit=activeStyleMusicCredit(project);
    await run(ffmpeg, [...ffBase, ...inputArgs(picture), ...inputArgs(mix), ...(motion?.inputs ?? []), ...filters, '-map', map, '-map', '1:a:0', ...encoding, ...mixWindow, ...(trackCredit?['-metadata','comment='+trackCredit.line]:[]), '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-movflags', '+faststart', '-t', rounded(length / fps), final], { cwd: work, signal });
    const info = await probeMedia(final, { signal });
    if (!info.hasAudio || info.width !== width || info.height !== height || Math.abs(info.duration - length / fps) > 1 / fps || (info.frames && info.frames !== length)) throw new Error('导出结果与工程的帧数或规格不符');
    const sha256 = await fileHash(final);
    signal?.throwIfAborted();
    // Keep any old SRT available for rollback if replacing its partner fails.
    const backup = path.join(work, 'previous.srt');
    let previous = false;
    try { await link(srtPath, backup); previous = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(path.join(work, 'captions.srt'), srtPath);
    try { await rename(final, output); }
    catch (error) {
      if (previous) await rename(backup, srtPath); else await unlink(srtPath);
      throw error;
    }
    onProgress(1);
    return { videoPath: output, srtPath, sha256, duration: info.duration, frames: length, engine: melt ? 'mlt' : 'ffmpeg', revision: project.revision, ...(motion && {motion: motion.info}), ...(window && { window: { fromFrame, toFrame } }) };
  });
  return result;
}
