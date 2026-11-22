// Audio defaults apply only to a pinned style that declares the corresponding rules.
export function styleAudioPolicy(style) {
  if (!style) return null;
  const rules = new Set((style.rules || []).map(r => r.id));
  const blueprint = style.audioBlueprint || style.reproduction_blueprint?.audio || {};
  const voiceRule = rules.has('voice-speed') || rules.has('voice-one-point-two');
  const musicRule = rules.has('instrumental-bed') || rules.has('instrumental-bgm-required');
  if (!voiceRule && !musicRule) return null;
  const voiceSpec = blueprint.voice || {}, musicSpec = blueprint.music || {};
  const speed = Number(voiceSpec.speed || 1.2);
  const [start, end] = musicSpec.source_seconds || [];
  return {
    styleId: style.id, styleVersion: style.version,
    voice: voiceRule ? {
      preferredName: voiceSpec.preferred_saved_name || null,
      speed: Number.isFinite(speed) && speed >= .5 && speed <= 2 ? speed : 1,
    } : null,
    music: musicRule ? {
      title: musicSpec.title || null, author: musicSpec.author || null, url: musicSpec.url || null,
      license: musicSpec.license || null, licenseUrl: musicSpec.license_url || null,
      sourceStart: Number.isFinite(start) ? start : 0, sourceEnd: Number.isFinite(end) ? end : null,
      bedStyle: rules.has('instrumental-bgm-required') ? 'pulse' : 'calm',
      ducking: false, targetDifferenceLU: [12, 18],
    } : null,
  };
}

export function audioSelection(project, channel) {
  const s = project.settings || {};
  const marked = s[channel + 'Selection'];
  if (['user', 'style', 'preview'].includes(marked)) return marked;
  if (channel === 'voice') return project.mode === 'interview' || ['import', 'original', 'clone'].includes(s.voiceMode) ? 'user' : 'style';
  if (s.musicMode === 'asset' || s.musicMode === 'original' || s.musicAssetId) return 'user';
  // A historical "none" might be an unconfirmed production default. Preserve the muted timeline
  // and leave its style exception unresolved until the user explicitly chooses it.
  return project.mode === 'interview' ? 'user' : 'style';
}
