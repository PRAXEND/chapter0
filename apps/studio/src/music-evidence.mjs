// Independent final-mix samples. Nuisance stems (speech, original sound, effects)
// are removed from both the candidate and the expected bed before comparison.
const sampleRate=4000;
const round=n=>Math.round(n*1000)/1000;
const active=c=>c.enabled!==false&&!c.hidden&&!c.muted&&(c.gain??1)>0;
const power=(a,b=a)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]*b[i];return sum;};
const shifted=(samples,lag,n)=>Float64Array.from({length:n},(_,i)=>samples[i+lag]||0);
function remove(a,b) {
  const factor=power(a,b)/Math.max(1e-18,power(b));
  for(let i=0;i<a.length;i++)a[i]-=factor*b[i];
}
function residual(a,basis) { const v=Float64Array.from(a);for(const b of basis)remove(v,b);return v; }
function bestOffset(dry,wet,n) {
  let best=-Infinity,offset=0;
  // Container time bases and 4 kHz resampling can differ by a few samples.
  for(let j=-3;j<=3;j++){
    const v=shifted(dry,j,n),score=power(wet,v)/Math.sqrt(Math.max(1e-15,power(v)));
    if(score>best){best=score;offset=j;}
  }
  return offset;
}
function contribution(bed,mix,others,plannedGain) {
  const n=Math.min(bed.length,mix.length);
  if(n<sampleRate*.22)return {status:'unverified',reason:'short-window'};
  const wet=mix.subarray(0,n),wetResidual=Float64Array.from(wet),basis=[];
  let foregroundPower=0;
  for(const dry of others) {
    const move=bestOffset(dry,wetResidual,n),u=residual(shifted(dry,move,n),basis),energy=power(u);
    if(energy/n<1e-10)continue;
    const factor=power(wetResidual,u)/energy;
    foregroundPower+=energy*factor*factor;
    remove(wetResidual,u);basis.push(u);
  }
  let best=null;
  for(let lag=-3;lag<=3;lag++) {
    const original=shifted(bed,lag,n),dryEnergy=power(original),v=residual(original,basis),vEnergy=power(v);
    if(dryEnergy/n<1e-8||vEnergy<.05*dryEnergy)continue;
    const wetEnergy=power(wetResidual),joint=power(v,wetResidual);
    const similarity=joint/Math.sqrt(Math.max(1e-18,vEnergy*wetEnergy));
    const gain=joint/vEnergy;
    if(!best||similarity>best.similarity)best={similarity,gain,dryEnergy,wetEnergy,vEnergy};
  }
  if(!best)return {status:'unverified',reason:'silent-or-indistinguishable-stem'};
  const {similarity,gain,wetEnergy,vEnergy,dryEnergy}=best;
  const noiseRelativeToPlan=Math.sqrt(wetEnergy/vEnergy)/plannedGain;
  const status=similarity>=.59&&gain>.012*plannedGain?'present'
    :gain<.14*plannedGain&&noiseRelativeToPlan<.28?'absent':'unverified';
  return {status,similarity:round(similarity),measuredGain:round(gain),plannedGain:round(plannedGain),
    ...(gain>0&&{gainDb:round(20*Math.log10(gain))}),
    ...(foregroundPower>1e-7&&gain>0&&{foregroundAboveBedDb:round(10*Math.log10(foregroundPower/(dryEnergy*gain*gain)))}),
    residualRelativeToPlannedBed:round(noiseRelativeToPlan)};
}
export function musicCoverage(rows,end) {
  let cursor=0,covered=0;
  const gaps=[];
  for(const c of [...rows].sort((a,b)=>a.start-b.start)) {
    if(c.start>=end)continue;
    const until=Math.min(end,c.start+c.duration);
    if(c.start>cursor)gaps.push({fromFrame:cursor,toFrame:c.start});
    covered+=Math.max(0,until-Math.max(cursor,c.start));cursor=Math.max(cursor,until);
  }
  if(cursor<end)gaps.push({fromFrame:cursor,toFrame:end});
  return {coverageFrames:covered,gaps};
}
function sampleRanges(beds,clips,end,fps) {
  const cuts=new Set([0,end]);
  for(const c of [...beds,...clips]){if(c.start>=end)continue;cuts.add(c.start);cuts.add(Math.min(end,c.start+c.duration));}
  const ordered=[...cuts].sort((a,b)=>a-b),ranges=[];
  for(let i=1;i<ordered.length;i++) {
    const a=ordered[i-1],b=ordered[i],length=b-a;
    if(length<Math.max(4,.28*fps))continue;
    const target=beds.filter(c=>c.start<=a&&c.start+c.duration>=b);
    if(!target.length)continue;
    const count=Math.min(4,Math.max(1,Math.ceil(length/(fps*1.25))));
    const frames=Math.min(Math.round(.72*fps),Math.max(1,Math.floor(length/count*.8)));
    for(let k=0;k<count;k++) {
      const fromFrame=a+Math.floor(length*(k+.5)/count-frames/2);
      ranges.push({fromFrame,toFrame:fromFrame+frames,target});
    }
  }
  const max=12;
  return ranges.length<=max?ranges:Array.from({length:max},(_,i)=>ranges[Math.round(i*(ranges.length-1)/(max-1))]);
}
export async function measureMusicMix(project,beds,{readPcm,verifiedHash,videoPath,hasMix,signal,ignoredControls}) {
  const assets=new Map(project.assets.map(a=>[a.id,a])),fps=project.profile.fps;
  const end=Math.max(0,...project.timeline.clips.filter(c=>c.enabled!==false&&!c.hidden).map(c=>c.start+c.duration));
  const foreground=project.timeline.clips.filter(c=>active(c)&&!beds.includes(c)&&!ignoredControls?.has(c.id)&&
    (c.track==='narration'||c.track==='music'||c.track==='video'&&assets.get(c.assetId)?.hasAudio));
  const evidence={method:'source-and-final-mix-partial-correlation',sampleRate,interval:'half-open-frames',windows:[],...musicCoverage(beds,end)};
  const matches=new Map();
  async function dry(clip,fromFrame,toFrame) {
    const asset=assets.get(clip.assetId);
    if(!asset?.path||!asset.sha256||!await verifiedHash(asset))return null;
    // Retimed audio uses pitch-preserving overlap/add. A simple dry-file seek
    // cannot reproduce that phase. Report the uncertainty when a retimed layer overlaps.
    if((clip.speed??1)!==1)return null;
    const at=((clip.sourceIn||0)+fromFrame-clip.start)/fps,length=(toFrame-fromFrame)/fps;
    const key=JSON.stringify([asset.path,at,length]);
    if(!matches.has(key))matches.set(key,readPcm(asset.path,at,length));
    return matches.get(key);
  }
  for(const {fromFrame,toFrame,target} of sampleRanges(beds,foreground,end,fps)) {
    if(signal?.aborted)throw signal.reason;
    const bed=target[0],hash=assets.get(bed.assetId)?.sha256;
    const record={fromFrame,toFrame,assetId:bed.assetId,clipId:bed.id,sourceHash:hash||null,
      sourceStart:((bed.sourceIn||0)+(fromFrame-bed.start)*(bed.speed??1))/fps,
      sourceEnd:((bed.sourceIn||0)+(toFrame-bed.start)*(bed.speed??1))/fps};
    try {
      if(!hasMix)Object.assign(record,{status:'absent',reason:'no-audio-stream'});
      else if(target.length!==1)Object.assign(record,{status:'unverified',reason:'overlapping-beds'});
      else {
        const controls=foreground.filter(c=>c.start<toFrame&&c.start+c.duration>fromFrame);
        if(controls.length>8){evidence.windows.push({...record,status:'unverified',reason:'overlapping-source-limit'});continue;}
        const [stem,wet,...other]=await Promise.all([dry(bed,fromFrame,toFrame),
          readPcm(videoPath,fromFrame/fps,(toFrame-fromFrame)/fps),...controls.map(c=>dry(c,fromFrame,toFrame))]);
        if(!stem||other.some(v=>!v))Object.assign(record,{status:'unverified',reason:'source-missing-or-retimed'});
        else Object.assign(record,contribution(stem,wet,other,bed.gain??1));
      }
    } catch(error) {
      if(signal?.aborted)throw error;
      Object.assign(record,{status:'unverified',reason:'read-failed'});
    }
    evidence.windows.push(record);
  }
  const present=evidence.windows.filter(w=>w.status==='present'),missing=evidence.windows.filter(w=>w.status==='absent');
  evidence.sampledFrames=evidence.windows.reduce((sum,w)=>sum+w.toFrame-w.fromFrame,0);
  evidence.mixStatus=missing.length>=2||!hasMix&&beds.length?'missing-in-samples'
    :!missing.length&&present.length>=Math.min(2,evidence.windows.length)&&present.length>0&&present.length>=evidence.windows.length*.67?'present':'unverified';
  return evidence;
}

