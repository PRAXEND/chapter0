import {newsEffects} from './news-effects.mjs';
import {motionCatalog} from './motion-components.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {createReadStream,constants} from 'node:fs';
import {copyFile, mkdir, open, readFile, realpath, rename, rm, stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {currentStyles,currentStyle,selectedStyle} from './style-catalog.mjs';
import {recipeSections,stylePage} from './director-style.mjs';
import {readPortableStyle,writePortableStyle,specDigest} from './style-portable.mjs';
import {compileVisualSteps,scienceExecutionPlan} from './visual-steps.mjs';

const builtInPacks = fileURLToPath(new URL('../../../user-packs/', import.meta.url));
const validId = /^[a-z][a-z0-9_-]{0,78}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const execute=promisify(execFile);
const templateNames = {'action-result':'动作与结果', 'step-reveal':'问题与分步揭示'};
async function optionalJson(file) {
  try {
    const info=await stat(file,{bigint:true});
    if (info.size > 8_000_000n) throw Error('风格索引文件过大');
    if (!(await materialized(file,info))) return null;
    return JSON.parse(await readFile(file,'utf8'));
  } catch(e) { if(e.code==='ENOENT') return null; throw e; }
}
function contained(root,file) {
  const relative=path.relative(root,file);
  return relative !== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
}
async function checkedFile(root,file) {
  if(!root || !file) return null;
  const target=path.resolve(root,file);
  if(!contained(path.resolve(root),target)) return null;
  try {
    const [base,resolved]=await Promise.all([realpath(root),realpath(target)]);
    return contained(base,resolved) && (await stat(resolved)).isFile() ? resolved : null;
  } catch(error) { if(error.code==='ENOENT' || error.code==='ENOTDIR') return null; throw error; }
}
export async function fileSha256(file) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function materialized(file,metadata) {
  if(!file) return false;
  const info=metadata||await stat(file,{bigint:true});
  if(process.platform!=='darwin'||info.size===0n||info.blocks!==0n) return true;
  const {stdout}=await execute('/usr/bin/stat',['-f','%Sf',file],{timeout:2000});
  return !stdout.split(/[,\s]+/).includes('dataless');
}
async function localLfsObjects(pack,relative,hash) {
  const git=async(...args)=>(await execute('git',['-C',pack,...args],{timeout:4000,maxBuffer:2400})).stdout.trim();
  try {
    const top=await realpath(await git('rev-parse','--show-toplevel')),target=path.resolve(await realpath(pack),relative);
    if(!contained(top,target)) return [];
    const sourcePath=path.relative(top,target),name='HEAD:'+sourcePath.split(path.sep).join('/');
    if(Number(await git('cat-file','-s',name))>256 || !(await git('cat-file','-p',name)).split(/\r?\n/).includes('oid sha256:'+hash)) return [];
    const common=await git('rev-parse','--path-format=absolute','--git-common-dir');
    const stored=await checkedFile(common,path.join('lfs','objects',hash.slice(0,2),hash.slice(2,4),hash));
    const main=path.basename(common)==='.git'?await checkedFile(path.dirname(common),sourcePath):null;
    return [...new Set([stored,main].filter(Boolean))];
  } catch {return [];}
}
function parseStyle(spec) {
  const bundle=spec.reproduction_bundle??{}, blueprint=spec.reproduction_blueprint??{};
  const references=(spec.references??[]).map(r=>({id:r.id,kind:r.kind,title:r.title||r.id,locator:r.locator,sha256:r.sha256,duration:r.duration_s,source:r.source_url,segments:r.analyzed_ranges||r.segments||[],derivedFrom:r.derivedFrom}));
  let baseline=null;
  if(bundle.baseline?.path) {
    const b=bundle.baseline;
    baseline=references.find(r=>r.locator===b.path && r.sha256===b.sha256) || {id:'baseline',kind:'video',title:'基准片',locator:b.path,sha256:b.sha256,duration:b.durationInFrames / b.fps};
    if(!references.includes(baseline)) references.push(baseline);
  } else {
    const rows=references.filter(r=>r.kind==='video' && (r.locator?.startsWith('resource:media/benchmarks/') || r.id===spec.baselineId));
    if(rows.length===1) baseline=rows[0];
  }
  const components=(blueprint.components||bundle.motion_graphics||[]).map(c=>({id:motionCatalog.find(m=>m.styleId===spec.id&&m.styleVersion===spec.version&&m.sourceId===c.id)?.id||c.id,name:c.name||c.id,role:c.role||c.name,editable:c.editable||c.editableProperties||[],
    parameters:Object.fromEntries(Object.entries(c).filter(([k,v])=>!['id','name','role','editable','editableProperties'].includes(k)&&(typeof v==='number'||Array.isArray(v)&&v.length<=8&&v.every(Number.isFinite))))}));
  const templateIds=spec.templateIds??(spec.id==='henry-hot-news'?['action-result']:spec.id==='henry-technical-explainer'?['step-reveal']:[]);
  return {id:spec.id,name:spec.name,version:spec.version,description:spec.description||'',adaptation:spec.adaptation||'',rules:spec.rules||[],
    recipeSections:Object.keys(recipeSections(spec)),audioBlueprint:blueprint.audio||undefined,storyboardContract:spec.storyboard_contract||spec.storyboardContract||undefined,
    requirements:spec.material_requirements||[],knownExceptions:spec.knownExceptions||[],unknownDimensions:spec.unknown_dimensions||[],
    executionPlan:templateIds.includes('step-reveal')?scienceExecutionPlan(blueprint,spec):undefined,
    references,baseline,components,measurements:spec.measurements||[],effectRecipes:spec.id==='henry-hot-news'&&spec.version===8?newsEffects:blueprint.effect_recipes||[],templates:templateIds.filter(id=>id in templateNames).map(id=>({id,name:templateNames[id]})),preferences:spec.preferences||[]};
}

export function createStyleLibrary(dataRoot, options={}) {
  const storage=path.resolve(dataRoot,'style-library');
  const packDir=path.resolve(options.packsRoot||process.env.VIDEO_STUDIO_BUILTIN_PACKS||builtInPacks);
  const verifiedHashes=new Map();
  async function registry() {
    const pack=path.join(packDir,'henry-video-styles'),manifest=await optionalJson(path.join(pack,'manifest.json'));
    const result=new Map(),bundledResources=new Map();
    if(manifest?.id==='henry-video-styles' && Array.isArray(manifest.styles)) {
      for(const pin of currentStyles) {
        const name='styles/'+pin.id+'-v'+pin.version+'.json';
        if(!manifest.styles.includes(name))continue;
        const file=await checkedFile(pack,name);
        const spec=file&&await optionalJson(file);
        if(!spec||spec.id!==pin.id||spec.version!==pin.version||specDigest(spec)!==pin.sha256)continue;
        result.set(pin.id,{spec,origin:'pack',pack});
        for(const ref of parseStyle(spec).references) {
          if(/^(resource|pack):/.test(ref.locator)&&digestPattern.test(ref.sha256))bundledResources.set(ref.sha256,{pack,ref});
        }
      }
    }
    return {result,bundledResources,packRoots:[pack]};
  }
  function select(reg,id,version) {
    const pin=selectedStyle({id,version});
    const row=reg.result.get(pin.id);
    if(!row)throw Object.assign(Error(pin.name+' v'+pin.version+' 的发行包缺失或指纹不符，请修复安装。'),{status:503});
    return row;
  }
  async function verifiedReference(row,ref,roots) {
    if(!ref || !ref.locator || !digestPattern.test(ref.sha256||'')) return {...ref,available:false};
    const locations=[];
    if(/^(resource|pack):/.test(ref.locator)) {
      const rel=ref.locator.slice(ref.locator.indexOf(':')+1);
      if(path.isAbsolute(rel)||rel.split(/[\\/]/).includes('..')) return {...ref,available:false};
      for(const root of new Set([...roots.filter(p=>contained(packDir,p)),row.pack,...roots].filter(Boolean))) locations.push([root,rel]);
    } else if(ref.locator.startsWith('library:')) {
      const name=ref.locator.slice(8);
      if(!/^[a-f0-9]{64}\.[a-z0-9]{1,5}$/.test(name)) return {...ref,available:false};
      locations.push([path.join(storage,'media'),name]);
    } else if(path.isAbsolute(ref.locator)) {
      for(const root of roots) locations.push([root,ref.locator]);
    }
    if(!ref.locator.startsWith('library:')) {
      const alias=await optionalJson(path.join(storage,'portable-objects',ref.sha256+'.json'));
      if(alias?.sha256===ref.sha256&&/^\.[a-z0-9]{1,5}$/.test(alias.extension)) locations.push([path.join(storage,'media'),ref.sha256+alias.extension]);
    }
    const pointers=[];
    for(const [root,name] of locations) {
      const file=await checkedFile(root,name);
      if(await materialized(file)) {
        const info=await stat(file,{bigint:true});
        const identity=[info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
        const previous=verifiedHashes.get(file);
        const hash=previous?.identity===identity?previous.hash:await fileSha256(file);
        verifiedHashes.set(file,{identity,hash});
        if(hash===ref.sha256) return {...ref,path:file,available:true,verified:true};
        const handle=await open(file,'r');let first;
        try {const prefix=Buffer.alloc(180);const {bytesRead}=await handle.read(prefix,0,prefix.length,0);first=prefix.subarray(0,bytesRead).toString();} finally {await handle.close();}
        if(first && !first.startsWith('version https://git-lfs.github.com/spec/v1')) continue;
      }
      if(ref.locator.startsWith('resource:')) pointers.push([root,name]);
    }
    for(const [root,name] of pointers) {
      const ext=path.extname(name).toLowerCase();
      if(!/^\.[a-z0-9]{1,5}$/.test(ext)) continue;
      const dir=path.join(storage,'media'),dest=path.join(dir,ref.sha256+ext);
      const cached=await checkedFile(dir,dest);
      if(await materialized(cached) && await fileSha256(cached)===ref.sha256) return {...ref,path:cached,available:true,verified:true};
      for(const obj of await localLfsObjects(root,name,ref.sha256)) {
        if(!(await materialized(obj))) continue;
        const temp=path.join(dir,'.'+randomUUID());await mkdir(dir,{recursive:true,mode:0o700});
        try {
          await copyFile(obj,temp,constants.COPYFILE_FICLONE);
          if(await fileSha256(temp)!==ref.sha256) continue;
          await rename(temp,dest);
          return {...ref,path:dest,available:true,verified:true};
        } finally {await rm(temp,{force:true});}
      }
    }
    return {...ref,available:false,verified:false};
  }
  // A reference copy is allowed to become a soundtrack only when its credit and licence
  // agree with both the pinned blueprint and the pack's manifest for that exact file.
  async function getMusicResource(id,version,music) {
    if (!music?.url || !music.title || !music.author || !music.license || !music.licenseUrl) return null;
    const reg=await registry(), row=select(reg,id,version);
    for (const pack of new Set([row.pack,...reg.packRoots].filter(Boolean))) {
      const list=await optionalJson(path.join(pack,'resources.json'));
      if (id==='henry-hot-news' && version===8 && music.originalAssetId==='ref-b2d81b025693') {
        const original=row.spec.reproduction_bundle?.media?.find(m=>m.id===music.originalAssetId);
        const file=list?.files?.find(f=>f.sha256===music.sha256 && 'resource:'+f.path===music.url &&
          f.asset_aliases?.includes(original?.id) && f.original_name===original?.name);
        if(file && original.generation_provenance?.generationType==='instrumental' && original.generation_provenance?.model==='mureka-9'){
          const verified=await verifiedReference({...row,pack},{id:original.id,kind:'audio',title:music.title,locator:music.url,sha256:file.sha256},reg.packRoots);
          if(verified.available && verified.verified)return verified;
        }
        continue;
      }
      const match=list?.files?.find(f=>f.source_url===music.url && f.author===music.author &&
        f.license===music.license && f.license_url===music.licenseUrl && digestPattern.test(f.sha256) &&
        typeof f.path==='string' && path.basename(f.path,path.extname(f.path)).toLowerCase()===music.title.toLowerCase());
      if (!match) continue;
      const file=await verifiedReference({...row,pack},{id:'licensed-music',kind:'audio',title:music.title,
        locator:'resource:'+match.path,sha256:match.sha256},reg.packRoots);
      if (file.available) return file;
    }
    return null;
  }
  async function readDirectorSection(id,version,name,offset=0) {
    const row=select(await registry(),id,version);
    return stylePage(recipeSections(row.spec),name,offset);
  }
  async function get(id,version) {
    const reg=await registry(), row=select(reg,id,version), style=parseStyle(row.spec);
    const baseline=style.baseline && await verifiedReference(row,style.baseline,reg.packRoots);
    return {...style,origin:row.origin,sha256:specDigest(row.spec),baseline,
      references:style.references.map(ref=>ref.id===baseline?.id?baseline:{...ref,available:null})};
  }
  async function list() {
    const reg=await registry();
    return currentStyles.map(({id,name,version})=>({id,name,version,versions:[version],
      description:reg.result.get(id)?.spec.description||'',available:reg.result.has(id)}));
  }
  async function getReference(id,version,refId) {
    const reg=await registry(), row=select(reg,id,version);
    const ref=parseStyle(row.spec).references.find(r=>r.id===refId);
    if(!ref) throw Error('找不到风格参考');
    return verifiedReference(row,ref,reg.packRoots);
  }
  // Retired specs can travel with their own existing project. Opening one never registers a choice.
  async function copyArchive(selector,from,to) {
    const {spec,references}=await readPortableStyle(selector,from,parseStyle,fileSha256);
    const items=references.map(row=>({id:row.id,sha256:row.sha256,status:row.status,source:row.file,extension:row.extension}));
    return writePortableStyle(to,spec,items,parseStyle,fileSha256);
  }
  async function exportPortable(selector,directory,{projectId}={}) {
    if(!currentStyle(selector)) {
      const retired={...selector};delete retired.manifest;
      if(!validId.test(selector.id)||!Number.isSafeInteger(selector.version)||selector.version<1)return retired;
      if(projectId&&/^[a-zA-Z0-9_-]{1,100}$/.test(projectId)) {
        const source=path.join(dataRoot,'projects',projectId);
        if(await checkedFile(source,'style/manifest.json'))return copyArchive(selector,source,directory);
      }
      // Historic installations placed a project's pinned private spec in a shared archive.
      // Read only its exact key on export. A snapshot without that archive stays editable.
      const relative=path.join('versions',selector.id,String(selector.version),'style.json');
      const file=await checkedFile(storage,relative),spec=file&&await optionalJson(file);
      if(!spec)return retired;
      if(spec.id!==selector.id||spec.version!==selector.version||selector.sha256&&specDigest(spec)!==selector.sha256)
        throw Error('历史工程的风格指纹与其归档不同');
      const reg=await registry(),items=[];
      for(const ref of parseStyle(spec).references.filter(r=>r.locator&&digestPattern.test(r.sha256))) {
        const resource=reg.bundledResources.get(ref.sha256);
        if(resource?.ref.locator===ref.locator){items.push({id:ref.id,sha256:ref.sha256,status:'bundled'});continue;}
        const found=await verifiedReference({pack:null},ref,reg.packRoots);
        if(!found.verified&&ref.locator.startsWith('library:'))throw Error('历史工程的个人风格参考缺失：'+ref.id);
        items.push({id:ref.id,sha256:ref.sha256,status:found.verified?'included':'unavailable',
          source:found.path,extension:found.path&&path.extname(found.path).toLowerCase()});
      }
      return writePortableStyle(directory,spec,items,parseStyle,fileSha256);
    }
    const reg=await registry(),row=select(reg,selector.id,selector.version),style=parseStyle(row.spec),items=[];
    if(selector.sha256&&selector.sha256!==specDigest(row.spec)) throw Error('工程绑定的风格指纹与本机不同');
    for(const ref of style.references.filter(r=>r.locator&&digestPattern.test(r.sha256))) {
      const entry={id:ref.id,sha256:ref.sha256};
      const bundle=reg.bundledResources.get(ref.sha256);
      if(bundle?.ref.locator===ref.locator&&(await verifiedReference({pack:bundle.pack},bundle.ref,[])).verified) {
        items.push({...entry,status:'bundled'});continue;
      }
      const found=await verifiedReference(row,ref,reg.packRoots);
      if(found.verified){items.push({...entry,status:'included',source:found.path,extension:path.extname(found.path).toLowerCase()});continue;}
      if(ref.locator.startsWith('library:')||style.baseline?.id===ref.id) throw Error('风格的必要参考缺失或指纹不同：'+ref.title);
      items.push({...entry,status:'unavailable'});
    }
    return writePortableStyle(directory,row.spec,items,parseStyle,fileSha256);
  }
  async function restorePortable(selector,directory,{projectDirectory}={}) {
    if(!validId.test(selector?.id)||!Number.isSafeInteger(selector.version)||selector.version<1)throw Error('工程的风格版本无效');
    if(!currentStyle(selector)){
      if(!projectDirectory)throw Error('恢复历史风格需要所属工程目录');
      return copyArchive(selector,directory,projectDirectory);
    }
    const {spec,manifest,references}=await readPortableStyle(selector,directory,parseStyle,fileSha256);
    const reg=await registry(),row=select(reg,spec.id,spec.version);
    if(specDigest(row.spec)!==manifest.sha256)throw Error('工程中的风格与发行包同版本指纹不同');
    for(const item of references.filter(r=>r.status==='bundled')){
      const original=reg.bundledResources.get(item.sha256);
      if(original?.ref.locator!==item.ref.locator||!(await verifiedReference(row,original.ref,reg.packRoots)).verified)throw Error('本机发行包缺少该风格引用的参考：'+item.id);
    }
    return {id:spec.id,version:spec.version,sha256:manifest.sha256};
  }
  return {list,get,getReference,getMusicResource,readDirectorSection,compileScene,exportPortable,restorePortable};
}

function oppositeSubject(subject) {
  if(!subject) return {x:.5,y:.32};
  const x=Number(subject.x),y=Number(subject.y);
  if(!Number.isFinite(x)||!Number.isFinite(y)) throw Error('主体位置无效');
  return {x:x>.5?.30:.70,y:y>.5?.25:.72};
}
export function compileScene(scene,profile) {
  const {style,start,duration}=scene;
  const actionFrame=scene.actionFrame??scene.visualSteps?.[0]?.atFrame;
  const template=scene.template??style?.templates?.[0]?.id;
  if(!templateNames[template]||!style?.templates?.some(t=>t.id===template)) throw Error('此风格未启用所选模板');
  if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(duration)||duration<2||!Number.isSafeInteger(actionFrame)||actionFrame<start||actionFrame>=start+duration) throw Error('请标出片段内实际观察到的动作帧');
  const fps=profile?.fps, h=profile?.height,w=profile?.width;
  if(![fps,h,w].every(v=>Number.isFinite(v)&&v>0)) throw Error('工程画幅或帧率无效');
  if(template==='step-reveal'&&scene.visualSteps?.length) return compileVisualSteps(scene,profile);
  const position=oppositeSubject(scene.subject),finish=start+duration;
  const isNews=template==='action-result';
  const title=(scene.text||'').trim(),detail=(scene.followup||'').trim();
  const maxChars=isNews?13:24;
  if(!title || [...title].length>maxChars || [...detail].length>30) throw Error('模板文字超出可读容量，请缩短文案');
  const short=Math.max(3,Math.round(.28*fps));
  const textUnits=t=>[...t].reduce((total,c)=>total+(/[\x00-\x7F]/.test(c)?.56:1),0);
  const readingFrames=t=>Math.max(short,Math.ceil(fps*textUnits(t)/(isNews?13:10)));
  function layer(role,text,from,to,color,size,pos,background) {
    const frames=to-from;
    if(frames<readingFrames(text)) throw Error('动作前后没有足够的可读停留时间');
    const enter=Math.max(1,Math.min(frames-1,Math.round((isNews?.075:.18)*fps)));
    const units=textUnits(text);
    const fontSize=Math.floor(Math.min(Math.min(h*(isNews?.065:.052),w/(maxChars+2))*size,w*.84/Math.max(1,units)));
    const halfWidth=units*fontSize/(2*w)+.045;
    pos={...pos,x:Math.max(halfWidth,Math.min(pos.x,1-halfWidth))};
    return {id:randomUUID(),track:'graphic',start:from,duration:frames,sourceIn:0,speed:1,gain:1,text,locked:false,
      geometry:pos,style:{fontSize,color,backgroundColor:background},keyframes:[
        {frame:0,...pos,opacity:isNews?.82:.35,scale:isNews?1.13:.97},{frame:enter,...pos,opacity:1,scale:1}],
      template,templateVersion:1,templateRole:role,styleId:style.id,styleVersion:style.version,actionFrame,anchorAssetId:scene.anchorAssetId,anchorSourceFrame:scene.anchorSourceFrame,continuity:scene.continuity||''};
  }
  if(isNews) {
    const cut=detail?Math.min(finish-readingFrames(detail),actionFrame+Math.max(readingFrames(title),Math.round(.8*fps))):finish;
    const clips=[layer('action',title,actionFrame,cut,'#FFD34E',1.12,position,'#151917CC')];
    if(detail) clips.push(layer('result',detail,cut,finish,'#FFFFFF',.88,position,'#151917D0'));
    return clips;
  }
  const query=layer('question',title,start,actionFrame,'#D0E4FF',.94,position,'#142B4DE8');
  return [query,layer('explanation',detail||title,actionFrame,finish,'#FFFFFF',1,position,'#234E7CE8')];
}
