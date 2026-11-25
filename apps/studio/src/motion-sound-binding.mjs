import {createHash} from 'node:crypto';
import {motionCatalog,motionCues} from './motion-components.mjs';
import {motionSoundEvents,soundResources,supportsSound,materializeStyleSound} from './style-sounds.mjs';

const stableId=(owner,key)=>'sfx-'+createHash('sha256').update(JSON.stringify([owner,key])).digest('hex').slice(0,24);
const conflict=()=>{throw Object.assign(Error('关联音效已锁定，先解锁或保留当前落点。'),{status:409});};
function eventsFor(owner,project){
  const design=owner.soundDesign||{},fps=project.profile.fps,style=project.style;
  if(!style||style.version!==8||design.enabled===false||project.settings?.sceneSound===false||
     project.mode==='interview'&&design.enabled!==true&&project.settings?.sceneSound!==true)return [];
  const spec=motionCatalog.find(s=>s.id===owner.motion?.componentId);
  const events=[];
  const event=(key,id,offset,role)=>{
    const resourceId=design.resourceId||id;
    if(!supportsSound(style,resourceId)||design.suppressed?.includes(key))return;
    events.push({owner,key,role,resourceId,anchorFrame:owner.start+offset});
  };
  if(spec && spec.styleId===style.id){
    const cues=owner.motion.cueFrames??motionCues(spec,owner.duration,fps,owner.motion.props);
    const sounds=motionSoundEvents[spec.id]||[];
    for(const [id,index] of sounds)event('cue-'+index,id,cues[index]??0,'reveal-sound');
    if(!sounds.length&&design.enabled===true)event('cue-0','tiny-pop',0,'reveal-sound');
  }
  if(owner.track==='video'&&style.id==='henry-hot-news'){
    for(const [i,fx] of (owner.pictureEffects||[]).entries())if(fx.type==='camera-shake'&&!fx.phaseFrames)
      event('shake-'+i,'synthetic-pop',fx.offsetFrames??0,'action-sound');
  }
  if(owner.track==='video'&&owner.transition?.duration>0&&!owner.transition.offsetFrames &&
    ['whip-pan','organic-dissolve','wipe-right','crossfade','dissolve','fade'].includes(owner.transition.type)){
    event('transition',style.id==='henry-hot-news'?'deep-whoosh':'airy-whoosh',0,'transition-sound');
  }
  return events;
}
const relevant=c=>JSON.stringify([c.start,c.duration,c.motion,c.pictureEffects,c.transition,c.soundDesign,c.hidden,c.muted,c.enabled]);
const enabled=c=>!c.muted&&!c.hidden&&c.enabled!==false;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function syncMotionSounds(project,before,commands,assetDirectory,actor,reconcileAll=false) {
  const clips=project.timeline.clips,previous=new Map(before.map(c=>[c.id,c]));
  const owners=new Map(clips.filter(c=>c.motion||c.pictureEffects||c.transition||c.soundDesign).map(c=>[c.id,c]));
  const touched=new Set(commands.filter(c=>c.op!=='lock').map(c=>c.id??c.clip?.id));
  const boundBefore=before.filter(c=>c.soundBinding);
  // An explicitly removed event stays removed after its picture is moved or edited.
  for(const old of boundBefore){
    const {ownerId,key}=old.soundBinding,owner=owners.get(ownerId),current=clips.find(c=>c.id===old.id);
    if(owner && !current && touched.has(old.id) && !touched.has(ownerId)){
      owner.soundDesign={...owner.soundDesign,suppressed:[...new Set([...(owner.soundDesign?.suppressed||[]),key])]};
    }
    const audioChange=commands.findLast(cmd=>cmd.op==='update' && cmd.id===old.id)?.changes;
    if(current?.soundBinding && typeof audioChange?.muted==='boolean'){
      current.soundBinding={...current.soundBinding,userMuted:audioChange.muted};
    }
    if(current && touched.has(old.id) && !touched.has(ownerId) && (current.start!==old.start||current.assetId!==old.assetId||current.sourceIn!==old.sourceIn||current.duration!==old.duration)){
      // A hand-trimmed or independently moved sound becomes ordinary editable project audio.
      if(owner)owner.soundDesign={...owner.soundDesign,suppressed:[...new Set([...(owner.soundDesign?.suppressed||[]),key])]};
      delete current.soundBinding;
    }
  }
  const changedOwners=new Set([...owners].filter(([id,c])=>reconcileAll||touched.has(id)&&(!previous.has(id)||relevant(c)!==relevant(previous.get(id)))).map(([id])=>id));
  for(const old of boundBefore)if(reconcileAll||!owners.has(old.soundBinding.ownerId)||touched.has(old.soundBinding.ownerId))changedOwners.add(old.soundBinding.ownerId);
  if(!changedOwners.size)return;
  const plans=new Map(),claimed=new Map(),collision=e=>e.anchorFrame+'|'+(e.owner.soundDesign?.assetId||e.resourceId);
  // Prefer the graphic at a shared impact; if it is removed, the remaining shake takes over.
  const affectedImpacts=new Set();
  for(const id of changedOwners){
    const old=previous.get(id);
    if(old)for(const e of eventsFor(old,project))affectedImpacts.add(collision(e));
  }
  for(const owner of [...owners.values()].sort((a,b)=>Number(Boolean(b.motion))-Number(Boolean(a.motion)))){
    for(const e of eventsFor(owner,project)){
      const key=collision(e);
      if(changedOwners.has(owner.id))affectedImpacts.add(key);
      if(enabled(owner)&&claimed.has(key))continue;
      if(enabled(owner))claimed.set(key,owner.id);
      plans.set(stableId(owner.id,e.key),e);
    }
  }
  for(const key of affectedImpacts)if(claimed.has(key))changedOwners.add(claimed.get(key));
  for(const old of boundBefore){
    const binding=old.soundBinding;
    if(affectedImpacts.has(old.actionFrame+'|'+(owners.get(binding.ownerId)?.soundDesign?.assetId||binding.resourceId)))changedOwners.add(binding.ownerId);
  }
  for(const old of clips.filter(c=>c.soundBinding)){
    if(!changedOwners.has(old.soundBinding.ownerId)||plans.has(old.id))continue;
    if(old.locked)conflict();
    clips.splice(clips.indexOf(old),1);
  }
  for(const [id,e] of plans){
    if(!changedOwners.has(e.owner.id))continue;
    const old=clips.find(c=>c.id===id),design=e.owner.soundDesign||{};
    if(old&&!old.soundBinding)continue;
    if(!old&&clips.some(c=>c.role==='sfx'&&!c.soundBinding&&
      (c.actionFrame??c.start)===e.anchorFrame&&enabled(c)))continue;
    const ref=soundResources.find(s=>s.id===e.resourceId);
    const asset=design.assetId?project.assets.find(a=>a.id===design.assetId):materializeStyleSound(project,assetDirectory,e.resourceId);
    if(!asset)throw Error('所选动作音效找不到原音频');
    const fps=project.profile.fps,impact=design.assetId?0:Math.round(ref.impactSeconds*fps);
    const start=Math.max(0,e.anchorFrame-impact),sourceIn=Math.max(0,impact-e.anchorFrame);
    const end=Math.max(e.owner.start+e.owner.duration,start+1);
    const duration=Math.min(end-start,Math.max(1,Math.round(ref.frames30*fps/30))-sourceIn,Math.ceil(asset.duration*fps)-sourceIn);
    if(duration<1)continue;
    const defaultDb=project.style.id==='henry-technical-explainer'&&ref.id==='tiny-pop'?-12:ref.gainDb;
    const gain=10**((design.gainDb??defaultDb)/20);
    const keepGain=old && old.soundBinding.defaultGain!=null && old.gain!==old.soundBinding.defaultGain;
    const clip={...old,id,track:'music',role:'sfx',templateRole:e.role,assetId:asset.id,start,duration,sourceIn,speed:1,
      gain:keepGain?old.gain:gain,locked:old?.locked??false,actionFrame:e.anchorFrame,styleId:project.style.id,styleVersion:8,
      soundBinding:{...old?.soundBinding,ownerId:e.owner.id,key:e.key,resourceId:e.resourceId,defaultGain:gain},
      ...(old?.enabled!==undefined?{enabled:old.enabled}:{}),
      hidden:Boolean(e.owner.hidden||e.owner.enabled===false),muted:Boolean(e.owner.muted||old?.soundBinding?.userMuted)};
    if(old?.locked && !same(old,clip))conflict();
    if(actor!=='user' && clips.some(c=>c.locked && c.track==='music' && !c.soundBinding && c.start<start+duration && start<c.start+c.duration))conflict();
    if(old)clips[clips.indexOf(old)]=clip;else clips.push(clip);
  }
}
