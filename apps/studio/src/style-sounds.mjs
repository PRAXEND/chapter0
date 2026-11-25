import {dedicatedVoiceReference} from './style-audio.mjs';
// Only the named archive sound effects can be materialized by an edit transaction.
// Neither a project string nor a tool argument can supply an arbitrary file path.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const soundResources=[
  ['tiny-pop','轻弹字','tiny-bubble-pop-r1.mp3',.168,.021,4,-15,'3506a0f9e402d96e322ee7992e0ff87ce8a11bf90f963b58d989999a0ab4fd81'],
  ['synthetic-pop','合成弹字','synthetic-bubble-pop-r1.mp3',.360,.061,10,-19,'1c40c7995c14d40c8ada1d86a813bbcaf608a930779c0ce32319bedb55ff5137'],
  ['ui-pop','提示弹音','ui-pop-up-alert-r2.mp3',.408,.152,11,-20,'4a52caed94d3fdeb0df37f2fa7d1af07a0010e2d9f305ce8338fdc165094bbac'],
  ['deep-whoosh','深转场风声','deep-short-whoosh-r1.mp3',1.344,.490,33,-28,'3ff8ad4d247345208fbc238f7ecf0f6cfb3237d9b74b8464e1f2482fd2db2f9b'],
  ['airy-whoosh','轻转场风声','airy-short-whoosh-r1.mp3',.792,.429,22,-18,'ad00c275c00175ac3beb06b714ee77450e713c72974030ff4e787cc38e1cbdf8'],
  ['vine-boom','低频冲击','vine-boom-impact-r1.mp3',2.904,.143,27,-23,'97d167310bc3b1ceedb8282172adce0468afcfbe02ca17407d73d6588759ab8e'],
].map(([id,name,file,seconds,impactSeconds,frames30,gainDb,sha256])=>({id,name,file,seconds,impactSeconds,frames30,gainDb,sha256}));
export const supportsSound=(style,id)=>style?.version===8 && (style.id==='henry-hot-news' || style.id==='henry-technical-explainer' && ['tiny-pop','airy-whoosh'].includes(id));
const digest=b=>createHash('sha256').update(b).digest('hex');
const defaultRoot=fileURLToPath(new URL('../../../user-packs/',import.meta.url));
let common;
export function archiveSound(style,id) {
  const spec=soundResources.find(s=>s.id===id);
  if(!spec||!supportsSound(style,id))throw Error('所选风格没有此归档音效');
  const folder=style.id.slice(6),root=process.env.VIDEO_STUDIO_BUILTIN_PACKS||defaultRoot;
  const relative=['henry-video-styles','media',folder,spec.file];
  const file=path.join(root,...relative);
  let data=readFileSync(file);
  if(data.length<256 && data.toString().includes('oid sha256:'+spec.sha256+'\n')){
    common??=execFileSync('git',['-C',root,'rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8',timeout:2500}).trim();
    data=readFileSync(path.join(common,'lfs','objects',spec.sha256.slice(0,2),spec.sha256.slice(2,4),spec.sha256));
  }
  if(digest(data)!==spec.sha256)throw Error('风格包中 '+spec.name+' 的原文件指纹不符');
  return {spec,data,source:{kind:'style-sound',role:'sfx',resourceId:id,name:spec.file,styleId:style.id,styleVersion:8,
    archiveLocator:'resource:'+relative.slice(1).join('/'),styleResourceHash:spec.sha256,
    rights:'用户风格包内归档音效；沿用来源工程使用范围',sourceDocument:'henry-video-styles/README.md'}};
}
export function materializeStyleSound(project,directory,resourceId) {
  const resource=soundResources.find(s=>s.id===resourceId),existing=project.assets.find(a=>a.sha256===resource?.sha256);
  if(existing)return existing;
  const {spec,data,source}=archiveSound(project.style,resourceId),target=path.join(directory,spec.sha256+'.mp3');
  try{writeFileSync(target,data,{flag:'wx',mode:0o600});}catch(e){
    if(e.code!=='EEXIST'||statSync(target).size!==data.length||digest(readFileSync(target))!==spec.sha256)throw e;
  }
  const asset={id:'style-sound-'+spec.sha256.slice(0,20),kind:'audio',hasAudio:true,duration:spec.seconds,
    name:spec.file,path:target,sha256:spec.sha256,size:data.length,source,createdAt:new Date().toISOString()};
  project.assets.push(asset);return asset;
}

// Cues identify the visible or narrated action, not the start of the sound file.
// Labels are intentionally silent. Defaults use only sounds documented in that pinned edition.
export const motionSoundEvents={
  'impact-title':[['tiny-pop',0]],'fragment-title':[['tiny-pop',0]],
  'staggered-explanation':[['tiny-pop',0],['tiny-pop',1],['tiny-pop',2]],
  'process-rail':[['tiny-pop',0],['tiny-pop',1],['tiny-pop',2]],'comparison-guide':[['airy-whoosh',0]],
  'hot-impact-lines':[['synthetic-pop',0]],'hot-fact-scan':[['deep-whoosh',0]],
  'hot-orbit-mechanism':[['synthetic-pop',0],['ui-pop',1],['ui-pop',2]],
  'hot-reaction-text':[['tiny-pop',0]],'hot-surface-projection':[['deep-whoosh',0]],'hot-directional-word':[['synthetic-pop',0]],
};

export function validateSoundDesign(design,project) {
  if(design==null)return;
  if(typeof design!=='object'||Array.isArray(design)||Object.keys(design).some(k=>!['enabled','resourceId','assetId','gainDb','suppressed'].includes(k))||
    design.enabled!=null && typeof design.enabled!=='boolean'||design.resourceId!=null && !supportsSound(project.style,design.resourceId)||
    design.assetId!=null && !project.assets.some(a=>a.id===design.assetId&&a.kind==='audio'&&a.hasAudio!==false&&!dedicatedVoiceReference(a))||
    design.gainDb!=null && (!Number.isFinite(design.gainDb)||design.gainDb>12||design.gainDb< -96)||
    design.suppressed!=null && (!Array.isArray(design.suppressed)||design.suppressed.length>64||!design.suppressed.every(v=>typeof v==='string'&&v.length<100)))throw Error('动作音效的资源、音量或事件无效');
}
