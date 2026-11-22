import {createHash,randomUUID} from 'node:crypto';
import {copyFile,link,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fault} from './project.mjs';
import {contained,fileHash} from '../../../plugins/video-studio/workbench/media.mjs';

export function voiceLibrary(store){
  const home=path.join(store.root,'voices');
  async function list(){
    let files;try{files=await readdir(home);}catch(e){if(e.code==='ENOENT')return [];throw e;}
    return Promise.all(files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).map(async f=>{const v=JSON.parse(await readFile(path.join(home,f)));return {id:v.id,name:v.name,createdAt:v.createdAt};}));
  }
  async function enroll(projectId,{name,assetId,referenceText,consent}){
    if(consent!==true||!String(name||'').trim()||!String(referenceText||'').trim())throw fault('请填写音色名、准确原文并确认该参考录音已获授权。');
    const p=store.get(projectId),asset=p.assets.find(a=>a.id===assetId);
    if(!asset?.hasAudio)throw fault('请选择带声音的本地参考录音。');
    const file=await contained(asset.path,store.paths(projectId).assets);
    const id=createHash('sha256').update(asset.sha256+'\n'+referenceText.trim()+'\n'+name.trim()).digest('hex');
    await mkdir(home,{recursive:true,mode:0o700});
    const source=id+path.extname(file),temp=path.join(home,'.'+randomUUID());
    try{
      await copyFile(file,temp);if(await fileHash(temp)!==asset.sha256)throw fault('登记时参考录音内容发生变化。');
      try{await link(temp,path.join(home,source));}catch(e){if(e.code!=='EEXIST')throw e;}
      const value={id,source,name:name.trim().slice(0,100),referenceText:referenceText.trim().slice(0,2000),sha256:asset.sha256,consent:true,createdAt:new Date().toISOString()};
      const meta=temp+'.json';try{await writeFile(meta,JSON.stringify(value),{mode:0o600});try{await link(meta,path.join(home,id+'.json'));}catch(e){if(e.code!=='EEXIST')throw e;}}finally{await rm(meta,{force:true});}
      return {id,name:value.name};
    }finally{await rm(temp,{force:true});}
  }
  async function use(projectId,id,baseRevision,{selection='user'}={}){
    if(!/^[a-f0-9]{64}$/.test(id))throw fault('音色编号不合法。');
    const initial=store.get(projectId);if(initial.revision!==baseRevision)throw fault('工程版本已改变。',409);
    const v=JSON.parse(await readFile(path.join(home,id+'.json')));const src=await contained(path.join(home,v.source),home);
    if(!v.consent||await fileHash(src)!==v.sha256)throw fault('音色参考文件需要重新核验。');
    const a=await store.addAsset(projectId,src,{name:v.name+' · 参考录音',role:'voice-reference',consent:true,sourceVoice:id});
    const p=store.get(projectId),changed=!initial.assets.some(old=>old.id===a.id);
    if(p.revision!==baseRevision+Number(changed))throw fault('导入期间工程已改变，请重新选择音色。',409);
    return store.configure(projectId,p.revision,{settings:{voiceMode:'clone',voiceSelection:selection,voiceId:undefined,voiceLibraryId:id,voiceReferenceAssetId:a.id,voiceReferenceText:v.referenceText,referenceHash:v.sha256,voiceConsent:true}});
  }
  return {list,enroll,use};
}
