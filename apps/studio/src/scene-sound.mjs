import {archiveSound,supportsSound} from './style-sounds.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

const presets={
  'action-result':{name:'动作轻击',seconds:.24,gain:.4,role:'action-sound'},
  'step-reveal':{name:'揭示短音',seconds:.36,gain:.34,role:'reveal-sound'}
};
const cache=new Map();
function synthesized(template) {
  if(cache.has(template)) return cache.get(template);
  const rate=48000,frames=Math.round(presets[template].seconds*rate),wav=Buffer.alloc(44+frames*2);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(frames*2,40);
  const pi2=Math.PI*2;
  const ring=(t,pitch,decay)=>t<=0?0:Math.sin(pi2*pitch*t)*(1-Math.exp(-t/.004))*Math.exp(-t/decay);
  for(let i=0;i<frames;i++) {
    const t=i/rate;
    const hit=template==='action-result'?(.56*ring(t,459,.026)+.35*ring(t,1137,.013)):(.42*ring(t,522,.056)+.42*ring(t-.073,696,.061));
    const fade=Math.min(1,(frames-1-i)/(.012*rate));
    wav.writeInt16LE(Math.round(hit*fade*32767),44+i*2);
  }
  const value={wav,sha256:createHash('sha256').update(wav).digest('hex')};cache.set(template,value);return value;
}

export async function compileSceneWithSound(styles,store,project,scene) {
  const clips=styles.compileScene(scene,project.profile),template=scene.template||clips[0]?.template,preset=presets[template];
  const quiet=scene.soundEnabled===false||scene.soundGain===0||project.mode==='interview'&&scene.soundEnabled!==true;
  const anchor=project.assets.find(a=>a.id===scene.anchorAssetId);
  const fps=project.profile.fps;
  if(!clips.length||!preset||quiet||anchor?.kind!=='video'||!Number.isSafeInteger(scene.anchorSourceFrame)||scene.anchorSourceFrame<0||scene.anchorSourceFrame>=Math.ceil(anchor.duration*fps)) return {clips,baseRevision:project.revision};
  const archived=!scene.soundAssetId && supportsSound(scene.style,'tiny-pop')?archiveSound(scene.style,'tiny-pop'):null;
  const defaultDb=scene.style.id==='henry-technical-explainer'?-12:archived?.spec.gainDb;
  const gain=scene.soundGain??(archived?10**(defaultDb/20):preset.gain);
  const impact=archived?Math.round(archived.spec.impactSeconds*fps):0;
  const start=Math.max(0,scene.actionFrame-impact);
  const sourceIn=(scene.soundSourceIn??0)+Math.max(0,impact-scene.actionFrame);
  if(!Number.isFinite(gain)||gain<0||gain>16||!Number.isSafeInteger(sourceIn)||sourceIn<0) throw Error('音效音量或源位置无效');
  const now=await store.get(project.id);
  if(now.revision!==project.revision) throw Error('工程版本已更新，请重新读取动作位置');
  let asset,baseRevision=project.revision;
  if(scene.soundAssetId) {
    asset=now.assets.find(a=>a.id===scene.soundAssetId);
    if(asset?.kind!=='audio'||asset.hasAudio===false) throw Error('请选择本工程已导入的短音效');
  } else {
    const generated=archived?{wav:archived.data,sha256:archived.spec.sha256}:synthesized(template);
    asset=now.assets.find(a=>a.sha256===generated.sha256);
    if(!asset) {
      const parent=store.paths(project.id).cache;await mkdir(parent,{recursive:true});
      const work=await mkdtemp(path.join(parent,'scene-sound-'));
      try {
        const file=path.join(work,archived?archived.spec.file:template+'.wav');await writeFile(file,generated.wav,{mode:0o600});
        asset=await store.addAsset(project.id,file,archived?.source||{name:preset.name+'.wav',kind:'template-sound',role:'sfx',template,version:1,provider:'Video Studio PCM synthesis',rights:'工作台本机合成，可随工程使用及导出。'});
        if(asset.sha256!==generated.sha256)throw Error('本地音效录入后指纹不符');
      } finally {await rm(work,{recursive:true,force:true});}
      const latest=await store.get(project.id);
      if(latest.revision!==project.revision+1) throw Error('准备音效时工程已改变，请重新读取动作位置');
      baseRevision=latest.revision;
    }
  }
  if(sourceIn>=asset.duration*fps) throw Error('音效源位置之后没有可用采样');
  const maxFrames=Math.max(1,Math.floor(asset.duration*fps+.0001)-sourceIn);
  const duration=Math.min(maxFrames,scene.start+scene.duration-start,Math.max(1,Math.round((archived?archived.spec.frames30/30:preset.seconds)*fps))-Math.max(0,impact-scene.actionFrame));
  if(duration<1)throw Error('音效源位置之后没有可用采样');
  clips.push({id:randomUUID(),track:'music',role:'sfx',assetId:asset.id,start,duration,sourceIn,speed:1,gain,locked:false,
    template,templateVersion:1,templateRole:preset.role,styleId:scene.style.id,styleVersion:scene.style.version,actionFrame:scene.actionFrame,
    anchorAssetId:scene.anchorAssetId,anchorSourceFrame:scene.anchorSourceFrame});
  return {clips,baseRevision};
}
