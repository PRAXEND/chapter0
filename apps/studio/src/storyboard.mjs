import {componentClip,defaultMotionGeometry,motionCatalog} from './motion-components.mjs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { visibleWindows } from './framing.mjs';
import { dedicatedVoiceReference } from './style-audio.mjs';
import { paceNarration,measureLoudness } from './style-audio-render.mjs';
import { alignmentNote, captionCues, narrationAlignment } from './speech-alignment.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const visual = (asset) => !dedicatedVoiceReference(asset) && (asset.kind === 'video' || asset.kind === 'image');
export const sceneIdentity = (p) =>
  digest([p.brief, p.script, p.mode, p.profile, p.settings, p.style, p.timeline.clips]);
const holdMessage = '原镜头短于旁白，结尾使用来源相同的定格，可替换特写。';

export function currentCutNotes(project, notes = project.directorNotes || []) {
  const isHoldNote = n => n.kind === 'source-hold' || n.message === holdMessage;
  const previous = notes.filter(isHoldNote);
  if (!previous.length) return notes;
  const assets = new Map(project.assets.map(a => [a.id, a]));
  const shots = project.timeline.clips.filter(c => c.track === 'video' && !c.hidden && c.enabled !== false)
    .sort((a, b) => a.start - b.start).map(clip => ({clip, asset: assets.get(clip.assetId)}));
  const current = notes.filter(n => !isHoldNote(n));
  for (const {shot, from, to} of visibleWindows(shots)) {
    if (shot.asset?.source?.role !== 'hold') continue;
    const matches = previous.some(n => n.assetId ? n.assetId === shot.clip.assetId :
      (n.frame >= shot.clip.start && n.frame < shot.clip.start + shot.clip.duration) || /^scene-\d+-hold-video$/.test(shot.clip.id));
    if (matches) current.push({type: 'suggestion', kind: 'source-hold', assetId: shot.clip.assetId,
      clipId: shot.clip.id, frame: from, toFrame: to, message: holdMessage});
  }
  return current;
}
export function durationNotes(project, notes = project.directorNotes || []) {
  const current = currentCutNotes(project, notes).filter(
    (n) => n.kind !== 'target-duration' && !/^当前成片长 [\d.]+ 秒，本期目标为/.test(n.message || '')
  );
  const frames = project.timeline.clips
    .filter((c) => c.enabled !== false && !c.hidden)
    .reduce((end, c) => Math.max(end, c.start + c.duration), 0);
  const target = Number(project.settings?.targetDuration),
    actual = frames / project.profile.fps;
  if (target > 0 && Math.abs(actual - target) > Math.max(2, target * 0.1))
    current.push({
      type: 'suggestion',
      kind: 'target-duration',
      frame: Math.max(0, frames - 1),
      message: '当前成片长 ' + actual.toFixed(1) + ' 秒，本期目标为 ' + target + ' 秒。',
    });
  return current;
}
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
  const reference = mode==='clone' ? narrationInput(project, 'voiceReferenceAssetId') : null;
  const speechRate = project.styleAudio?.voice?.speed || 1;
  const stylePaced = speechRate !== 1;
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
    ...(mode==='preset'? [settings.presetVoice||'dylan'] : []),
    reference?.sha256,
    mode==='clone' ? settings.voiceReferenceText : undefined,
    ...(stylePaced ? [speechRate] : []),
    text,
  ]);
  const previous = project.assets.find((a) => a.source?.narrationKey === key);
  if (previous) return previous;
  const cache = (await deps.store.paths(project.id)).cache;
  await mkdir(cache, { recursive: true });
  const scratch = await mkdtemp(path.join(cache, 'narration-'));
  try {
    const output = path.join(scratch, 'narration.wav');
    const unpaced=stylePaced?path.join(scratch,'native.wav'):output;
    let generated = await deps.audio.synthesize(text, {
      mode,
      voice: mode==='preset'?(settings.presetVoice||'dylan'):settings.systemVoice,
      voiceId: settings.voiceId,
      referencePath: reference?.path,
      referenceText: mode==='clone' ? settings.voiceReferenceText||'' : '',
      consent: mode === 'clone',
      output:unpaced,
      signal,
    });
    signal?.throwIfAborted();
    if(stylePaced)generated=await (deps.paceNarration||paceNarration)(unpaced,output,speechRate,generated,{signal});
    const measuredLUFS = project.styleAudio ?
      await (deps.measureLoudness||measureLoudness)(output,{signal,duration:generated?.duration||30}).catch(e=>{signal?.throwIfAborted();return null;}) : null;
    return await deps.store.addAsset(project.id, output, {
      role: 'narration',
      narrationKey: key,
      text,
      mode,
      voiceId: mode==='preset'?(generated?.preset||settings.presetVoice||'dylan'):(mode==='clone' ? (settings.voiceId || settings.voiceLibraryId || reference?.id) : (settings.systemVoice||generated?.model||'system')),
      ...(mode==='preset'?{preset:generated?.preset||settings.presetVoice||'dylan',modelRevision:generated?.modelRevision,modelSha256:generated?.modelSha256}:{}),
      ...(project.styleAudio ? {speechRate:generated?.speechRate??1,baseDuration:generated?.baseDuration??null,baseSha256:generated?.baseSha256??null,tempoMethod:generated?.tempoMethod??null,measuredLUFS} : {}),
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
    const supplied = sentenceList(project.script);
    if (supplied.length)
      return supplied.map((narration, i) => {
        const asset = sourced[i % sourced.length];
        return { assetId: asset.id, narration, sourceStart: 0, claimUrl: asset.source.url, userScript: true };
      });
    const brief = String(project.brief || ''),
      written = project.settings?.narrationLanguage || project.settings?.language;
    const wantsChinese = written
      ? /^(zh|cn|Chinese|中文|普通话)/i.test(written)
      : /中文|普通话/.test(brief) ||
        (!/(?:用|使用|要求)(?:英语|英文)|English narration/i.test(brief) && /\p{Script=Han}/u.test(brief));
    return sourced.slice(0, 12).map((a) => {
      const sentence = sentenceList(a.source.statement)[0] || '';
      const narration = sentence.length > 240 ? a.source.title || a.name : sentence;
      if (wantsChinese && !/[\p{Script=Han}]{2}/u.test(narration))
        return { assetId: a.id, sourceStart: 0, sourceOnly: true, narration: '', claimUrl: a.source.url };
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
  if (!['clone', 'system', 'preset'].includes(voiceMode(project)))
    throw new Error('同期声或外部录音请从原句裁切；替换台词需选择可合成的声音。');
  const clips = project.timeline.clips;
  const voices =
    target.track === 'narration'
      ? [target]
      : clips.filter(
          (c) =>
            c.track === 'narration' &&
            (target.speechGroup
              ? c.id === target.speechGroup
              : c.start === target.start && c.duration === target.duration)
        );
  if (voices.length !== 1) throw new Error('该字幕没有可唯一定位的同段旁白，请在时间线上选择对应的声音。');
  const [voice] = voices;
  let captions = clips.filter((c) => c.track === 'caption' && c.speechGroup === voice.id);
  if (!captions.length) {
    captions = clips.filter(
      (c) => c.track === 'caption' && !c.speechGroup && c.start === voice.start && c.duration === voice.duration
    );
    if (captions.length > 1) throw new Error('这条旧旁白关联多个同时字幕，需在时间线上确定对应关系。');
  }
  if (target.track === 'caption' && !captions.some((c) => c.id === target.id))
    throw new Error('所选字幕未绑定到对应旁白。');
  if (!captions.length || voice.locked || captions.some((c) => c.locked))
    throw new Error('该句需要未锁定的旁白和同组字幕。');
  captions.sort((a, b) => a.start - b.start || (a.speechCue || 0) - (b.speechCue || 0));
  const fullText =
    target.track === 'caption' ? captions.map((c) => (c.id === target.id ? words : c.text)).join('') : words;
  if (fullText.length > 650) throw new Error('更新后的完整旁白句超过 650 字。');
  const expected = sceneIdentity(project),
    audio = await recordedNarration(deps, project, fullText, signal);
  const alignment = await narrationAlignment(deps, project.id, audio, fullText, signal);
  const frames = Math.max(1, Math.round(audio.duration * project.profile.fps));
  let speed = frames / voice.duration;
  const changes = [];
  if (speed < 0.85 || speed > 1.18) {
    const delta = frames - voice.duration,
      end = voice.start + voice.duration;
    const groupIds = new Set([voice.id, ...captions.map((c) => c.id)]);
    const overlaps = project.timeline.clips.filter(
      (c) => c.start < end && c.start + c.duration > voice.start && !groupIds.has(c.id)
    );
    if (
      overlaps.some((c) => c.locked || c.start !== voice.start || c.duration !== voice.duration) ||
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
      changes.push({
        op: 'update',
        id: c.id,
        changes: {
          start: c.start + delta,
          ...(Number.isInteger(c.actionFrame) ? { actionFrame: c.actionFrame + delta } : {}),
        },
      });
    speed = 1;
  }
  const duration = speed === 1 ? frames : voice.duration;
  changes.push({
    op: 'update',
    id: voice.id,
    changes: { assetId: audio.id, sourceIn: 0, speed, duration, speechGroup: voice.id },
  });
  const replacements = captionCues(alignment, {
    id: captions[0].id,
    group: voice.id,
    assetId: audio.id,
    start: voice.start,
    duration,
    speed,
    fps: project.profile.fps,
  });
  // Retain individual formatting on reusable cue IDs, or inherit it from the first
  // caption when a new cue is needed. Time, text and audio binding come from alignment.
  const previous = new Map(captions.map((c) => [c.id, c]));
  for (const cue of replacements) {
    const { id, track, sourceIn, speed, gain, ...values } = cue;
    if (previous.has(id)) {
      const old = previous.get(id);
      if (old.keyframes?.length && old.duration !== cue.duration)
        values.keyframes = old.keyframes.map((k) => ({
          ...k,
          frame: Math.round((k.frame * cue.duration) / old.duration),
        }));
      changes.push({ op: 'update', id, changes: values });
      previous.delete(id);
    } else {
      const { locked: ignore, keyframes: oldAnimation, ...template } = captions[0];
      changes.push({ op: 'add', clip: { ...template, ...cue } });
    }
  }
  for (const id of previous.keys()) changes.push({ op: 'remove', id });
  signal?.throwIfAborted();
  const latest = await deps.store.get(project.id);
  if (sceneIdentity(latest) !== expected) throw new Error('合成期间工程已更新，请对照当前版本重试。');
  const result = await deps.store.apply(project.id, latest.revision, changes, 'codex');
  const note = alignmentNote(alignment, voice.id, voice.start);
  const move = (frame) => (frame >= voice.start + voice.duration ? frame + duration - voice.duration : frame);
  const notes = (result.directorNotes || [])
    .filter((n) => n.speechGroup !== voice.id)
    .map((n) => ({ ...n, frame: move(n.frame) }));
  if (note) notes.push(note);
  const board = (result.storyboard || []).map((row) =>
    row.speechGroup === voice.id ||
    (!row.speechGroup && row.start === voice.start && row.duration === voice.duration)
      ? {
          ...row,
          duration,
          speechGroup: voice.id,
          speechAssetId: audio.id,
          speechScriptHash: alignment.scriptHash,
        }
      : { ...row, start: move(row.start) }
  );
  const facts = (result.facts || []).map((f) => ({ ...f, start: move(f.start) }));
  return deps.store.setMeta(project.id, { directorNotes: notes, storyboard: board, facts });
}

export async function applyScenes(
  deps,
  project,
  beats,
  { signal, observed = new Set(), observedText = new Map(), onEvent, visualFrames = [], localDraft = false } = {}
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
    const normalized=s=>String(s||'').normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
    const claimQuote=String(beat.claimQuote||'').trim();
    if(project.mode==='topic' && beat.visualSteps?.some(s=>s.stage==='mechanism') && !['observation','explanation'].includes(beat.claimKind))
      throw Error('机制段须注明 claimKind：仅描述当前画面可见的现象用 observation；解释因果或材料性质用 explanation，并绑定实际出处。');
    if(project.mode==='topic' && beat.claimKind==='explanation'){
      if(!verifiedFact || (beat.claimUrl===asset.source?.url && normalized(verifiedFact.excerpt)===normalized(asset.source?.statement)))throw Error('原理解释需要能核对机制的研究或正文。摄影图注只支持画面上的现象。');
      if(normalized(verifiedFact.excerpt)===normalized(verifiedFact.title)||claimQuote.length<6||claimQuote.length>360||!normalized(verifiedFact.excerpt).includes(normalized(claimQuote)))throw Error('claimQuote 需逐字来自已读取的正文或摘要，并直接支持这句原理；只有标题或找不到对应原文时，请改用可见现象。');
    }
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
    let duration, utterance, voice, alignment, captionStart, captionDuration;
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
    } else if ((['system','clone','preset'].includes(mode)) && !(localDraft && beat.sourceOnly)) {
      if (!words || words.length > 650) throw new Error('单段旁白需包含 1 到 650 字。');
      voice = await recordedNarration(deps, await deps.store.get(project.id), words, signal);
      duration = Math.max(1, Math.round(voice.duration * fps));
      alignment = await narrationAlignment(deps, project.id, voice, words, signal);
    } else {
      const suggested = Number(beat.durationSeconds || readingSeconds(words));
      if (!Number.isFinite(suggested) || suggested <= 0) throw new Error('镜头时长无效。');
      duration = Math.max(
        1,
        Math.round(Math.min(suggested, asset.kind === 'video' ? sourceEnd - sourceStart : 120) * fps)
      );
      if (localDraft && beat.sourceOnly && !notes.some((n) => n.kind === 'narration-language'))
        notes.push({
          type: 'required',
          kind: 'narration-language',
          frame: cursor,
          message:
            '素材的外文图注已保存为来源。此处保留画面草稿，需要中文台词，可提供脚本或交给 Codex 根据图注编写。',
        });
    }
    if (duration > fps * 3600 || cursor + duration > fps * 21600) throw new Error('分镜时长超出六小时工程范围。');
    const sourceIn = Math.round(sourceStart * fps);
    const available = asset.kind === 'image' ? duration : Math.max(1, Math.round(sourceEnd * fps) - sourceIn);
    const visible = Math.min(duration, available);
    clips.push(
      make('video', i, {
        assetId: asset.id,
        start: cursor,
        duration: visible,
        sourceIn,
        gain: voice || (localDraft && beat.sourceOnly && mode !== 'original') ? 0 : 1,
        ...(beat.framing ? { framing: beat.framing } : {}),
      })
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
        type: 'suggestion', kind: 'source-hold', assetId: hold.id,
        frame: cursor + visible,
        message: holdMessage,
      });
    }
    const speechGroup = 'scene-' + i + '-narration';
    if (voice && mode !== 'import')
      clips.push(
        make('narration', i, {
          assetId: voice.id,
          start: cursor,
          duration,
          sourceIn: 0,
          ...(Number.isFinite(voice.source?.measuredLUFS) ? {gain: Math.min(4, Math.max(.25, 10**((-16-voice.source.measuredLUFS)/20)))} : {}),
          speechGroup,
        })
      );
    if (alignment) {
      clips.push(
        ...captionCues(alignment, {
          id: 'scene-' + i + '-caption',
          group: speechGroup,
          assetId: voice.id,
          start: cursor,
          duration,
          fps,
        })
      );
      const note = alignmentNote(alignment, speechGroup, cursor);
      if (note) notes.push(note);
    } else if (words)
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
    const steps = (beat.visualSteps || []).map((step) => {
      if (!Number.isFinite(step.atSeconds) || step.atSeconds < 0 || Math.round(step.atSeconds * fps) >= visible)
        throw Error('视觉阶段的落点超出实测镜头，请把 atSeconds 放在当前可见区间内。');
      const sourceSeconds =
        asset.kind === 'image' ? 0 : Number(step.sourceSeconds ?? sourceStart + step.atSeconds);
      if (asset.kind === 'video' && (sourceSeconds < sourceStart || sourceSeconds >= sourceEnd))
        throw Error('使用的视觉证据位于选定原片区间之外。');
      const match = visualFrames.find(
        (f) =>
          f.source === 'asset' &&
          f.assetId === asset.id &&
          f.assetHash === asset.sha256 &&
          Math.abs(f.seconds - sourceSeconds) <= 0.5 / fps
      );
      return {
        ...step,
        region: step.region || { x: 0, y: 0, width: 1, height: 1 },
        atFrame: cursor + Math.round(step.atSeconds * fps),
        sourceFrame: Math.round(sourceSeconds * fps),
        anchorSourceFrame: Math.round(sourceSeconds * fps),
        assetId: asset.id,
        assetHash: asset.sha256,
        witnessFrameHash: match?.sha256 || null,
      };
    });
    let motionPlan=beat.motionComponent;
    if (steps.length && style?.templates?.length) {
      const scene = {
        style,
        template: 'step-reveal',
        start: cursor,
        duration: visible,
        actionFrame: steps[0].atFrame,
        anchorAssetId: asset.id,
        anchorSourceFrame: steps[0].anchorSourceFrame,
        text: steps[0].label,
        visualSteps: steps,
        evidenceView: {
          width: asset.width,
          height: asset.height,
          pixelAspect: asset.pixelAspect,
          sha256: asset.sha256,
          fit: 'contain',
          framing: beat.framing,
          start: cursor,
          duration: visible,
        },
        soundEnabled:
          project.settings?.sceneSound === false ? false : (beat.soundEnabled ?? project.settings?.sceneSound),
        soundAssetId: beat.soundAssetId,
      };
      const shapes = deps.compileSceneWithSound
        ? (
            await deps.compileSceneWithSound(
              deps.styleLibrary,
              deps.store,
              await deps.store.get(project.id),
              scene
            )
          ).clips
        : deps.styleLibrary.compileScene(scene, project.profile);
      const chips=shapes.filter(shape=>shape.templateRole==='process-rail'&&shape.stageActive);
      if(!motionPlan && chips.length===3 && new Set(steps.map(s=>s.stage)).size===3 &&
          style.components?.some(c=>c.id==='process-rail')){
        const texts=chips.map(c=>c.text);
        motionPlan={componentId:'process-rail',props:{a:texts[0],b:texts[1],c:texts[2]},cueSource:'visualSteps',
          geometry:{...defaultMotionGeometry(motionCatalog.find(c=>c.id==='process-rail'),project.profile),y:chips[0].geometry.y}};
      }
      for (const [j, shape] of shapes.entries()){
        if(motionPlan?.componentId==='process-rail'&&shape.templateRole==='process-rail')continue;
        clips.push({ ...shape, id: 'scene-' + i + '-g' + j });
      }
    } else if (emphasis && style?.templates?.length) {
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
        const scene = {
          style,
          template: beat.template,
          start: cursor,
          duration,
          actionFrame,
          text: String(emphasis).slice(0, 70),
          followup: beat.followup,
          subject: beat.subject,
          continuity: beat.continuity,
          anchorAssetId: asset.id,
          anchorSourceFrame: anchor,
          soundEnabled:
            project.settings?.sceneSound === false ? false : (beat.soundEnabled ?? project.settings?.sceneSound),
          soundAssetId: beat.soundAssetId,
        };
        const shapes = deps.compileSceneWithSound
          ? (
              await deps.compileSceneWithSound(
                deps.styleLibrary,
                deps.store,
                await deps.store.get(project.id),
                scene
              )
            ).clips
          : deps.styleLibrary.compileScene(scene, project.profile);
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
    if(motionPlan){
      const {componentId,props,geometry,cueSource,atSeconds,durationSeconds}=motionPlan;
      let offset=Math.round((atSeconds??0)*fps),cueFrames=motionPlan.cueFrames;
      if(cueSource){
        if(cueFrames||atSeconds!==undefined||!['visualSteps','captionStarts'].includes(cueSource))
          throw Error('自动绑定落点时请只指定画面动作或字幕起点。');
        const markers=cueSource==='visualSteps'?steps.map(s=>s.atFrame):clips.filter(c=>c.track==='caption'&&c.start>=cursor&&c.start<cursor+visible).map(c=>c.start);
        if(!markers.length)throw Error('该镜头没有可绑定的动作或字幕起点。');
        offset=markers[0]-cursor;
        cueFrames=markers.map(frame=>frame-markers[0]);
      }
      const span=durationSeconds===undefined ? visible-offset : Math.round(durationSeconds*fps);
      if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(span)||offset<0||span<1||offset+span>visible)
        throw Error('组件的出场或退场超出该镜头的可见时段。');
      clips.push(componentClip({id:'scene-'+i+'-motion',componentId,props,geometry,cueFrames,
        start:cursor+offset,duration:span},project.profile));
    }
    board.push({
      assetId: asset.id,
      videoClipId: 'scene-' + i + '-video',
      ...(asset.kind === 'video' && beat.motionEvidence
        ? {
            motionEvidence: {
              fromSeconds: beat.motionEvidence.fromSeconds,
              toSeconds: beat.motionEvidence.toSeconds,
              observation: String(beat.motionEvidence.observation || '').slice(0, 360),
            },
          }
        : {}),
      sourceStart,
      sourceEnd,
      start: cursor,
      duration,
      utteranceId: utterance?.id,
      ...(steps.length ? { visualSteps: steps, framing: beat.framing } : {}),
      ...(alignment ? { speechGroup, speechAssetId: voice.id, speechScriptHash: alignment.scriptHash } : {}),
      claimUrl: beat.claimUrl || asset.source?.url,
      ...(beat.claimKind
        ? { claimKind: beat.claimKind, claimQuote: claimQuote || undefined, visualSourceUrl: asset.source?.url }
        : {}),
      continuity: String(beat.continuity || '').slice(0, 240),
    });
    if (beat.claimUrl && (beat.claimUrl === asset.source?.url || verifiedFact))
      facts.push({
        text: words || (localDraft && beat.sourceOnly ? asset.source?.statement : ''),
        url: beat.claimUrl,
        assetId: asset.id,
        start: cursor,
        sourceExcerpt: claimQuote || verifiedFact?.excerpt || asset.source?.statement || '',
        ...(beat.claimKind?{claimKind:beat.claimKind,sourceTitle:verifiedFact?.title,visualSourceUrl:asset.source?.url}:{}),
        visualRole: verifiedFact || beat.userScript ? 'illustration' : 'source',
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
  const musicRecipe = project.styleAudio?.music;
  let mixReceipt = musicRecipe;
  let music = musicMode === 'none' ? null : project.assets.find(a=>a.id===musicRecipe?.assetId && a.kind==='audio') || narrationInput(project, 'musicAssetId');
  if (!music && musicMode === 'library' && deps.audio.createMusicBed) {
    const style = musicRecipe?.bedStyle || (project.style?.id?.includes('news') ? 'pulse' : 'calm');
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
          kind: 'local-composition', rights:'Video Studio original instrumental',
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
    notes.push({
      type: 'required',
      kind: 'music-required',
      frame: 0,
      message: '本项目要求的配乐尚未加入，请选择相应的曲目。',
    });
  if (music && musicMode === 'original') {
    const s = music.source || {};
    const verified =
      (s.kind === 'generated-music' && s.provider && s.requestId) ||
      (['user-composed', 'local-composition'].includes(s.kind) && s.rights);
    if (!verified)
      notes.push({
        type: 'required',
        kind: 'music-required',
        frame: 0,
        message: '所选配乐已上轨，原创来源还需核实。',
      });
  }
  if (music) {
    const sourceIn = Math.max(0, Math.round((musicRecipe?.sourceStart || 0)*fps));
    const sourceEnd = Math.min(Math.floor(music.duration*fps), musicRecipe?.sourceEnd ? Math.round(musicRecipe.sourceEnd*fps) : Infinity);
    const full = sourceEnd - sourceIn;
    if (full < 1) throw Error('指定配乐的源选段不在本地原件内。');
    let gain = .22;
    if (musicRecipe) {
      const placed = clips.filter(c=>c.track==='narration' && !c.muted && (c.gain??1)>0);
      const all=(await deps.store.get(project.id)).assets;
      const measure = async (asset,start,duration) => {
        if(!asset)return null;
        try{return await (deps.measureLoudness||measureLoudness)(asset.path,{start,duration,signal});}
        catch{signal?.throwIfAborted();return null;}
      };
      const levels=[];
      const selected=placed.length>5?Array.from({length:5},(_,i)=>placed[Math.round(i*(placed.length-1)/4)]):placed;
      for(const clip of selected) {
        const asset=all.find(a=>a.id===clip.assetId);
        const level=asset?.source?.measuredLUFS ?? await measure(asset,(clip.sourceIn||0)/fps,clip.duration/fps);
        if(Number.isFinite(level)) levels.push(level+20*Math.log10(clip.gain??1));
      }
      levels.sort((a,b)=>a-b);
      const voiceLUFS=levels.length?levels[Math.floor(levels.length/2)]:null;
      const windowSeconds=Math.min(90,full/fps,cursor/fps);
      const sourceLUFS=await measure(music,sourceIn/fps,windowSeconds);
      if(Number.isFinite(sourceLUFS)) gain=Math.min(4,Math.max(.003,10**(((voiceLUFS??-16)-14-sourceLUFS)/20)));
      mixReceipt={...musicRecipe,assetId:music.id,sha256:music.sha256,title:musicRecipe.title||music.name,
        status:musicRecipe.status==='missing'?'alternative':musicRecipe.status,ducking:false,gain,
        sourceLUFS,voiceLUFS,measuredSourceSeconds:windowSeconds,mixMethod:Number.isFinite(sourceLUFS)&&Number.isFinite(voiceLUFS)?'measured-fixed':'estimated-fixed'};
    }
    let i = 0;
    for (let start = 0; start < cursor; start += full) {
      if (i > 2000) throw new Error('配乐片段太短，请导入较长曲目。');
      clips.push(make('music',i++,{assetId:music.id,start,duration:Math.min(full,cursor-start),sourceIn,gain,
        ...(musicRecipe?{ducking:false,role:'music-bed'}:{})}));
    }
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
  const finalNotes = durationNotes(updated, notes);
  await deps.store.setMeta(project.id, { storyboard: board, facts, directorNotes: finalNotes,
    ...(project.styleAudio ? { styleAudio:{...project.styleAudio,music:mixReceipt} } : {}) });
  return { project: updated, notes: finalNotes };
}
