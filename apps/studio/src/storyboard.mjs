import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const visual = (asset) => asset.kind === 'video' || asset.kind === 'image';
export const sceneIdentity = (p) =>
  digest([p.brief, p.script, p.mode, p.profile, p.settings, p.style, p.timeline.clips]);
function sentenceList(text) {
  const sentences = new Intl.Segmenter('zh', { granularity: 'sentence' });
  return String(text || '')
    .split(/\n+/)
    .flatMap((line) =>
      [...sentences.segment(line)].flatMap((s) => s.segment.trim().match(/[\s\S]{1,450}/gu) || [])
    )
    .filter(Boolean);
}
function readingSeconds(text) {
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7a3]/gu) || []).length;
  const words = (text.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7a3]/gu, ' ').match(/[\p{L}\p{N}]+/gu) || [])
    .length;
  return Math.max(2.5, cjk / 4.5 + words / 2.7);
}

export async function transcriptFor(deps, project, asset, signal) {
  const existing = project.transcript?.[asset.id];
  if (Array.isArray(existing) && existing.length) return existing;
  const { cache } = await deps.store.paths(project.id);
  const rows = await deps.audio.transcribe(asset.path, { directory: cache, signal });
  signal?.throwIfAborted();
  const transcript = rows.flatMap((row, i) => {
    const text = String(row.text || '').trim();
    const start = Math.max(0, Number(row.start));
    const end = Math.min(asset.duration, Number(row.end));
    return text && Number.isFinite(start) && Number.isFinite(end) && end > start
      ? [{ id: asset.id + '-s' + i, text, start, end }]
      : [];
  });
  if (!transcript.length) throw new Error('原片中未检测到可用语句，可导入清晰的同期声后重试。');
  const latest = await deps.store.get(project.id);
  await deps.store.setMeta(project.id, { transcript: { ...latest.transcript, [asset.id]: transcript } });
  return transcript;
}

function voiceMode(project) {
  return project.settings?.voiceMode || (project.mode === 'interview' ? 'original' : 'system');
}
const narrationInput = (p, key) => p.assets.find((a) => a.id === p.settings?.[key]);

