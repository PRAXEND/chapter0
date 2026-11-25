// These defaults refer to the published Henry v8 editions, not similarly named custom styles.
export const henryV8 = style => style?.version===8 && ['henry-hot-news','henry-technical-explainer'].includes(style.id);
const hotMusic={title:'陌生厨房｜热血节拍纯音乐',author:'Henry 风格包原工程（Mureka 9 生成）',
  url:'resource:media/hot-news/陌生厨房｜热血节拍纯音乐.mp3',license:'原工程生成的纯音乐，适用 ChatCut 输出使用条款',
  license_url:'https://chatcut.io/docs/usage-policy',sha256:'c373f392e6540081e23f52b62cdfb52d5508aa9fec7d05a4da08bd2c0dfeb4b7',
  source_seconds:[0,1889/30],originalAssetId:'ref-b2d81b025693'};
// Audio defaults apply only to a pinned style that declares the corresponding rules.
export function styleAudioPolicy(style) {
  if (!style) return null;
  const rules = new Set((style.rules || []).map(r => r.id));
  const blueprint = style.audioBlueprint || style.reproduction_blueprint?.audio || {};
  const voiceRule = rules.has('voice-speed') || rules.has('voice-one-point-two');
  const musicRule = rules.has('instrumental-bed') || rules.has('instrumental-bgm-required');
  if (!voiceRule && !musicRule) return null;
  const voiceSpec = blueprint.voice || {}, musicSpec = blueprint.music || (henryV8(style)&&style.id==='henry-hot-news'?hotMusic:{});
  const speed = Number(voiceSpec.speed || 1.2);
  const [start, end] = musicSpec.source_seconds || [];
  return {
    styleId: style.id, styleVersion: style.version,
    voice: voiceRule ? {
      preferredName: henryV8(style)?null:voiceSpec.preferred_saved_name || null,
      ...(henryV8(style)?{preset:'dylan'}:{}),
      speed: Number.isFinite(speed) && speed >= .5 && speed <= 2 ? speed : 1,
    } : null,
    music: musicRule ? {
      title: musicSpec.title || null, author: musicSpec.author || null, url: musicSpec.url || null,
      license: musicSpec.license || null, licenseUrl: musicSpec.license_url || null,
      ...(musicSpec===hotMusic?{sha256:hotMusic.sha256,originalAssetId:hotMusic.originalAssetId}:{}),
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

export function activeStyleMusicCredit(project) {
  const m=project.styleAudio?.music;
  if(!m?.credit || !m.url || !m.licenseUrl || !m.license) return null;
  const asset=project.assets.find(a=>a.id===m.assetId && a.sha256===m.sha256);
  if(!asset || !project.timeline.clips.some(c=>c.assetId===asset.id && c.track==='music' && c.enabled!==false && !c.muted && !c.hidden && (c.gain??1)>0))return null;
  return {assetId:asset.id,line:[m.credit,m.license,m.url,m.licenseUrl].map(s=>String(s).replace(/[\r\n]/g,' ').slice(0,1000)).join(' · ')};
}

export const dedicatedVoiceReference = asset => Boolean(asset?.source?.sourceVoice || asset?.source?.role === 'voice-reference');
