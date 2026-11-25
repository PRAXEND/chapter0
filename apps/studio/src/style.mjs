import {createHash, randomUUID} from 'node:crypto';
import {createReadStream,constants} from 'node:fs';
import {copyFile, link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {measureReference} from './reference-learning.mjs';
import {recipeSections,stylePage} from './director-style.mjs';
import {readPortableStyle,writePortableStyle,specDigest} from './style-portable.mjs';
import {compileVisualSteps,scienceExecutionPlan} from './visual-steps.mjs';

const builtInPacks = fileURLToPath(new URL('../../../user-packs/', import.meta.url));
const legacyHome = path.join(homedir(), 'Library/Application Support/Video Studio');
const validId = /^[a-z][a-z0-9_-]{0,78}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const execute=promisify(execFile);
const templateNames = {'action-result':'动作与结果', 'step-reveal':'问题与分步揭示'};
const fallbackSpecs = [
  {id:'neutral',name:'自然剪辑',version:1,templateIds:[],description:'跟随原片内容组织镜头、声音和字幕',rules:[]},
  {id:'henry-hot-news',name:'热点资讯型',version:1,templateIds:['action-result'],description:'以真实动作和结果推动叙事',rules:[{id:'action-first',instruction:'确认动作出现的源帧，再出现反应字，留出辨认结果的时间。'}]},
  {id:'henry-technical-explainer',name:'技术科普型',version:1,templateIds:['step-reveal'],description:'从可见问题逐步解释机制，再回到原片验证',rules:[{id:'step-evidence',instruction:'先呈现问题，依次解释动作条件，再用可见结果验证。'}]},
  {id:'original-dialogue',name:'原声访谈',version:1,templateIds:[],description:'以原声、停顿和人物回应连接镜头',rules:[{id:'complete-sentences',instruction:'保留句意、呼吸和回应的必要停留。'}]}
];
const latest = (values) => Math.max(0, ...values);
const entries = async (p) => readdir(p,{withFileTypes:true}).catch(e => { if(e.code==='ENOENT') return []; throw e; });
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
  const components=(blueprint.components||bundle.motion_graphics||[]).map(c=>({id:c.id,name:c.name||c.id,role:c.role||c.name,editable:c.editable||c.editableProperties||[],
    parameters:Object.fromEntries(Object.entries(c).filter(([k,v])=>!['id','name','role','editable','editableProperties'].includes(k)&&(typeof v==='number'||Array.isArray(v)&&v.length<=8&&v.every(Number.isFinite))))}));
  const templateIds=spec.templateIds??(spec.id==='henry-hot-news'?['action-result']:spec.id==='henry-technical-explainer'?['step-reveal']:[]);
  return {id:spec.id,name:spec.name,version:spec.version,description:spec.description||'',adaptation:spec.adaptation||'',rules:spec.rules||[],
    recipeSections:Object.keys(recipeSections(spec)),audioBlueprint:blueprint.audio||undefined,storyboardContract:spec.storyboard_contract||spec.storyboardContract||undefined,
    requirements:spec.material_requirements||[],knownExceptions:spec.knownExceptions||[],unknownDimensions:spec.unknown_dimensions||[],
    executionPlan:templateIds.includes('step-reveal')?scienceExecutionPlan(blueprint,spec):undefined,
    references,baseline,components,measurements:spec.measurements||[],effectRecipes:blueprint.effect_recipes||[],templates:templateIds.filter(id=>id in templateNames).map(id=>({id,name:templateNames[id]})),preferences:spec.preferences||[]};
}