async function recordedNarration(deps, project, text, signal) {
  const mode = voiceMode(project);
  const settings = project.settings || {};
  const reference = narrationInput(project, 'voiceReferenceAssetId');
  if (
    mode === 'clone' &&
    (!reference?.path || (!settings.voiceConsent && !settings.voiceConsented && !reference.source?.consent))
  ) {
    throw new Error('克隆配音需要在工程内登记获授权的参考录音并确认本人或权利人同意。');
  }
  const key = digest([
    mode,
    settings.voiceId,
    settings.systemVoice,
    reference?.sha256,
    settings.voiceReferenceText,
    text,
  ]);
  const previous = project.assets.find((a) => a.source?.narrationKey === key);
  if (previous) return previous;
  const cache = (await deps.store.paths(project.id)).cache;
  await mkdir(cache, { recursive: true });
  const scratch = await mkdtemp(path.join(cache, 'narration-'));
  try {
    const output = path.join(scratch, 'narration.wav');
    const generated = await deps.audio.synthesize(text, {
      mode,
      voice: settings.systemVoice,
      voiceId: settings.voiceId,
      referencePath: reference?.path,
      referenceText: settings.voiceReferenceText || '',
      consent: mode === 'clone',
      output,
      signal,
    });
    signal?.throwIfAborted();
    return await deps.store.addAsset(project.id, output, {
      role: 'narration',
      narrationKey: key,
      text,
      mode,
      voiceId: settings.voiceId || (reference?.id ?? settings.systemVoice ?? 'system'),
      referenceHash: reference?.sha256 || null,
      provider: 'local',
      model: generated?.model,
      generatedHash: generated?.sha256,
      measuredSeconds: generated?.duration,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function localScenes(deps, project, signal) {
  const assets = project.assets.filter((a) => visual(a) && a.source?.role !== 'hold');
  if (!assets.length) throw new Error('需要一段可用实拍或图片。请添加素材，或使用选题搜索补充真实来源。');
  let audioAsset;
  if (project.mode === 'interview') audioAsset = assets.find((a) => a.kind === 'video' && a.hasAudio !== false);
  if (voiceMode(project) === 'import') audioAsset = narrationInput(project, 'narrationAssetId');
  if (project.mode === 'interview' || voiceMode(project) === 'import') {
    if (!audioAsset) throw new Error('缺少选定的原声或导入旁白。');
    const rows = await transcriptFor(deps, project, audioAsset, signal);
    const keep = new Map();
    for (const row of rows) {
      const key = row.text.replace(/[\p{P}\s]/gu, '').toLowerCase();
      if (key) keep.set(key, row.id);
    }
    let selected =
      project.mode === 'interview'
        ? rows.filter((row) => keep.get(row.text.replace(/[\p{P}\s]/gu, '').toLowerCase()) === row.id)
        : rows;
    if (project.mode === 'interview' && Number(project.settings?.targetDuration) > 0) {
      let remaining = project.settings.targetDuration;
      selected = selected.filter((row, i) => {
        const length = row.end - row.start;
        if (i > 0 && length > remaining) return false;
        remaining -= length;
        return true;
      });
    }
    return selected.map((row, i) => ({
      assetId: project.mode === 'interview' ? audioAsset.id : assets[i % assets.length].id,
      sourceStart: project.mode === 'interview' ? row.start : 0,
      sourceEnd: project.mode === 'interview' ? row.end : undefined,
      utteranceId: row.id,
      narration: row.text,
    }));
  }
  if (project.mode === 'topic') {
    const sourced = assets.filter((a) => a.source?.statement);
    if (!sourced.length) throw new Error('尚无可核对的事实描述。请补充有出处的素材或使用 Codex 检索。');
    return sourced.slice(0, 12).map((a) => {
      const sentence = sentenceList(a.source.statement)[0] || '';
      const narration = sentence.length > 240 ? a.source.title || a.name : sentence;
      return { assetId: a.id, sourceStart: 0, narration, claimUrl: a.source.url };
    });
  }
  const sentences = sentenceList(project.script || project.brief);
  if (!sentences.length) throw new Error('请先填写脚本。');
  return sentences.map((narration, i) => ({ assetId: assets[i % assets.length].id, narration, sourceStart: 0 }));
}

async function holdFrame(deps, project, asset, seconds, signal) {
  const key = digest([asset.sha256, seconds]);
  const existing = (await deps.store.get(project.id)).assets.find((a) => a.source?.holdKey === key);
  if (existing) return existing;
  const cache = (await deps.store.paths(project.id)).cache;
  await mkdir(cache, { recursive: true });
  const scratch = await mkdtemp(path.join(cache, 'hold-'));
  try {
    const file = path.join(scratch, 'hold.jpg');
    await deps.media.frameAt(asset.path, seconds, file, { signal });
    signal?.throwIfAborted();
    return await deps.store.addAsset(project.id, file, {
      role: 'hold',
      holdKey: key,
      parentAssetId: asset.id,
      parentHash: asset.sha256,
      sourceSeconds: seconds,
      url: asset.source?.url || null,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function reviseLine(deps, project, clipId, text, signal) {
  const target = project.timeline.clips.find((c) => c.id === clipId && ['caption', 'narration'].includes(c.track));
  const words = String(text || '').trim();
  if (!target || !words || words.length > 650) throw new Error('选择一个字幕或旁白片段，并输入 1 到 650 字。');
  if (!['clone', 'system'].includes(voiceMode(project)))
    throw new Error('同期声或外部录音请从原句裁切；替换台词需选择可合成的声音。');
  const group = project.timeline.clips.filter((c) => c.start === target.start && c.duration === target.duration);
  const voice = group.find((c) => c.track === 'narration'),
    caption = group.find((c) => c.track === 'caption');
  if (!voice || !caption || voice.locked || caption.locked) throw new Error('该句需要可编辑的同段旁白与字幕。');
  const expected = sceneIdentity(project),
    audio = await recordedNarration(deps, project, words, signal);
  const frames = Math.max(1, Math.round(audio.duration * project.profile.fps));
  let speed = frames / target.duration;
  const changes = [];
  if (speed < 0.85 || speed > 1.18) {
    const delta = frames - target.duration,
      end = target.start + target.duration;
    const overlaps = project.timeline.clips.filter(
      (c) => c.start < end && c.start + c.duration > target.start && c.id !== voice.id && c.id !== caption.id
    );
    if (
      overlaps.some((c) => c.locked || c.start !== target.start || c.duration !== target.duration) ||
      project.timeline.clips.some((c) => c.start >= end && c.locked)
    )
      throw new Error('新台词时长会移动受保护或跨句片段，请缩短台词或先在时间线上调整空间。');
    for (const c of overlaps) {
      const source = project.assets.find((a) => a.id === c.assetId);
      if (
        source?.kind === 'video' &&
        c.track === 'video' &&
        (c.sourceIn || 0) + frames * (c.speed || 1) > Math.ceil(source.duration * project.profile.fps)
      ) {
        throw new Error('新台词超出这个镜头的可用源区间，请先延长画面或缩短台词。');
      }
      changes.push({ op: 'update', id: c.id, changes: { duration: frames } });
    }
    for (const c of project.timeline.clips.filter((c) => c.start >= end))
      changes.push({ op: 'update', id: c.id, changes: { start: c.start + delta } });
    speed = 1;
  }
  const duration = speed === 1 ? frames : target.duration;
  changes.push({ op: 'update', id: voice.id, changes: { assetId: audio.id, sourceIn: 0, speed, duration } });
  changes.push({ op: 'update', id: caption.id, changes: { text: words, duration } });
  signal?.throwIfAborted();
  const latest = await deps.store.get(project.id);
  if (sceneIdentity(latest) !== expected) throw new Error('合成期间工程已更新，请对照当前版本重试。');
  return deps.store.apply(project.id, latest.revision, changes, 'codex');
}

export async function applyScenes(
  deps,
  project,
  beats,
  { signal, observed = new Set(), observedText = new Map(), onEvent } = {}
) {
  if (!Array.isArray(beats) || beats.length === 0 || beats.length > 400) throw new Error('分镜应含 1 到 400 段。');
  if (project.timeline.clips.some((c) => c.locked)) throw new Error('工程含锁定片段，请使用局部修改。');
  const expected = sceneIdentity(project);
  const mode = voiceMode(project);
  const fps = project.profile.fps;
  const clips = [],
    notes = [],
    board = [],
    facts = [];
  const make = (track, index, extra) => ({
    id: 'scene-' + index + '-' + track,
    track,
    sourceIn: 0,
    gain: 1,
    speed: 1,
    ...extra,
  });
  const imported = mode === 'import' ? narrationInput(project, 'narrationAssetId') : null;
  const voiceRows = imported ? await transcriptFor(deps, project, imported, signal) : null;
  if (
    mode === 'import' &&
    project.mode !== 'interview' &&
    (!voiceRows || beats.length !== voiceRows.length || beats.some((b, i) => b.utteranceId !== voiceRows[i].id))
  ) {
    throw new Error('导入的完整旁白须按原顺序覆盖所有转录语句，保留录音中的停顿。');
  }
  const style = project.style?.id ? await deps.styleLibrary.get(project.style.id, project.style.version) : null;
  let cursor = 0;
  for (const [i, beat] of beats.entries()) {
    signal?.throwIfAborted();
    const asset = project.assets.find((a) => a.id === beat.assetId && visual(a));
    if (!asset) throw new Error('分镜引用了不存在的画面素材。');
    const verifiedFact = project.factSources?.find((f) => f.url === beat.claimUrl);
    if (project.mode === 'topic' && (!beat.claimUrl || (beat.claimUrl !== asset.source?.url && !verifiedFact)))
      throw new Error('选题解说必须绑定已获取的事实出处。');
    let words = String(beat.narration || '').trim();
    let sourceStart = Number(beat.sourceStart ?? 0);
    let sourceEnd = Number(beat.sourceEnd ?? asset.duration);
    if (
      !Number.isFinite(sourceStart) ||
      sourceStart < 0 ||
      (asset.kind === 'video' &&
        (!Number.isFinite(sourceEnd) || sourceEnd <= sourceStart || sourceEnd > asset.duration + 0.05))
    ) {
      throw new Error('分镜源区间超出素材范围。');
    }
    let duration, utterance, voice, captionStart, captionDuration;
    if (project.mode === 'interview') {
      const rows = await transcriptFor(deps, await deps.store.get(project.id), asset, signal);
      utterance = rows.find((row) => row.id === beat.utteranceId);
      if (!utterance) throw new Error('口播或访谈必须使用真实转录语句 ID。');
      words = utterance.text;
      sourceStart = utterance.start;
      sourceEnd = utterance.end;
      const index = rows.findIndex((row) => row.id === utterance.id),
        next = rows[index + 1],
        nextBeat = beats[i + 1];
      if (
        next &&
        nextBeat?.assetId === asset.id &&
        nextBeat.utteranceId === next.id &&
        next.start >= sourceEnd &&
        next.start - sourceEnd <= 0.6
      ) {
        sourceEnd = next.start;
      }
      captionStart = cursor;
      captionDuration = Math.max(1, Math.round(utterance.end * fps) - Math.round(utterance.start * fps));
      duration = Math.max(1, Math.round(sourceEnd * fps) - Math.round(sourceStart * fps));
    } else if (mode === 'import') {
      utterance = voiceRows?.find((row) => row.id === beat.utteranceId);
      if (!utterance) throw new Error('导入录音的每个镜头须绑定一个有效的录音语句。');
      const until = voiceRows[i + 1]?.start ?? imported.duration;
      duration = Math.round(until * fps) - cursor;
      if (duration < 1) throw new Error('导入旁白的转录时码无法按工程帧率排列。');
      captionStart = Math.round(utterance.start * fps);
      captionDuration = Math.max(
        1,
        Math.min(Math.round(until * fps), Math.round(utterance.end * fps)) - captionStart
      );
      words = utterance.text;
      voice = imported;
    } else if (mode === 'system' || mode === 'clone') {
      if (!words || words.length > 650) throw new Error('单段旁白需包含 1 到 650 字。');
      voice = await recordedNarration(deps, await deps.store.get(project.id), words, signal);
      duration = Math.max(1, Math.round(voice.duration * fps));
    } else {
      const suggested = Number(beat.durationSeconds || readingSeconds(words));
      if (!Number.isFinite(suggested) || suggested <= 0) throw new Error('镜头时长无效。');
      duration = Math.max(
        1,
        Math.round(Math.min(suggested, asset.kind === 'video' ? sourceEnd - sourceStart : 120) * fps)
      );
    }
    if (duration > fps * 3600 || cursor + duration > fps * 21600) throw new Error('分镜时长超出六小时工程范围。');
    const sourceIn = Math.round(sourceStart * fps);
    const available = asset.kind === 'image' ? duration : Math.max(1, Math.round(sourceEnd * fps) - sourceIn);
    const visible = Math.min(duration, available);
    clips.push(
      make('video', i, { assetId: asset.id, start: cursor, duration: visible, sourceIn, gain: voice ? 0 : 1 })
    );
    if (visible < duration) {
      const hold = await holdFrame(deps, project, asset, Math.max(sourceStart, sourceEnd - 1 / fps), signal);
      clips.push(
        make('video', i + '-hold', {
          assetId: hold.id,
          start: cursor + visible,
          duration: duration - visible,
          gain: 0,
        })
      );
      notes.push({
        type: 'suggestion',
        frame: cursor + visible,
        message: '原镜头短于旁白，结尾使用来源相同的定格，可替换特写。',
      });
    }
    if (voice && mode !== 'import')
      clips.push(
        make('narration', i, {
          assetId: voice.id,
          start: cursor,
          duration,
          sourceIn: 0,
        })
      );
    if (words)
      clips.push(
        make('caption', i, { text: words, start: captionStart ?? cursor, duration: captionDuration ?? duration })
      );
    const userAnchor = (project.sourceAnchors || []).find(
      (r) =>
        r.assetId === asset.id &&
        Number.isInteger(r.sourceFrame) &&
        r.sourceFrame >= sourceIn &&
        r.sourceFrame < sourceIn + visible
    );
    const anchorSec =
      beat.actionSourceSeconds ?? (userAnchor ? userAnchor.sourceFrame / fps : asset.source?.actionSourceSeconds);
    const emphasis = beat.emphasis || userAnchor?.label;
    if (emphasis && style?.templates?.length) {
      const anchor = Math.round(anchorSec * fps);
      const key = asset.id + ':' + anchor;
      const anchorText = typeof beat.anchorText === 'string' ? beat.anchorText.trim() : '';
      const hasText = anchorText.length >= 2 && observedText.get(key)?.includes(anchorText);
      const sourceKnown =
        typeof anchorSec === 'number' &&
        Number.isFinite(anchorSec) &&
        anchor >= sourceIn &&
        anchor < sourceIn + visible &&
        (observed.has(key) ||
          hasText ||
          asset.source?.actionSourceSeconds === anchorSec ||
          userAnchor?.sourceFrame === anchor);
      if (sourceKnown) {
        const actionFrame = cursor + anchor - sourceIn;
        const shapes = deps.styleLibrary.compileScene(
          {
            style,
            template: beat.template,
            start: cursor,
            duration,
            actionFrame,
            text: String(emphasis).slice(0, 70),
            followup: beat.followup,
            subject: beat.subject,
            continuity: beat.continuity,
          },
          project.profile
        );
        for (const [j, shape] of shapes.entries())
          clips.push({
            ...shape,
            id: 'scene-' + i + '-g' + j,
            anchorAssetId: asset.id,
            anchorSourceFrame: anchor,
            actionFrame,
          });
      } else notes.push({ type: 'suggestion', frame: cursor, message: '重点动作尚无可见证据，已留出动效位置。' });
    }
    board.push({
      assetId: asset.id,
      sourceStart,
      sourceEnd,
      start: cursor,
      duration,
      utteranceId: utterance?.id,
      claimUrl: beat.claimUrl || asset.source?.url,
      continuity: String(beat.continuity || '').slice(0, 240),
    });
    if (beat.claimUrl && (beat.claimUrl === asset.source?.url || verifiedFact))
      facts.push({
        text: words,
        url: beat.claimUrl,
        assetId: asset.id,
        start: cursor,
        sourceExcerpt: verifiedFact?.excerpt || asset.source?.statement || '',
        visualRole: verifiedFact ? 'illustration' : 'source',
      });
    cursor += duration;
    onEvent?.({ type: 'progress', message: '已编排 ' + (i + 1) + ' / ' + beats.length + ' 段' });
  }
  if (imported && project.mode !== 'interview')
    clips.push(
      make('narration', 'recording', {
        assetId: imported.id,
        start: 0,
        duration: Math.round(imported.duration * fps),
      })
    );
  const musicMode =
    project.settings?.musicEnabled === false
      ? 'none'
      : project.settings?.musicMode || (project.mode === 'interview' ? 'none' : 'library');
  let music = musicMode === 'none' ? null : narrationInput(project, 'musicAssetId');
  if (!music && musicMode === 'library' && deps.audio.createMusicBed) {
    const style = project.style?.id?.includes('news') ? 'pulse' : 'calm';
    music = (await deps.store.get(project.id)).assets.find((a) => a.source?.bedStyle === style);
    if (!music) {
      const cache = (await deps.store.paths(project.id)).cache;
      await mkdir(cache, { recursive: true });
      const temp = await mkdtemp(path.join(cache, 'bed-'));
      try {
        const file = path.join(temp, 'studio-' + style + '.wav');
        await deps.audio.createMusicBed(file, {
          duration: Math.min(32, Math.max(8, cursor / fps)),
          style,
          signal,
        });
        signal?.throwIfAborted();
        music = await deps.store.addAsset(project.id, file, {
          role: 'music',
          name: '工作台曲库 · ' + (style === 'pulse' ? '律动' : '平缓'),
          provider: 'Video Studio',
          license: 'Studio original composition',
          bedStyle: style,
        });
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
  }
  if (!music && (['original', 'asset'].includes(musicMode) || project.settings?.requireMusic))
    notes.push({ type: 'required', frame: 0, message: '本项目要求的配乐尚未加入，请选择相应的曲目。' });
  if (music) {
    const full = Math.max(1, Math.floor(music.duration * fps));
    let i = 0;
    for (let start = 0; start < cursor; start += full) {
      if (i > 2000) throw new Error('配乐片段太短，请导入较长曲目。');
      clips.push(
        make('music', i++, { assetId: music.id, start, duration: Math.min(full, cursor - start), gain: 0.22 })
      );
    }
  }
  const target = Number(project.settings?.targetDuration);
  if (target > 0 && Math.abs(cursor / fps - target) > Math.max(2, target * 0.1)) {
    notes.push({
      type: 'suggestion',
      frame: Math.max(0, cursor - 1),
      message: '当前成片长 ' + (cursor / fps).toFixed(1) + ' 秒，本期目标为 ' + target + ' 秒。',
    });
  }
  signal?.throwIfAborted();
  const latest = await deps.store.get(project.id);
  if (sceneIdentity(latest) !== expected)
    throw new Error('制作期间工程已修改，分镜尚未覆盖时间线，请按当前版本重试。');
  const commands = [
    ...latest.timeline.clips.map((c) => ({ op: 'remove', id: c.id })),
    ...clips.map((clip) => ({ op: 'add', clip })),
  ];
  const updated = await deps.store.apply(project.id, latest.revision, commands, 'codex');
  await deps.store.setMeta(project.id, { storyboard: board, facts, directorNotes: notes });
  return { project: updated, notes };
}
