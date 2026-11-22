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

export function motionPolicy(style, project, message = '') {
  if (
    !style?.rules?.some((r) => r.id === 'video-first') &&
    !style?.executionPlan?.sourceRules?.some((r) => r.id === 'video-first')
  )
    return null;
  const clauses=[project.brief,message].filter(Boolean).join('。').split(/[，。；;，\n]/u);
  const only=clauses.some(clause=>{
    if(/(?:不要|不得|不能|避免|别)(?:全片|全程)?(?:只|仅)|(?:don't|not|avoid)\s+(?:only|just)/i.test(clause))return false;
    if(/(?:不使用|不要|禁用)(?:任何)?(?:动态素材|运动素材|录像|视频素材)/u.test(clause))return true;
    if(/(?:或|和|及|加上|以及)\s*(?:现场|任务)?(?:录像|视频|动态素材)|(?:videos?|footage)\s+(?:or|and)/i.test(clause))return false;
    return /(?:全片|全程|所有画面)(?:均|都)?(?:为|是|只用|仅用|使用)(?:[^，。；]{0,24})(?:照片|图片|原照|静图)|(?:只(?:能|许|可)?(?:用|使用|采用)|仅(?:限|用|使用|能用))(?:[^，。；]{0,26})(?:照片|图片|相片|原照|静图)|(?:use\s+only|only\s+use)\s+[^.,;]{0,30}(?:photos|photographs|images)|(?:photos|photographs|images)\s+only/i.test(clause);
  });
  return only ? 'images-only' : 'video-first';
}

export function motionCoverage(p, sourceFrames, policy, queries = [], reason = '') {
  if (!policy) return null;
  const fps = p.profile.fps,
    clips = p.timeline.clips.filter((c) => c.track === 'video' && c.enabled !== false && !c.hidden),
    assets = new Map(p.assets.map((a) => [a.id, a]));
  const windows = [],
    proven = new Set();
  for (const c of clips) {
    const a = assets.get(c.assetId),
      b = p.storyboard?.find(
        (s, i) =>
          s.assetId === c.assetId && ((s.videoClipId || 'scene-' + i + '-video') === c.id || s.start === c.start)
      ),
      e = b?.motionEvidence;
    if (a?.kind !== 'video' || !e || typeof e.observation !== 'string' || e.observation.trim().length < 4)
      continue;
    const begin = (c.sourceIn || 0) / fps,
      end = begin + (c.duration * (c.speed || 1)) / fps;
    if (
      !Number.isFinite(e.fromSeconds) ||
      !Number.isFinite(e.toSeconds) ||
      e.toSeconds - e.fromSeconds < 0.18 ||
      e.fromSeconds < begin - 0.51 / fps ||
      e.toSeconds >= end + 0.51 / fps
    )
      continue;
    const witness = (t) =>
      sourceFrames.find(
        (f) =>
          f.source === 'asset' &&
          f.assetId === a.id &&
          f.assetHash === a.sha256 &&
          Math.abs(f.seconds - t) <= 0.51 / fps
      );
    const from = witness(e.fromSeconds),
      to = witness(e.toSeconds);
    if (!from || !to || from.sha256 === to.sha256) continue;
    windows.push({
      assetId: a.id,
      assetHash: a.sha256,
      clipId: c.id,
      timelineFrom: c.start,
      timelineFrames: c.duration,
      sourceStart: from.seconds,
      sourceEnd: to.seconds,
      fromHash: from.sha256,
      toHash: to.sha256,
      observation: e.observation.slice(0, 360),
    });
    proven.add(c.id);
  }
  let videoFrames = 0,
    stillFrames = 0,
    witnessedFrames = 0;
  const edges = [...new Set(clips.flatMap((c) => [c.start, c.start + c.duration]))].sort((a, b) => a - b);
  for (let i = 0; i < edges.length - 1; i++) {
    const c = clips.findLast((c) => c.start <= edges[i] && c.start + c.duration > edges[i]);
    if (!c) continue;
    const n = edges[i + 1] - edges[i];
    if (assets.get(c.assetId)?.kind === 'video') videoFrames += n;
    else stillFrames += n;
    if (proven.has(c.id)) witnessedFrames += n;
  }
  const totalFrames = videoFrames + stillFrames;
  let gap = '';
  if (policy === 'video-first' && witnessedFrames * 2 <= totalFrames) {
    const searched = queries.some((q) => q.kind === 'video');
    gap =
      '所选风格要求由实际运动画面推动讲解。目前从成对原片帧核对到动作变化的录像镜头占 ' +
      (witnessedFrames / fps).toFixed(1) +
      ' / ' +
      (totalFrames / fps).toFixed(1) +
      ' 秒。' +
      (reason?.trim()?.slice(0, 420) ||
        (searched
          ? '已查询录像，仍缺能直接支持本期讲解的源窗口。'
          : '尚缺足够的实拍、实验、录屏或标明身份的仿真窗口。'));
  }
  return { policy, queries, windows, videoFrames, stillFrames, witnessedFrames, totalFrames, gap };
}

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

export function currentReviewWindows(p) {
  const active = p.timeline.clips.filter((c) => c.enabled !== false && !c.hidden);
  const pictures = active.filter((c) => c.track === 'video'),
    assets = new Map(p.assets.map((a) => [a.id, a]));
  const anchors = new Map(),
    slots = [];
  for (const c of active.filter((c) => c.track === 'graphic' && c.evidenceAnchor)) {
    const e = c.evidenceAnchor,
      asset = assets.get(e.assetId);
    if (!stages.includes(e.stage) || asset?.sha256 !== e.sha256) continue;
    for (const pic of pictures.filter((pic) => pic.assetId === e.assetId)) {
      const start = Math.max(pic.start, c.start),
        end = Math.min(pic.start + pic.duration, c.start + c.duration);
      if (start >= end) continue;
      const key = e.stepId || c.id,
        old = anchors.get(key);
      if (!old || end - start > old.end - old.atFrame)
        anchors.set(key, { stage: e.stage, atFrame: start, end, picture: pic.id });
    }
  }
  slots.push(...anchors.values());
  for (const [i, beat] of (p.storyboard || []).entries()) {
    const pic = pictures.find(
      (c) => c.id === (beat.videoClipId || 'scene-' + i + '-video') && c.assetId === beat.assetId
    );
    if (!pic) continue;
    const a = assets.get(pic.assetId),
      local = [];
    for (const s of beat.visualSteps || []) {
      if (slots.some((w) => w.stage === s.stage && w.picture === pic.id)) continue;
      if (s.assetHash && s.assetHash !== a?.sha256) continue;
      const at =
        a?.kind === 'video' && Number.isFinite(s.sourceFrame)
          ? pic.start + Math.round((s.sourceFrame - (pic.sourceIn || 0)) / (pic.speed || 1))
          : pic.start + Math.round(((s.atFrame - beat.start) * pic.duration) / Math.max(1, beat.duration));
      if (at >= pic.start && at < pic.start + pic.duration)
        local.push({ stage: s.stage, atFrame: at, picture: pic.id });
    }
    for (const [j, s] of local.entries())
      slots.push({ ...s, end: local[j + 1]?.atFrame ?? pic.start + pic.duration });
  }
  return { slots: slots.filter((w) => w.end > w.atFrame), pictures };
}

export async function prepareVisuals(deps, p, stage, extra, signal, policy) {
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
    const available = p.assets.filter((a) => a.source?.role !== 'hold');
    for (const a of available.filter((a) => a.kind === 'image').slice(0, 6))
      requests.push({ source: 'asset', id: a.id, seconds: 0 });
    for (const a of available.filter((a) => a.kind === 'video' && policy !== 'images-only').slice(0, 3)) {
      const fps = p.profile.fps,
        last = Math.max(0, Math.floor(a.duration * fps) - 1);
      const starts =
        policy === 'video-first'
          ? [0.06, 0.45, 0.76].map((x) => Math.floor(last * x))
          : [Math.min(last, Math.round(0.5 * fps))];
      for (const frame of starts) {
        requests.push({ source: 'asset', id: a.id, seconds: frame / fps });
        if (policy === 'video-first')
          requests.push({
            source: 'asset',
            id: a.id,
            seconds: Math.min(last, frame + Math.max(1, Math.min(fps, Math.floor(last * 0.08)))) / fps,
          });
      }
    }
  } else if (stage === 'verify') {
    const { slots: all, pictures } = currentReviewWindows(p);
    const mandatory = stages.map((stage) => all.find((s) => s.stage === stage)).filter(Boolean);
    const checks = [...new Set([...mandatory, ...all])].slice(0, 8);
    for (const s of checks)
      requests.push({
        source: 'timeline',
        frame: Math.min(s.end - 1, s.atFrame + Math.max(1, Math.round(p.profile.fps * 0.45))),
        stage: s.stage,
      });
    for (const b of pictures.filter((b) => b.duration >= p.profile.fps * 6).slice(0, 3)) {
      const mid = b.start + Math.floor(b.duration * 0.58),
        step =
          all.find((s) => s.picture === b.id && s.atFrame <= mid && s.end > mid) ||
          all.find((s) => s.picture === b.id);
      if (step) requests.push({ source: 'timeline', frame: mid, stage: step.stage });
    }
    for (const stage of stages)
      if (!all.some((s) => s.stage === stage))
        gaps.push(stage + '：当前剪辑中找不到这个阶段仍在播放的绑定镜头或图层。');
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
