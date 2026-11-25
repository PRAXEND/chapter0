// Explicit bounds are inclusive. A target by itself is a creative preference.
export function requestedDurationRange(brief) {
  const match = String(brief || '').match(/(?:片长|时长|总长|全长|控制在|剪(?:辑)?(?:一条|一个)?|制作(?:一条|一个)?)\s*(?:为|在|约)?\s*(\d+(?:\.\d+)?)\s*[-–—~～至到]\s*(\d+(?:\.\d+)?)\s*秒|(?:^|[，,。\s])(?<min>\d+(?:\.\d+)?)\s*[-–—~～至到]\s*(?<max>\d+(?:\.\d+)?)\s*秒(?:钟)?的?(?:完整)?(?:成片|短片|视频|片子)/u);
  if (!match) return {};
  return { durationMinSeconds: Number(match[1] ?? match.groups.min), durationMaxSeconds: Number(match[2] ?? match.groups.max) };
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