export function createStyleLibrary(dataRoot, options={}) {
  const storage=path.resolve(dataRoot,'style-library');
  const oldHome=options.legacyHome===false?null:path.resolve(options.legacyHome||legacyHome);
  const packDir=path.resolve(options.packsRoot||process.env.VIDEO_STUDIO_BUILTIN_PACKS||builtInPacks);
  const verifiedHashes=new Map();
  async function registry() {
    const result=new Map();
    const bundledResources=new Map();
    const packRoots=[];
    function add(spec,origin,pack) {
      if (!spec || !validId.test(spec.id)||!Number.isSafeInteger(spec.version)||spec.version<1||!spec.name) return;
      result.set(spec.id+'@'+spec.version,{spec,origin,pack});
    }
    for(const spec of fallbackSpecs) add(spec,'builtin',null);
    const bundled=(await entries(packDir)).filter(e=>e.isDirectory()).map(e=>path.join(packDir,e.name));
    const linked=(oldHome && (await optionalJson(path.join(oldHome,'user-packs/locations.json')))?.packs)||{};
    const linkedRoots=Object.values(linked).filter(p=>typeof p==='string'&&path.isAbsolute(p));
    const explicit=options.packRoots||[];
    for(const pack of [...new Set([...bundled,...linkedRoots,...explicit])]) {
      const manifest=await optionalJson(path.join(pack,'manifest.json'));
      if(!manifest || !Array.isArray(manifest.styles)) continue;
      packRoots.push(pack);
      for(const item of manifest.styles) {
        const file=await checkedFile(pack,item);
        if(file) {
          const spec=await optionalJson(file);add(spec,'pack',pack);
          if(spec&&bundled.includes(pack)) for(const ref of parseStyle(spec).references) {
            if(/^(resource|pack):/.test(ref.locator)&&digestPattern.test(ref.sha256)) bundledResources.set(ref.sha256,{pack,ref});
          }
        }
      }
    }
    for(const [root,origin] of [[oldHome&&path.join(oldHome,'styles'),'legacy'],[path.join(storage,'versions'),'personal']]) {
      if(!root) continue;
      for(const folder of await entries(root)) {
        if(!folder.isDirectory()||!validId.test(folder.name)) continue;
        for(const version of await entries(path.join(root,folder.name))) {
          if(!/^\d+$/.test(version.name)) continue;
          const file=await checkedFile(root,path.join(folder.name,version.name,'style.json'));
          if(file) add(await optionalJson(file),origin,null);
        }
      }
    }
    return {result,bundledResources,packRoots};
  }
  function select(reg,id,version) {
    if(typeof id!=='string'||!validId.test(id)) throw Error('风格 ID 无效');
    const versions=[...reg.result.values()].filter(e=>e.spec.id===id).map(e=>e.spec.version);
    const row=reg.result.get(id+'@'+(version??latest(versions)));
    if(!row) throw Error('找不到选定版本的风格');
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
      for(const root of [...roots,oldHome&&path.join(oldHome,'styles'),oldHome&&path.join(oldHome,'user-packs')].filter(Boolean)) locations.push([root,ref.locator]);
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
    const reg=await registry(), grouped=new Map();
    for(const {spec} of reg.result.values()) {
      if(!grouped.has(spec.id)) grouped.set(spec.id,[]);
      grouped.get(spec.id).push(spec);
    }
    return [...grouped.values()].map(group=>{
      const spec=group.sort((a,b)=>b.version-a.version)[0];
      return {id:spec.id,name:spec.name,version:spec.version,versions:group.map(s=>s.version),description:spec.description||''};
    });
  }
  async function getReference(id,version,refId) {
    const reg=await registry(), row=select(reg,id,version);
    const ref=parseStyle(row.spec).references.find(r=>r.id===refId);
    if(!ref) throw Error('找不到风格参考');
    return verifiedReference(row,ref,reg.packRoots);
  }
  async function publish(spec) {
    const dir=path.join(storage,'versions',spec.id,String(spec.version));
    await mkdir(dir,{recursive:true});
    const temp=path.join(dir,'.'+randomUUID());
    try {
      await writeFile(temp,JSON.stringify(spec,null,2),{flag:'wx',mode:0o600});
      await link(temp,path.join(dir,'style.json'));
    } catch(error) { if(error.code==='EEXIST') throw Error('风格版本已更新，请读取最新版再保存'); throw error; }
    finally { await rm(temp,{force:true}); }
    return get(spec.id,spec.version);
  }
  async function savePreference({id,version,instruction,before,after,source,references=[]}) {
    if(typeof instruction!=='string'||!instruction.trim()||instruction.length>2000) throw Error('请填写要保存的风格偏好');
    const reg=await registry(), current=select(reg,id);
    if(current.spec.version!==version) throw Error('风格版本已更新，请读取最新版再保存');
    if(!Array.isArray(references)||references.length>2) throw Error('请选择此改稿的两个片段');
    for(const ref of references) {
      if(!validId.test(ref.id)||ref.kind!=='video'||!ref.locator?.startsWith('library:')||!(await verifiedReference({},ref,[])).verified) throw Error('改稿的片段未通过指纹核对');
    }
    const preference={instruction:instruction.trim(),before,after,source,basis:'user_direction'};
    return publish({...current.spec,version:version+1,references:[...(current.spec.references||[]),...references],preferences:[...(current.spec.preferences||[]),preference],
      rules:[...(current.spec.rules||[]),{id:'preference-'+(version+1),basis:'user_direction',instruction:preference.instruction}]});
  }
  async function captureReference(file,{kind='video',title='试片',id='reference'}={}) {
    if(!validId.test(id)||!['video','audio','image','script'].includes(kind)) throw Error('参考信息无效');
    const ext=path.extname(file).toLowerCase();
    if(!/^\.[a-z0-9]{1,5}$/.test(ext)||(await stat(file)).isFile()===false) throw Error('参考文件无效');
    const dir=path.join(storage,'media');
    await mkdir(dir,{recursive:true});
    const temp=path.join(dir,'.'+randomUUID());
    try {
      await copyFile(file,temp,constants.COPYFILE_FICLONE);
      const sha256=await fileSha256(temp), name=sha256+ext;
      try { await link(temp,path.join(dir,name)); } catch(error) { if(error.code!=='EEXIST') throw error; }
      return {id,kind,title,locator:'library:'+name,sha256};
    } finally { await rm(temp,{force:true}); }
  }
  async function learn({id,name,script='',observations=[],references=[],description='',templateIds=[],knownExceptions=[]}) {
    if(!validId.test(id)||!name?.trim()||name.length>100) throw Error('风格名称或 ID 无效');
    if((await list()).some(s=>s.id===id)) throw Error('该名字的风格 ID 已存在');
    if(typeof script!=='string'||!Array.isArray(observations)||!Array.isArray(references)||references.length>16) throw Error('请选择有效的参考材料');
    const ruleInputs=observations.filter(r=>r?.instruction?.trim()&&r.dimension&&r.evidence);
    if(!script.trim()&&!ruleInputs.length&&!references.length) throw Error('需要参考脚本、音视频样本或有出处的观察');
    const rules=ruleInputs.map((r,i)=>({id:'observation-'+(i+1),instruction:r.instruction,dimension:r.dimension,evidence:r.evidence,basis:r.basis||'observed'}));
    if(script.trim()) {
      const paragraphs=script.trim().split(/\n\s*\n/),sentences=script.trim().split(/[。！？!?]/u).filter(t=>t.trim());
      const typical=Math.round([...script.trim()].length/Math.max(1,sentences.length));
      rules.push({id:'script-rhythm',basis:'inferred',dimension:'language',instruction:'参考稿共 '+paragraphs.length+' 个段落，平均句长约 '+typical+' 字，依新内容调整长短。',evidence:'script'});
      rules.push({id:'script-order',basis:'observed',dimension:'narrative',instruction:'起句参考“'+script.trim().slice(0,60)+'”，保留叙事作用并替换本期对象。',evidence:'script'});
    }
    const refIds=new Set(),verifiedRefs=[];
    for(const ref of references) {
      if(!validId.test(ref.id)||refIds.has(ref.id)||!ref.locator?.startsWith('library:')||!digestPattern.test(ref.sha256)) throw Error('请选用已导入且可验证的参考文件');
      const verified=await verifiedReference({},ref,[]);
      if(!verified.available) throw Error('找不到此参考原件');
      refIds.add(ref.id);
      verifiedRefs.push(verified);
    }
    const measurements=[],publishedRefs=[...references];
    for(const [i,ref] of verifiedRefs.entries()) {
      if(!['video','audio','image'].includes(ref.kind)) continue;
      const scratch=await mkdtemp(path.join(storage,'analysis-'));
      try {
        const measured=await measureReference(ref,{directory:scratch,media:options.media});
        measurements.push(measured.facts);
        for(const [j,r] of measured.rules.entries()) rules.push({...r,id:'measured-'+(i+1)+'-'+(j+1)});
        for(const [j,frame] of measured.frames.entries()) {
          const stem='sample-'+(i+1)+'-frame-'+(j+1);
          let frameId=stem;
          while(refIds.has(frameId)) frameId+='-x';
          const photo=await captureReference(frame.file,{id:frameId,kind:'image',title:ref.title+' · '+frame.time+' 秒'});
          publishedRefs.push({...photo,derivedFrom:{referenceId:ref.id,sha256:ref.sha256,time:frame.time}});
          refIds.add(frameId);
        }
      } finally {await rm(scratch,{recursive:true,force:true});}
    }
    if(!rules.length&&!measurements.length) throw Error('请补充可观察的参考内容');
    const dimensions=['narrative','language','visual','motion','audio'];
    return publish({id,name:name.trim(),description,version:1,rules,references:publishedRefs,measurements,templateIds,knownExceptions,baselineId:references.find(r=>r.kind==='video')?.id,
      unknown_dimensions:dimensions.filter(d=>!rules.some(r=>r.dimension===d)),script_reference:script||undefined});
  }
  async function exportPortable(selector,directory) {
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
  async function restorePortable(selector,directory) {
    if(!validId.test(selector?.id)||!Number.isSafeInteger(selector.version)||selector.version<1) throw Error('工程的风格版本无效');
    const {spec,manifest,references}=await readPortableStyle(selector,directory,parseStyle,fileSha256);
    const reg=await registry(),key=spec.id+'@'+spec.version,prior=reg.result.get(key);
    if(prior&&specDigest(prior.spec)!==manifest.sha256) throw Error('本机已有同编号和版本的不同风格，请使用独立资料库打开');
    for(const item of references.filter(r=>r.status==='bundled')) {
      const original=reg.bundledResources.get(item.sha256);
      if(!original||original.ref.locator!==item.ref.locator||!(await verifiedReference({pack:original.pack},original.ref,[])).verified) throw Error('本机发行包缺少该风格引用的参考：'+item.id);
    }
    const privateRefs=references.filter(r=>r.status==='included');
    for(const item of privateRefs) {
      const dir=path.join(storage,'media');await mkdir(dir,{recursive:true,mode:0o700});
      const temp=path.join(dir,'.'+randomUUID()),dest=path.join(dir,item.sha256+item.extension);
      try {
        await copyFile(item.file,temp,constants.COPYFILE_FICLONE);
        if(await fileSha256(temp)!==item.sha256) throw Error('恢复期间风格参考发生变化');
        try{await link(temp,dest);}catch(e){if(e.code!=='EEXIST')throw e;if(await fileSha256(dest)!==item.sha256)throw Error('本机风格媒体与已登记指纹不同');}
      } finally {await rm(temp,{force:true});}
      if(!item.ref.locator.startsWith('library:')) {
        const aliases=path.join(storage,'portable-objects');await mkdir(aliases,{recursive:true,mode:0o700});
        const tmp=path.join(aliases,'.'+randomUUID());
        try {await writeFile(tmp,JSON.stringify({sha256:item.sha256,extension:item.extension}),{flag:'wx',mode:0o600});await rename(tmp,path.join(aliases,item.sha256+'.json'));}
        finally{await rm(tmp,{force:true});}
      }
    }
    if(!prior){
      try{await publish(spec);}catch(e){const now=(await registry()).result.get(key);if(!now||specDigest(now.spec)!==manifest.sha256)throw e;}
    }
    return {id:spec.id,version:spec.version,sha256:manifest.sha256};
  }
  return {list,get,getReference,getMusicResource,readDirectorSection,savePreference,learn,captureReference,compileScene,exportPortable,restorePortable};
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
