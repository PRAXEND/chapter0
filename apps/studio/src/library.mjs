import os from 'node:os';
import path from 'node:path';
import {readFile,readdir,stat,copyFile,mkdir,rename,rm,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileHash} from '../../../plugins/video-studio/workbench/media.mjs';
import {fault} from './project.mjs';
export async function portableProject(project,target,styles) {
  const temp=target+'.'+randomUUID()+'.tmp';
  await mkdir(path.join(temp,'assets'),{recursive:true,mode:0o700});
  try{
    const {writeFile}=await import('node:fs/promises');
    const out=structuredClone(project);
    for(const a of out.assets){
      const name=a.sha256+path.extname(a.path);
      await copyFile(a.path,path.join(temp,'assets',name),constants.COPYFILE_FICLONE);
      a.path='assets/'+name;
    }
    delete out.threadId;delete out.directorState;
    if(styles&&out.style)out.style={...out.style,...await styles.exportPortable(out.style,temp)};
    await writeFile(path.join(temp,'project.vstudio.json'),JSON.stringify(out,null,2),{mode:0o600});
    try{await rename(temp,target);}catch(error){if(!['ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
    return path.join(target,'project.vstudio.json');
  }finally{await rm(temp,{recursive:true,force:true});}
}
export function legacyLibrary(root=process.env.VIDEO_STUDIO_LEGACY_ROOT||path.join(os.homedir(),'Library','Application Support','Video Studio','workbench')) {
  async function records(){
    const dir=path.join(root,'projects');let names=[];
    try{names=await readdir(dir);}catch(e){if(e.code!=='ENOENT')throw e;}
    const projects=[];
    for(const name of names.filter(n=>n.endsWith('.json'))){
      try{
        const old=JSON.parse(await readFile(path.join(dir,name),'utf8'));
        if(name!==old.id+'.json')continue;
        const media=[];
        for(const d of [...old.deliveries||[],...old.provisionalDeliveries||[]]){
          for(const f of d.files||[]){
            if(f.role!=='video'||!f.path)continue;
            media.push({id:String(f.id),name:f.name,path:f.path,sha256:f.sha256,role:'成片',status:d.qaStatus,editor:editorUrl(d.editorUrl)});
          }
        }
        for(const a of old.sources||[]){
          if(!a.id||!(a.localPath||a.path)||!a.sha256)continue;
          media.push({id:String(a.id),name:a.title||a.file,path:a.localPath||a.path,sha256:a.sha256,role:'素材',source:{url:a.pageUrl||a.url,credit:a.author,rights:a.rights}});
        }
        projects.push({id:old.id,title:old.title||old.topic,updatedAt:old.updatedAt,editor:media.find(m=>m.editor)?.editor,media});
      }catch{}
    }
    return projects;
  }
  function editorUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&['app.chatcut.io','chatcut.io'].includes(u.host)?u.href:undefined;}catch{return undefined;}}
  async function item(projectId,itemId){
    const project=(await records()).find(p=>p.id===projectId),media=project?.media.find(m=>m.id===itemId);
    if(!media)throw fault('旧工程中找不到这项素材。',404);
    const file=await realpath(media.path).catch(()=>{throw fault('原文件已移动，请重新选择文件。',404);});
    if(!(await stat(file)).isFile()||!media.sha256||await fileHash(file)!==media.sha256)throw fault('历史媒体与登记的指纹不一致。',409);
    return {...media,path:file,projectTitle:project.title};
  }
  return {list:async()=>(await records()).map(p=>({...p,media:p.media.map(({path,sha256,...v})=>v)})),item};
}
export async function publishDelivery(root,project,jobId,files,styles){
  const title=String(project.title||'视频').normalize().replace(/[\/\\:\x00-\x1f]/g,' ').trim().slice(0,40)||'视频';
  const date=new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const folder=path.join(root,date+' '+title+' · v'+project.revision+'-'+jobId.slice(0,8));
  const temp=folder+'.'+randomUUID()+'.tmp';
  const names={video:title+'.mp4',subtitle:title+'.srt',review:'验收记录.json',credits:'素材与事实来源.txt',cover34:'封面 3×4.png',cover43:'封面 4×3.png',copy:'发布文案.txt'};
  await mkdir(temp,{recursive:true,mode:0o700});
  try{
    const published={};
    for(const [key,filename] of Object.entries(names))if(files[key]){
      await copyFile(files[key],path.join(temp,filename),constants.COPYFILE_FICLONE);
      published[key]=path.join(folder,filename);
    }
    await portableProject(project,path.join(temp,'工程'),styles);published.project=path.join(folder,'工程/project.vstudio.json');
    try{await rename(temp,folder);}catch(e){if(!['ENOTEMPTY','EEXIST'].includes(e.code))throw e;}
    return published;
  }finally{await rm(temp,{recursive:true,force:true});}
}
