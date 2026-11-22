import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export const stages = ['problem', 'detail', 'mechanism', 'verification'];
export function usesVisualStages(style) {
  if (style?.id === 'henry-technical-explainer' && Number(style.version) >= 8) return true;
  const plan = style?.executionPlan;
  return (
    plan?.template === 'step-reveal' &&
    stages.every((stage) => plan.stages?.[stage]) &&
    Boolean(style?.baseline || style?.visualGrammar || style?.components?.length || plan.referenceSamples?.length)
  );
}
export const shotFingerprint = (p) =>
  createHash('sha256')
    .update(JSON.stringify([p.profile, p.timeline.clips]))
    .digest('hex');
const signature = (buffer) => createHash('sha256').update(buffer).digest('hex');

export function checkVisualPlan(beats, project, frames) {
  if (!Array.isArray(beats) || !beats.length) throw Error('请提交本片的真实分镜。');
  const seen = [];
  for (const beat of beats) {
    const asset = project.assets.find((a) => a.id === beat.assetId);
    if (!asset) throw Error('技术科普的画面尚未登记。');
    const steps = beat.visualSteps || [];
    if (!Array.isArray(steps) || steps.length > 6) throw Error('每个镜头至多六个视觉落点。');
    let previous = -1;
    for (const step of steps) {
      if (
        !stages.includes(step.stage) ||
        !step.label?.trim() ||
        !step.observation?.trim() ||
        step.observation.trim().length < 4 ||
        !Number.isFinite(step.atSeconds) ||
        step.atSeconds < 0 ||
        step.atSeconds <= previous
      )
        throw Error('请按时间列出阶段、可观察到的具体事实和简短标签，勿将静态照片表述成动作实拍。');
      previous = step.atSeconds;
      const region = step.region;
      if (
        (['detail', 'mechanism'].includes(step.stage) || region) &&
        (!region ||
          !['x', 'y', 'width', 'height'].every((k) => Number.isFinite(region[k])) ||
          region.x < 0 ||
          region.y < 0 ||
          region.width <= 0 ||
          region.height <= 0 ||
          region.x + region.width > 1.001 ||
          region.y + region.height > 1.001)
      )
        throw Error('细节与机制须标出原片可见证据区域，使用左上角 x/y 和宽高 0–1。');
      if (project.settings?.shareFrames === true) {
        const playing = Number(beat.sourceStart || 0) + step.atSeconds;
        const sourceSeconds = asset.kind === 'image' ? 0 : Number(step.sourceSeconds ?? playing);
        if (asset.kind === 'video' && Math.abs(playing - sourceSeconds) > 0.51 / project.profile.fps)
          throw Error('核验的源帧与该阶段实际播放时刻不同。请把源区间或阶段时刻对齐后再提交。');
        if (
          !frames.some(
            (f) =>
              f.source === 'asset' &&
              f.assetId === asset.id &&
              f.assetHash === asset.sha256 &&
              Math.abs(f.seconds - sourceSeconds) <= 0.5 / project.profile.fps
          )
        )
          throw Error(
            '此阶段未收到这个素材源秒的真实图像附件，请用 studio_frame 申请源帧；工作台会在下一轮附上该图。'
          );
      }
      seen.push(step.stage);
    }
  }
  let at = 0;
  for (const stage of seen) if (stage === stages[at]) at++;
  if (at !== stages.length)
    throw Error(
      '技术科普需要让观众依次看到问题、局部细节、机制、回到原片验证；补齐连续四个阶段，并说明每处画面证据。'
    );
}

export function visualReceipt(label, frame, data) {
  return {
    label,
    frame: { ...frame, sha256: signature(data) },
    url: 'data:image/jpeg;base64,' + data.toString('base64'),
  };
}

