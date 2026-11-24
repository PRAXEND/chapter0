// Timeline intervals in this report are half-open. Source intervals use seconds on the identified original.
import {compositionOrder, visiblePanes, normalizedViewport} from './viewport.mjs';
import {transitionEnvelope} from './framing.mjs';
import {motionPolicy, shotFingerprint} from './director-visual.mjs';
import {isMusicBed} from './music-evidence.mjs';

const end=c=>c.start+c.duration;
const active=c=>c.enabled!==false&&!c.hidden&&Number.isInteger(c.start)&&Number.isInteger(c.duration)&&c.duration>0;
const audible=c=>!c.muted&&(c.gain??1)>0;
const round=n=>Math.round(n*10000)/10000;
const short=(s,n=140)=>typeof s==='string'?s.slice(0,n):undefined;
function counts(values){
  const tally=new Map();
  for(const value of values)tally.set(value,(tally.get(value)||0)+1);
  return Object.fromEntries(tally);
}
function sample(rows,limit=12){
  if(rows.length<=limit)return rows;
  return Array.from({length:limit},(_,i)=>rows[Math.round(i*(rows.length-1)/(limit-1))]);
}
function page(url){
  try{
    const u=new URL(url);
    if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return;
    for(const k of [...u.searchParams.keys()])if(/token|signature|credential|^x-amz-|^x-goog-|^key$/i.test(k))u.searchParams.delete(k);
    u.hash='';return u.href;
  }catch{return;}
}
function provenance(a){
  const s=a.source||{};
  return {assetId:a.id,kind:a.kind,title:short(s.title||a.name),sha256:a.sha256,
    url:page(s.url),credit:short(s.credit||s.author),provider:short(s.provider),date:short(s.date),license:short(s.license||s.rights),
    ...(s.parentAssetId&&{parentAssetId:s.parentAssetId,parentHash:s.parentHash||s.parentSha256,sourceSeconds:s.sourceSeconds})};
}

