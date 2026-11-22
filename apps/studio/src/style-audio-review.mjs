import {styleAudioPolicy,audioSelection} from './style-audio.mjs';
import {measureMusicMix,isMusicBed,verifyMusicExcerpt} from './music-evidence.mjs';

const audible=c=>c.enabled!==false&&!c.hidden&&!c.muted&&(c.gain??1)>0;
const endOf=c=>c.start+c.duration;
function finding(component,severity,message,fix,fromFrame,toFrame) {
  return {id:'style-audio-'+component,reason:'style-audio-'+component,severity,message,fix,fromFrame,toFrame:Math.max(fromFrame,toFrame-1)};
}
function sameIdentity(policy,source,actualHash) {
  if(!actualHash||!policy.title||!['style-music','music'].includes(source.kind)||
    (source.styleResourceHash||source.originalSha256)!==actualHash||actualHash!==policy.sha256)return false;
  return ['title','author','url','license'].every(key=>!policy[key]||(key==='author'?source.author||source.artist:source[key])===policy[key]);
}
async function assessVoice(project,policy,receipt,selection,options) {
  const settings=project.settings||{},assets=new Map(project.assets.map(a=>[a.id,a]));
  const clips=project.timeline.clips.filter(c=>c.track==='narration'&&audible(c));
  const original=settings.voiceMode==='original'&&selection==='user';
  if(original&&!clips.length)clips.push(...project.timeline.clips.filter(c=>c.track==='video'&&audible(c)&&assets.get(c.assetId)?.hasAudio));
  const reference=assets.get(settings.voiceReferenceAssetId),expectedReference=reference&&await options.verifiedHash(reference);
  const voiceId=settings.voiceLibraryId||settings.voiceId;
  const summary={required:true,selection,preferredName:policy.preferredName,expectedSpeed:policy.speed,referenceHash:expectedReference||null,sources:[],reasons:[]};
  if(!clips.length){
    summary.status='missing';summary.reasons.push('本期旁白或所选同期声没有可听片段。');
    return {summary,severity:'major'};
  }
  const references=new Map(options.voiceWindows.map(row=>[row.clip,row]));
  for(const clip of clips) {
    const asset=assets.get(clip.assetId),s=asset?.source||{},actual=asset&&await options.verifiedHash(asset);
    const row=references.get(clip.id),windows=row?.windows?.filter(w=>w.similarity>=.65&&Math.abs(w.offset)<=.18)||[];
    const inMix=!!(actual&&row?.sourceHash===actual&&windows.length&&!row.dropouts?.length);
    const clone=s.mode==='clone'&&expectedReference&&s.referenceHash===expectedReference&&(!voiceId||s.voiceId===voiceId)&&
      reference?.source?.consent===true&&(!settings.referenceHash||settings.referenceHash===expectedReference)&&
      (!settings.voiceLibraryId||reference.source.sourceVoice===settings.voiceLibraryId)&&(!s.generatedHash||s.generatedHash===actual);
    const own=selection==='user'&&(settings.voiceMode==='import'&&(!settings.narrationAssetId||settings.narrationAssetId===asset?.id)||
      original&&(clip.track==='video'||!s.mode)||settings.voiceMode==='system'&&s.mode==='system'||
      settings.voiceMode==='preset'&&(s.mode==='preset'||s.voiceMode==='preset')||settings.voiceMode==='clone'&&clone);
    const matched=Boolean(clone&&receipt?.voice?.status==='matched'&&receipt.voice.referenceHash===expectedReference);
    const preset=s.mode==='preset'||s.voiceMode==='preset'||s.preset;
    const rate=Number(s.speechRate),raw=s.baseSha256&&project.assets.find(a=>a.sha256===s.baseSha256);
    const rawVerified=raw&&await options.verifiedHash(raw),base=raw?rawVerified&&await options.actualDuration(raw):Number(s.baseDuration);
    const measured=Number(s.measuredSeconds),duration=actual&&Number.isFinite(rate)?await options.actualDuration(asset):null;
    const produced=measured>0?measured:rawVerified?duration:null;
    const effectiveRate=Number.isFinite(rate)?rate*(clip.speed??1):null;
    const renderedRatio=base>0&&produced>0?base/produced:null;
    const paceMeasured=effectiveRate!=null&&renderedRatio!=null&&Math.abs(renderedRatio-rate)<=Math.max(.075,rate*.06)&&
      Number.isFinite(duration)&&Math.abs(produced-duration)<=Math.max(.1,.027*duration)&&Boolean(s.tempoMethod);
    const speedVerified=paceMeasured&&Math.abs(effectiveRate-policy.speed)<=.035;
    summary.sources.push({clipId:clip.id,assetId:clip.assetId,fromFrame:clip.start,toFrame:endOf(clip),sha256:actual||null,
      mode:s.mode||s.voiceMode||(original?'original':settings.voiceMode),voiceId:s.voiceId||s.speaker||s.preset||null,referenceHash:s.referenceHash||null,model:s.model||null,
      identity:own?'user-selected':matched?'matched':s.mode==='system'?'system-default':preset?'preset-preview':'unverified',sourceInMix:inMix,
      matchedWindows:windows.length,effectiveRate,renderedRatio,paceMeasured,speedVerified,
      paceEvidence:paceMeasured?(rawVerified?'baseline-and-final-files':'generation-duration-and-final-file'):'unverified'});
  }
  const rows=summary.sources;
  if(selection==='user'&&settings.voiceMode==='import'&&settings.narrationAssetId&&!clips.some(c=>c.assetId===settings.narrationAssetId)){
    summary.status='wrong-selection';summary.reasons.push('成片在用的旁白与本期明确选中的录音不同。');
    return {summary,severity:'major'};
  }
  if(rows.some(r=>['system-default','preset-preview'].includes(r.identity))||selection==='preview'){
    summary.status='preview-only';summary.reasons.push('候选用了系统或试听占位音色，尚未关联本期确认的解说音色。');
  } else if(rows.some(r=>!['matched','user-selected'].includes(r.identity))) {
    summary.status='unverified';summary.reasons.push('所选风格要求使用本期确认的音色，当前参考录音、生成原件和有效轨道的身份未能完整对应。');
  }
  if(rows.some(r=>!r.sourceInMix)) {
    summary.status||='unverified';summary.reasons.push('部分旁白未能从可核对的原件匹配到成片混音。');
  }
  if(selection!=='user'&&rows.some(r=>!r.speedVerified)) {
    summary.status||='unverified';
    const verifiedRates=[...new Set(rows.filter(r=>!r.speedVerified).map(r=>Math.round(r.effectiveRate*100)/100))];
    summary.reasons.push(rows.filter(r=>!r.speedVerified).every(r=>r.paceMeasured)
      ?'文件时长与变速记录支持本版 '+verifiedRates.join(' / ')+' 倍试听，风格基准为 '+policy.speed+' 倍。'
      :'未能从原始时长、变速记录和最终音频核实有效语速。');
  }
  summary.status||=selection==='user'?'user-selected':'verified';
  return {summary,severity:summary.reasons.length?'unknown':null};
}