export async function readVisualFrame(deps, project, requested, signal) {
  if (project.settings?.shareFrames !== true) throw Error('本工程未开启向 Codex 发送参考帧。');
  const seconds = Number(requested.seconds ?? 0);
  if (!Number.isFinite(seconds) || seconds < 0) throw Error('帧时间无效。');
  let file,
    at = seconds,
    description,
    properties;
  const cache = (await deps.store.paths(project.id)).cache;
  await mkdir(cache, { recursive: true });
  if (requested.source === 'asset') {
    const asset = project.assets.find((a) => a.id === requested.id);
    if (
      !asset ||
      !['image', 'video'].includes(asset.kind) ||
      (asset.kind === 'video' && seconds >= asset.duration)
    )
      throw Error('所选视觉素材帧超出范围。');
    if (asset.kind === 'image') at = 0;
    file = asset.path;
    description = '本期原素材 ' + asset.id + ' 源秒 ' + at;
    properties = { source: 'asset', assetId: asset.id, assetHash: asset.sha256, seconds: at, kind: asset.kind };
  } else if (requested.source === 'style') {
    const s = await deps.styleLibrary.get(project.style.id, project.style.version);
    const ref =
      !requested.id || requested.id === 'baseline' ? s.baseline : s.references?.find((x) => x.id === requested.id);
    if (!ref || ref.available === false) throw Error('未找到可读的风格参考片。');
    const verified =
      ref.available && ref.path ? ref : await deps.styleLibrary.getReference(s.id, s.version, ref.id);
    if (!verified?.available || !verified.path || !['image', 'video'].includes(verified.kind))
      throw Error('此风格参考缺少已核对的本地视觉素材。');
    if (verified.kind === 'image') at = 0;
    file = verified.path;
    description = '风格基准 ' + verified.id + '，源秒 ' + at + '。只借鉴剪法，基准人物和事实不属于本期。';
    properties = { source: 'style', assetId: verified.id, assetHash: verified.sha256, seconds: at };
  } else if (requested.source === 'timeline') {
    const fps = project.profile.fps,
      frame = requested.frame ?? Math.floor(seconds * fps);
    const length = project.timeline.clips
      .filter((c) => !c.hidden && c.enabled !== false)
      .reduce((n, c) => Math.max(n, c.start + c.duration), 0);
    if (!Number.isInteger(frame) || frame < 0 || frame >= length) throw Error('所选时刻超过成片时长。');
    const result = await deps.drafts.open(project, Math.floor(frame / (fps * 6)) * fps * 6, signal);
    file = path.join(cache, 'drafts', result.name);
    at = (frame - result.fromFrame) / fps;
    description = '当前真实合成 ' + (requested.stage || '') + '，工程帧 ' + frame + '。';
    properties = {
      source: 'timeline',
      seconds: frame / fps,
      frame,
      stage: requested.stage,
      revision: project.revision,
    };
  } else throw Error('未知画面来源。');
  const dir = await mkdtemp(path.join(cache, 'evidence-'));
  try {
    const out = path.join(dir, 'frame.jpg');
    await deps.media.frameAt(file, at, out, { signal, maxWidth: 640 });
    const data = await readFile(out);
    if (data.length > 900000 || data.length < 1) throw Error('参考图尺寸无法直接发送。');
    signal?.throwIfAborted();
    return visualReceipt(description, properties, data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function prepareVisuals(deps, p, stage, extra, signal) {
  const result = [],
    gaps = [];
  if (p.settings?.shareFrames !== true)
    return { result, gaps: ['本工程关闭图像分享；未向 Codex 提供参考、原片或合成帧。'] };
  const requests = [];
  if (stage === 'compose') {
    const s = await deps.styleLibrary.get(p.style.id, p.style.version);
    const b = s.baseline;
    if (b) {
      const duration = Number(b.duration) || 60;
      const moments = s.executionPlan?.referenceSamples;
      const times =
        Array.isArray(moments) && moments.some((m) => Number.isFinite(m.seconds))
          ? moments
              .map((m) => m.seconds)
              .filter(Number.isFinite)
              .slice(0, 5)
          : [
              Math.min(1, duration * 0.05),
              Math.min(10.5, duration * 0.24),
              Math.min(35.5, duration * 0.6),
              Math.max(0, duration * 0.93),
            ];
      for (const seconds of new Set(times)) requests.push({ source: 'style', id: b.id, seconds });
    } else gaps.push('基准片未登记。');
    for (const a of p.assets
      .filter((a) => ['video', 'image'].includes(a.kind) && a.source?.role !== 'hold')
      .slice(0, 6)) {
      const seconds = a.kind === 'image' ? 0 : Math.min(0.5, Math.max(0, a.duration - 1 / p.profile.fps));
      requests.push({ source: 'asset', id: a.id, seconds });
    }
  } else if (stage === 'verify') {
    const all = (p.storyboard || []).flatMap((b) =>
      (b.visualSteps || []).map((s, i, arr) => ({ ...s, end: arr[i + 1]?.atFrame ?? b.start + b.duration }))
    );
    const mandatory = stages.map((stage) => all.find((s) => s.stage === stage)).filter(Boolean);
    const checks = [...new Set([...mandatory, ...all])].slice(0, 8);
    for (const s of checks)
      requests.push({
        source: 'timeline',
        frame: Math.min(s.end - 1, s.atFrame + Math.max(1, Math.round(p.profile.fps * 0.45))),
        stage: s.stage,
      });
    for (const b of (p.storyboard || []).filter((b) => b.duration >= p.profile.fps * 6).slice(0, 3)) {
      const mid = b.start + Math.floor(b.duration * 0.58),
        step = b.visualSteps?.findLast((s) => s.atFrame <= mid);
      requests.push({ source: 'timeline', frame: mid, stage: step?.stage || 'hold' });
    }
    if (!all.length) gaps.push('当前时间线没有已绑定的阶段可回看。');
  }
  const used = new Set();
  for (const r of [...requests, ...(extra || []).slice(0, 12)]) {
    const key = JSON.stringify([r.source, r.id, r.frame ?? r.seconds]);
    if (used.has(key)) continue;
    used.add(key);
    try {
      result.push(await readVisualFrame(deps, p, r, signal));
    } catch (error) {
      signal?.throwIfAborted();
      gaps.push(
        (r.stage || r.id || r.source) +
          '：' +
          String(error.message)
            .split('\n')[0]
            .replace(/(?:file:\/\/)?\/(?:Users|private|Volumes)\/[^\s，。；]+/gu, '[本地参考]')
            .slice(0, 200)
      );
    }
  }
  return { result, gaps };
}
