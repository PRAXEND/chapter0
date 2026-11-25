// Explicit bounds are inclusive. A target by itself is a creative preference.
export function requestedDurationRange(brief) {
  const range=/(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:onds?)?)?)?\s*(?:[-–—~～至到]|\bto\b)\s*(\d+(?:\.\d+)?)\s*(?:秒(?:钟)?|s(?:ec(?:onds?)?)?\b)/i;
  let inferred;
  for (const clause of String(brief||'').split(/[，,。；;\n]/u)) {
    const m=range.exec(clause);
    if(!m)continue;
    const before=clause.slice(0,m.index),after=clause.slice(m.index+m[0].length);
    const length=/(?:全片|(?:成片|目标|总|视频)?时长|片长|总长|全长|runtime|total duration|running time)[^，,。；;]{0,18}$/i.test(before);
    const bounds={durationMinSeconds:Number(m[1]),durationMaxSeconds:Number(m[2])};
    if(length)return bounds;
    const film=/^\s*(?:的)?(?:完整)?(?:短视频|短片|成片|视频|片子)/u.test(after);
    const editing=/(?:原片|素材|镜头|片段|把|将)[^，。]{0,12}$/u.test(before)||/(?:换成|改成|替换|剪掉|删除|保留旁白|回看|截取)/u.test(after);
    if(film&&!editing)inferred=bounds;
  }
  return inferred||{};
}
export function validateDuration(settings) {
  for (const key of ['durationMinSeconds', 'durationMaxSeconds', 'targetDuration']) {
    const value = settings[key];
    if (value != null && (!Number.isFinite(value) || value <= 0 || value > 86400)) throw new Error('片长须为一天以内的正数。');
  }
  if (settings.durationMinSeconds != null && settings.durationMaxSeconds != null && settings.durationMinSeconds > settings.durationMaxSeconds)
    throw new Error('最短片长不能超过最大片长。');
}
export function durationFinding(settings = {}, seconds, fps) {
  const { durationMinSeconds: min, durationMaxSeconds: max } = settings;
  if (!Number.isFinite(seconds) || !Number.isFinite(fps) || fps <= 0 || (min == null && max == null)) return null;
  // Compare presentation frames, so a muxer's fractional final audio packet cannot fail the cut.
  const frames = Math.round(seconds * fps);
  if ((min == null || frames >= Math.ceil(min * fps - 1e-8)) && (max == null || frames <= Math.floor(max * fps + 1e-8))) return null;
  const range = min == null ? '最长 ' + max : max == null ? '最短 ' + min : min + ' 至 ' + max;
  return {id:'duration-range', reason:'duration-range', severity:'major', message:'成片实长 ' + seconds.toFixed(2) + ' 秒，本期要求' + range + ' 秒。', fix:'调整分镜和旁白至指定片长后重新核对。', fromFrame: Math.max(0,Math.min(frames - 1, Math.floor((max ?? seconds) * fps))), toFrame:Math.max(0, frames - 1)};
}