async function assessMusic(project,policy,receipt,selection,options) {
  const settings=project.settings||{},assets=new Map(project.assets.map(a=>[a.id,a]));
  const end=Math.max(0,...project.timeline.clips.filter(c=>c.enabled!==false&&!c.hidden).map(endOf));
  const summary={required:true,selection,preferredTitle:policy.title,reasons:[],ducking:{expected:policy.ducking},sources:[]};
  const off=settings.musicEnabled===false||settings.musicMode==='none';
  const bedTracks=project.timeline.clips.filter(c=>isMusicBed(c,assets.get(c.assetId)));
  const beds=bedTracks.filter(audible);
  if(off&&selection==='user'){
    Object.assign(summary,{status:'user-off',mixStatus:'not-requested',coverageFrames:0,windows:[]});
    if(bedTracks.length&&options.hasMix){
      // A stale render can retain music after a user mutes it. Probe the known source without changing the edit.
      const candidates=bedTracks.map(c=>({...c,gain:c.gain>0?c.gain:1}));
      const check=await measureMusicMix(project,candidates,{...options,ignoredControls:new Set(bedTracks.map(c=>c.id))});
      summary.windows=check.windows;
      if(check.mixStatus==='present'){
        summary.status='unexpected';summary.mixStatus='present';summary.reasons.push('本期已明确关闭配乐，所选曲目的波形仍在成片中。');
        return {summary,severity:'major',fromFrame:check.windows[0]?.fromFrame??0,toFrame:check.windows.at(-1)?.toFrame??end};
      }
      summary.mixStatus=check.mixStatus==='missing-in-samples'?'absent-in-samples':'unverified';
    }
    return {summary};
  }
  if(!beds.length||off) {
    summary.status=off?'unverified':'missing';summary.mixStatus='no-active-bed';summary.coverageFrames=0;summary.windows=[];
    summary.reasons.push(off?'工程已关闭音乐，旧设置未记录这是本期对风格配乐的明确选择。':'风格需要的器乐底未出现在有效音乐轨上。');
    return {summary,severity:off?'unknown':'major',fromFrame:0,toFrame:end};
  }
  const {music:receiptMusic}=receipt||{};
  const differentSelection=selection==='user'&&settings.musicAssetId&&!beds.some(c=>c.assetId===settings.musicAssetId);
  for(const assetId of new Set(beds.map(c=>c.assetId))) {
    const a=assets.get(assetId),s=a?.source||{},hash=a&&await options.verifiedHash(a);
    const linked=Boolean(hash&&receiptMusic?.assetId===assetId&&receiptMusic.sha256===hash);
    let identity='unverified',excerpt=null;
    if(hash&&s.parentAssetId&&s.parentAssetId!==assetId) {
      const parent=assets.get(s.parentAssetId),parentHash=parent&&await options.verifiedHash(parent);
      if(parentHash&&s.originalSha256===parentHash&&sameIdentity(policy,parent.source||{},parentHash)){
        excerpt=await verifyMusicExcerpt(a,parent,s.originalRangeSeconds,options);
      }
    }
    if(differentSelection)identity='different-selection';
    else if(hash&&selection==='user'&&(!settings.musicAssetId||settings.musicAssetId===assetId))identity='user-selected';
    else if(sameIdentity(policy,s,hash)||excerpt?.matched)identity='matched';
    else if(hash&&linked&&receiptMusic.status==='alternative'&&(s.license||s.rights)&&!s.bedStyle&&Number.isFinite(receiptMusic.sourceLUFS)&&Number.isFinite(receiptMusic.voiceLUFS))identity='licensed-alternative';
    else if(s.bedStyle||selection==='preview')identity='preview-only';
    summary.sources.push({assetId,title:s.title||s.name||a?.name||null,author:s.author||s.artist||null,license:s.license||s.rights||null,sha256:hash||null,identity,...(excerpt&&{excerpt})});
  }
  const result=await measureMusicMix(project,beds,options);
  Object.assign(summary,result);
  const through=summary.windows.filter(w=>w.status==='present').map(w=>w.gainDb).filter(Number.isFinite);
  summary.ducking.fixedInTimeline=beds.every(c=>c.ducking===false)&&new Set(beds.map(c=>c.gain??1)).size===1;
  summary.ducking.sampleGainRangeDb=through.length>1?[Math.min(...through),Math.max(...through)]:null;
  summary.gainReferenceLU=policy.targetDifferenceLU;
  summary.referenceSourceRangeSeconds=[policy.sourceStart,policy.sourceEnd];
  const clear=summary.windows.filter(w=>w.status==='present'&&w.similarity>=.75&&Number.isFinite(w.gainDb)).sort((a,b)=>a.gainDb-b.gainDb);
  const i=Math.max(1,Math.floor(clear.length*.2));
  // A repeated source-relative gain change is worth auditioning even if the saved switch says "fixed".
  // The mix bus or final mastering can affect this comparison. It cannot identify the responsible processor.
  const spread=clear.length>=4?clear.at(-1-i).gainDb-clear[i].gainDb:null;
  summary.ducking.observed=spread==null?'inconclusive':spread>3.5?'variation-in-samples':'consistent-in-samples';
  let severity=null,fromFrame=0,toFrame=end;
  if(summary.mixStatus==='missing-in-samples') {
    summary.status='missing';severity='major';
    const missing=summary.windows.filter(w=>w.status==='absent');fromFrame=missing[0]?.fromFrame??0;toFrame=missing.at(-1)?.toFrame??end;
    summary.reasons.push('对照原曲和同期其他声轨，成片在应有配乐的抽查窗口没有混入该曲。');
  } else if(summary.mixStatus!=='present') {
    summary.status='unverified';severity='unknown';summary.reasons.push('原曲在最终混音中的贡献没有得到可区分的波形证据。');
  }
  const gap=summary.gaps.find(g=>g.toFrame-g.fromFrame>project.profile.fps);
  if(gap&&selection!=='user'){
    summary.status='missing';severity='major';fromFrame=gap.fromFrame;toFrame=gap.toFrame;summary.reasons.push('风格要求的持续配乐在时间线上有超过一秒的空缺。');
  }
  if(summary.sources.some(s=>s.identity==='preview-only')) {
    summary.status||='preview-only';severity||='unknown';summary.reasons.push('当前使用工作台试听曲或通用占位配乐，尚未确认替代曲是否适合本期。');
  } else if(summary.sources.some(s=>s.identity==='unverified')) {
    summary.status||='unverified';severity||='unknown';summary.reasons.push('在用曲目与风格曲、本期所选曲目或获许可替代曲之间的关联无法核实。');
  }
  if(policy.ducking===false&&selection!=='user'&&!summary.ducking.fixedInTimeline){
    summary.status||='unverified';severity||='unknown';summary.reasons.push('音乐轨没有按该风格明确设置同一固定增益并关闭自动压低。');
  }
  if(policy.ducking===false&&selection!=='user'&&summary.ducking.observed==='variation-in-samples'){
    summary.status||='unverified';severity||='unknown';summary.reasons.push('原曲在多个成片窗口的有效增益有明显变化，需试听确认固定混音的效果。');
  }
  if(differentSelection){
    summary.status='wrong-selection';severity='major';
    summary.reasons.unshift('可听音乐轨实际使用的曲目与本期明确选择的曲目不同。');
  }
  summary.status||=selection==='user'?'user-selected':'verified';
  return {summary,severity,fromFrame,toFrame};
}