export function isMusicBed(clip,asset) {
  const effects=['sfx','effect','action-sound','reveal-sound'];
  return clip.track==='music'&&![clip.role,clip.templateRole,asset?.source?.role,asset?.source?.kind].some(value=>effects.includes(value));
}

// A WAV excerpt may have a different container, level and edge fades from its licensed master.
// Verify the declared edit against the master, independently of the final-mix comparison.
export async function verifyMusicExcerpt(asset,parent,range,{readPcm,signal}) {
  if(!Array.isArray(range)||range.length!==2||!range.every(Number.isFinite)||range[0]<0||range[1]<=range[0]||
    !Number.isFinite(parent.duration)||range[1]>parent.duration+.08||
    !Number.isFinite(asset.duration)||Math.abs((range[1]-range[0])-asset.duration)>.12)return null;
  const duration=asset.duration,length=Math.min(.64,duration*.16);
  if(length<.25)return null;
  const windows=[];
  for(const fraction of [.19,.5,.81]) {
    const t=fraction*duration-length/2;
    try{
      const [original,edited]=await Promise.all([readPcm(parent.path,range[0]+t,length),readPcm(asset.path,t,length)]);
      const n=Math.min(original.length,edited.length)-64;
      if(n<400)return null;
      let best=-1;
      const y=edited.subarray(32,32+n);
      for(let lag=-24;lag<=24;lag++) {
        const x=original.subarray(32+lag,32+lag+n),xy=power(x,y),xx=power(x),yy=power(y);
        if(xx/n>1e-8&&yy/n>1e-8)best=Math.max(best,xy/Math.sqrt(xx*yy));
      }
      windows.push({at:t,originalAt:range[0]+t,seconds:length,similarity:round(best)});
    }catch(error){if(signal?.aborted)throw error;return null;}
  }
  return {parentAssetId:parent.id,parentSha256:parent.sha256,range,windows,matched:windows.every(w=>w.similarity>=.94)};
}