// Unlike an archive page that may list hundreds of films, a content fingerprint or exact media resource
// can tie different imports together. A trimmed derivative needs an explicit original-clock offset.
function identity(a,assets){
  if(!a)return [];
  const s=a.source||{},parent=assets.get(s.parentAssetId),origin=s.parentSha256||s.parentHash||parent?.sha256;
  const derived=!!(s.parentAssetId||s.parentHash||s.parentSha256);
  const keys=[{key:'asset:'+a.id,via:'asset-id',offset:0}];
  if(a.sha256)keys.unshift({key:'hash:'+a.sha256,via:'file-sha256',offset:0});
  if(origin&&Number.isFinite(s.sourceInSeconds)&&s.sourceInSeconds>=0)
    keys.push({key:'hash:'+origin,via:'parent-range',offset:s.sourceInSeconds});
  if(!derived){
    const raw=s.originalUrl||s.downloadUrl;
    // Redacted query strings are suitable for display only, never for inferring a shared identity.
    const direct=raw&&page(raw);
    const containsCredentials=typeof raw==='string'&&/[?&](?:[^=&#]*token|[^=&#]*signature|x-amz-[^=&#]*|x-goog-[^=&#]*|credential|key)=/i.test(raw);
    if(direct&&!containsCredentials)keys.push({key:'media:'+direct,via:'original-media-url',offset:0,duration:a.duration});
  }
  return keys;
}
function sourceMatch(a,b){
  for(const x of a.ids)for(const y of b.ids){
    if(x.key!==y.key)continue;
    if(x.via==='original-media-url'&&a.kind==='video'&&
       (!Number.isFinite(x.duration)||!Number.isFinite(y.duration)||Math.abs(x.duration-y.duration)>.1))continue;
    return {via:x.via==='parent-range'||y.via==='parent-range'?'parent-range':x.via,left:x.offset,right:y.offset};
  }
}

// A clip that is entering through a dissolve is not yet an opaque cover. Preserve the two sources of
// full-screen transitions and the exposed layers of inset compositions, as in media.mjs.
function shown(activeShots,profile,at){
  const fading=c=>at<c.start+transitionEnvelope(c).duration;
  if(!activeShots.length)return [];
  const lastOpaque=activeShots.findLastIndex(({clip})=>{
    const r=normalizedViewport(clip.viewport,profile);
    return r.width===1&&r.height===1&&!fading(clip);
  });
  const stack=activeShots.slice(Math.max(0,lastOpaque));
  if(!stack.some(s=>s.clip.viewport))return (fading(stack.at(-1).clip)?stack.slice(-2):stack.slice(-1)).map(shot=>({shot}));
  if(!stack.some(s=>fading(s.clip)))return visiblePanes(stack,profile);
  return stack.flatMap((shot,i)=>{
    const covers=stack.slice(i+1).filter(s=>!fading(s.clip));
    return visiblePanes([shot,...covers],profile).filter(p=>p.shot===shot);
  });
}

function pictureTiming(clips,assets,profile,frames){
  const shots=compositionOrder(clips.filter(c=>c.track==='video')).map(clip=>({clip,asset:assets.get(clip.assetId)}));
  const edges=[...new Set([0,frames,...shots.flatMap(({clip})=>[clip.start,clip.start+transitionEnvelope(clip).duration,end(clip)])])].sort((a,b)=>a-b);
  const spans=[],exposures=new Map(),gaps=[],coverage={videoFrames:0,stillFrames:0,mixedFrames:0,unknownFrames:0,gapFrames:0};
  for(let i=0;i<edges.length-1;i++){
    const from=edges[i],to=edges[i+1],layers=shown(shots.filter(s=>s.clip.start<=from&&end(s.clip)>from),profile,from);
    const size=to-from,kinds=new Set(layers.map(l=>l.shot.asset?.kind));
    if(kinds.has('video'))coverage.videoFrames+=size;
    if(kinds.has('image'))coverage.stillFrames+=size;
    if(kinds.has('video')&&kinds.has('image'))coverage.mixedFrames+=size;
    if(layers.some(l=>!['image','video'].includes(l.shot.asset?.kind)))coverage.unknownFrames+=size;
    if(!layers.length){
      coverage.gapFrames+=size;
      const previous=gaps.at(-1);
      if(previous?.toFrame===from)previous.toFrame=to;else gaps.push({fromFrame:from,toFrame:to});
    }
    const span={fromFrame:from,toFrame:to,clipIds:layers.map(l=>l.shot.clip.id),assetIds:layers.map(l=>l.shot.clip.assetId)};
    const last=spans.at(-1);
    if(last&&last.clipIds.length===span.clipIds.length&&last.clipIds.every((v,i)=>v===span.clipIds[i]))last.toFrame=to;
    else spans.push(span);
    for(const {shot} of layers){
      const {clip,asset}=shot;
      if(!exposures.has(clip.id))exposures.set(clip.id,[]);
      const windows=exposures.get(clip.id),prev=windows.at(-1);
      if(prev?.toFrame===from){prev.toFrame=to;continue;}
      windows.push({clipId:clip.id,assetId:clip.assetId,kind:asset?.kind||'unknown',fromFrame:from,toFrame:to,clip,
        ids:identity(asset,assets)});
    }
  }
  const windows=[...exposures.values()].flat().sort((a,b)=>a.fromFrame-b.fromFrame);
  for(const w of windows)if(w.kind==='video'){
    const seconds=f=>((w.clip.sourceIn??0)+(f-w.clip.start)*(w.clip.speed??1))/profile.fps;
    w.sourceFrom=seconds(w.fromFrame);w.sourceTo=seconds(w.toFrame);
  }
  for(const gap of gaps)gap.overlays=Object.keys(counts(clips.filter(c=>['graphic','caption'].includes(c.track)&&c.start<gap.toFrame&&end(c)>gap.fromFrame).map(c=>c.track)));
  return {spans,windows,coverage,gaps};
}
function publicWindow(w){
  return {clipId:w.clipId,assetId:w.assetId,fromFrame:w.fromFrame,toFrame:w.toFrame,
    ...(Number.isFinite(w.sourceFrom)&&{sourceFrom:round(w.sourceFrom),sourceTo:round(w.sourceTo)}),
    ...(w.clip.viewport&&{viewport:w.clip.viewport}),...(w.clip.framing&&{framing:w.clip.framing}),...(w.clip.locked&&{locked:true}),
    ...(w.clip.transition?.duration&&{transition:w.clip.transition.type})};
}
function repetitions(windows,first,last){
  const stillGroups=[],overlaps=[];
  let overlapCount=0;
  const films=windows.filter(w=>w.kind==='video');
  for(const w of windows.filter(w=>w.kind==='image')){
    const group=stillGroups.find(g=>sourceMatch(g[0],w));
    if(group)group.push(w);else stillGroups.push([w]);
  }
  for(let i=0;i<films.length;i++)for(let j=i+1;j<films.length;j++){
    const a=films[i],b=films[j];
    if(a.clipId===b.clipId)continue;
    const same=sourceMatch(a,b);
    if(!same)continue;
    const from=Math.max(a.sourceFrom+same.left,b.sourceFrom+same.right),to=Math.min(a.sourceTo+same.left,b.sourceTo+same.right);
    if(to-from<.000001)continue;
    overlapCount++;
    if(overlaps.length<12)overlaps.push({assetIds:[a.assetId,b.assetId],clipIds:[a.clipId,b.clipId],atFrames:[a.fromFrame,b.fromFrame],
      sourceFrom:round(from),sourceTo:round(to),via:same.via,concurrent:a.fromFrame<b.toFrame&&b.fromFrame<a.toFrame});
  }
  const repeated=stillGroups.filter(g=>g.length>1).map(g=>{
    const assetIds=[...new Set(g.map(w=>w.assetId))];
    let coveredUntil=-1;
    const entrances=[];
    for(const w of g){
      if(w.fromFrame>coveredUntil)entrances.push(w.fromFrame);
      coveredUntil=Math.max(coveredUntil,w.toFrame);
    }
    return {assetIds,placements:new Set(g.map(w=>w.clipId)).size,appearances:entrances.length,
      atFrames:sample(entrances,6),openingAndClosing:g.some(w=>w.fromFrame===first?.fromFrame)&&g.some(w=>w.toFrame===last?.toFrame)};

  });
  return {repeatedStillCount:repeated.length,repeatedStills:sample(repeated),overlapCount,overlappingSourceWindows:overlaps};
}

function picturePolicy(project,visual){
  // Reuse the same full-project/negation parser as the director. A neutral project has no implicit
  // video-first requirement, but an express still-only brief remains a fact about this cut.
  const rule={rules:[{id:'video-first'}]},explicit=project.settings?.visualRequirements?.motionFootage;
  const base=motionPolicy(rule,project),direction=project.visualDirection;
  const saved=direction?.timelineHash&&direction.timelineHash===shotFingerprint(project)?direction.motion?.policy:null;
  if(explicit===true)return 'video-first';
  if(visual?.styleExecution?.override==='user-message'&&saved)return saved;
  if(['images-only','photo-led'].includes(base))return base;
  if(saved)return saved;
  return visual?.styleExecution?.ruleId==='video-first'||visual?.requirements?.motionFootage?'video-first':'unspecified';
}
const subset=(record,keys)=>Object.fromEntries(keys.filter(k=>record?.[k]!==undefined).map(k=>[k,record[k]]));
function audioFeedback(project,clips,assets,evidence){
  const voiceQA=evidence?.styleAudio?.voice,musicQA=evidence?.styleAudio?.music;
  const stems=evidence?.audio||[],voices=clips.filter(c=>c.track==='narration');
  const originals=project.settings?.voiceMode==='original'&&!voices.length?clips.filter(c=>c.track==='video'&&assets.get(c.assetId)?.hasAudio):[];
  const voiceRows=[...voices,...originals].map(c=>{
    const asset=assets.get(c.assetId),meta=asset?.source||{},row=voiceQA?.sources?.find(s=>s.clipId===c.id&&(!s.sha256||s.sha256===asset?.sha256));
    const stem=stems.find(s=>s.clip===c.id&&s.sourceHash===asset?.sha256);
    const windows=stem?.windows||[];
    return {clipId:c.id,assetId:c.assetId,mode:row?.mode||meta.mode||(originals.includes(c)?'original':'unrecorded'),
      voiceId:row?.voiceId||meta.voiceId||meta.preset||meta.speaker,identity:row?.identity,enabled:audible(c),
      mixSamples:windows.length,matchedWindows:row?.matchedWindows??windows.filter(w=>w.similarity>=.65).length,
      ...(row?.paceMeasured&&{measuredRate:row.effectiveRate}),...(stem?.dropouts?.length&&{dropouts:stem.dropouts.length})};
  });
  const music=clips.filter(c=>isMusicBed(c,assets.get(c.assetId))),effects=clips.filter(c=>c.track==='music'&&!isMusicBed(c,assets.get(c.assetId)));
  const musicWindows=musicQA?.windows||[];
  const gains=musicWindows.filter(w=>w.status==='present'&&Number.isFinite(w.gainDb)).map(w=>w.gainDb);
  return {
    voice:{requested:project.settings?.voiceMode,status:voiceQA?.status||'not-assessed',selection:voiceQA?.selection,clips:voiceRows.length,
      matchedWindows:voiceRows.reduce((n,r)=>n+r.matchedWindows,0),sources:sample(voiceRows,10)},
    effects:{clips:effects.length,enabledClips:effects.filter(audible).length,
      ...(project.settings?.sceneSound===false&&{disabledByProject:true}),mixStatus:'not-sampled',
      events:sample(effects.map(c=>({clipId:c.id,atFrame:c.start,role:c.templateRole||c.role||'sfx',title:short(assets.get(c.assetId)?.name),enabled:audible(c)})),8)},
    music:{clips:music.length,enabledClips:music.filter(audible).length,requestedMode:project.settings?.musicMode,
      titles:[...new Set(music.map(c=>{const a=assets.get(c.assetId);return short(a?.source?.title||a?.name);}).filter(Boolean))].slice(0,8),
      status:musicQA?.status||'not-assessed',mixStatus:musicQA?.mixStatus||'not-sampled',selection:musicQA?.selection,
      sampleCounts:counts(musicWindows.map(w=>w.status)),...(gains.length&&{sampleGainRangeDb:[Math.min(...gains),Math.max(...gains)]}),
      ...(musicQA?.ducking&&{ducking:subset(musicQA.ducking,['expected','fixedInTimeline','observed'])})}
  };
}

export function cutFeedback(project,qa){
  const clips=project.timeline.clips.filter(active),profile=project.profile,fps=profile.fps;
  const frames=clips.reduce((n,c)=>Math.max(n,end(c)),0),assets=new Map(project.assets.map(a=>[a.id,a]));
  const linked=Number.isSafeInteger(project.revision)&&qa?.revision===project.revision;
  const evidence=linked?qa.evidence:undefined,visual=evidence?.visual;
  const {spans,windows,coverage,gaps}=pictureTiming(clips,assets,profile,frames);
  const opening=spans.at(0)||null,closing=spans.at(-1)||null;
  const repeats=repetitions(windows,opening,closing);
  const visible=sample(windows,20);
  const usage=new Map();
  for(const span of spans)for(const id of new Set(span.assetIds))usage.set(id,(usage.get(id)||0)+span.toFrame-span.fromFrame);
  const mostUsed=[...usage].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([id])=>id);
  const ids=new Set([...mostUsed,...visible.map(w=>w.assetId),...(opening?.assetIds||[]),...(closing?.assetIds||[]),
    ...repeats.repeatedStills.flatMap(g=>g.assetIds),...repeats.overlappingSourceWindows.flatMap(x=>x.assetIds)]);
  const graphics=clips.filter(c=>c.track==='graphic'),motion=visual?.motion||[],style=visual?.styleExecution;
  const graphicIds=new Set(graphics.map(c=>c.id));
  const parity=(evidence?.compositeParity?.checks||[]).filter(c=>graphicIds.has(c.clipId));
  const issues=linked?qa.issues||[]:[];
  return {revision:project.revision,fps,frames,durationSeconds:round(frames/fps),targetSeconds:project.settings?.targetDuration,
    review:{link:linked?'same-revision':qa?'different-or-unknown-revision':'not-reviewed',
      ...(linked&&{status:qa.status,candidatePlayable:qa.candidatePlayable,sha256:qa.artifactSha256,measuredSeconds:evidence?.duration}),
      issueCount:issues.length,issues:sample(issues.map(i=>({id:i.id,severity:i.severity,message:short(i.message,240),
        ...(Number.isInteger(i.fromFrame)&&Number.isInteger(i.toFrame)&&{fromFrame:i.fromFrame,toFrame:i.toFrame+1})})),10),
      limitations:linked?sample((qa.limitations||[]).map(s=>short(s,220)),3):[]},
    picture:{policy:picturePolicy(project,visual),coverage,opening,closing,sourceCount:new Set(windows.map(w=>w.assetId)).size,
      sources:[...ids].map(id=>assets.get(id)).filter(Boolean).map(a=>({...provenance(a),visibleFrames:usage.get(a.id)})),
      windowCount:windows.length,windows:visible.map(publicWindow),...repeats,gapCount:gaps.length,gaps:sample(gaps),
      ...(visual?.endingSource&&{endingEvidence:{...subset(visual.endingSource,['status','request','assetId','sameAsAnnotatedSource']),
        samples:(visual.endingSource.frames||[]).map(f=>({frame:f.frame,matched:f.matched}))}}),
      motionSamples:{windows:motion.length,results:counts(motion.map(m=>m.result)),...subset(visual?.motionCoverage,['changingFrames','sampledVideoFrames','informativeFrames','confirmedStationaryFrames']),
        ...subset(style,['motionStatus','assessment','override']),samples:sample(motion.map(m=>({assetId:m.assetId,fromFrame:m.fromFrame,toFrame:m.toFrame+1,result:m.result})),5)}},
    graphics:{componentCounts:counts(graphics.filter(c=>c.motion).map(c=>c.motion.componentId)),ordinaryCount:graphics.filter(c=>!c.motion).length,
      roles:counts(graphics.filter(c=>!c.motion).map(c=>c.templateRole||c.shape||(c.text?'text':'unspecified'))),
      ...subset(visual?.explanatoryAnimation,['actionFrames']),confirmedSteps:visual?.confirmedSteps?.length,
      previewExportSamples:counts(parity.map(c=>c.matches===true?'match':c.matches===false?'different':'unknown'))},
    audio:audioFeedback(project,clips,assets,evidence)};
}