export async function reviewStyleAudio(project,style,options) {
  const policy=styleAudioPolicy(style);
  if(!policy||project.style&&(style.id!==project.style.id||Number(style.version)!==Number(project.style.version)))return null;
  if(policy.music){
    const resource=options.styleMusicResource;
    const declared=style.audioBlueprint?.music?.sha256||style.reproduction_blueprint?.audio?.music?.sha256;
    policy.music.sha256=resource?.verified===true&&resource.available===true?resource.sha256:declared||null;
  }
  const saved=project.styleAudio,receipt=saved?.styleId===style.id&&Number(saved.styleVersion)===Number(style.version)?saved:null;
  const end=Math.max(0,...project.timeline.clips.filter(c=>c.enabled!==false&&!c.hidden).map(endOf));
  const evidence={styleId:style.id,styleVersion:style.version},findings=[],hashes=new Map();
  const durations=new Map();
  async function actualDuration(asset){
    if(!durations.has(asset.path))durations.set(asset.path,options.probeDuration(asset.path).catch(error=>{
      if(options.signal?.aborted)throw error;return null;
    }));
    return durations.get(asset.path);
  }
  async function verifiedHash(asset) {
    if(!asset?.path||!asset.sha256)return null;
    if(!hashes.has(asset.path))hashes.set(asset.path,options.hashFile(asset.path).catch(()=>null));
    const observed=await hashes.get(asset.path);return asset.sha256===observed?observed:null;
  }
  for(const [key,assess,fix] of [
    ['voice',assessVoice,'试听该段。确认使用本期音色，或选择有授权的参考录音重新合成。'],
    ['music',assessMusic,'试听标出的段落，确认本期曲目与混音后重新导出。']
  ]) {
    if(!policy[key])continue;
    const selection=audioSelection(project,key);
    const {summary,severity,fromFrame=0,toFrame=end}=await assess(project,policy[key],receipt,selection,{...options,verifiedHash,actualDuration});
    evidence[key]=summary;
    if(severity)findings.push(finding(key,severity,summary.reasons.join(' '),fix,fromFrame,toFrame));
  }
  return {evidence,findings};
}
