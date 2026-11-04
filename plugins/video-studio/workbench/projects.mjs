import {mkdir,readFile,readdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';

const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(id);
function validate(project){
  if(project?.schema!==2||!validId(project.id)||!['sources','selected','jobs','deliveries'].every(key=>Array.isArray(project[key])))throw new Error('项目记录格式无效。');
  return project;
}
export class ProjectStore{
  constructor(dataDir){this.directory=path.join(dataDir,'projects');this.records=new Map();this.errors=[];}
  async init(current){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    for(const entry of await readdir(this.directory,{withFileTypes:true})){
      if(!entry.isFile()||!entry.name.endsWith('.json'))continue;
      try{const project=validate(JSON.parse(await readFile(path.join(this.directory,entry.name),'utf8')));if(entry.name!==project.id+'.json')throw new Error('项目编号不一致。');this.records.set(project.id,project);}
      catch(e){this.errors.push({file:entry.name,error:e.message});}
    }
    const saved=this.records.get(current.id);
    if(saved&&(Date.parse(saved.updatedAt)||0)>(Date.parse(current.updatedAt)||0))current=saved;
    await this.save(current);return this;
  }
  async save(project){
    const snapshot=validate(structuredClone(project));
    const file=path.join(this.directory,snapshot.id+'.json');
    await writeFile(file+'.tmp',JSON.stringify(snapshot,null,2),{mode:0o600});await rename(file+'.tmp',file);
    this.records.set(snapshot.id,snapshot);
  }
  load(id){
    if(!validId(id)||!this.records.has(id))throw new Error('找不到这个项目，请刷新项目列表。');
    return structuredClone(this.records.get(id));
  }
  list(currentId){
    return [...this.records.values()].map(p=>({id:p.id,title:p.topic||p.title||'未命名视频',createdAt:p.createdAt,updatedAt:p.updatedAt||p.createdAt,current:p.id===currentId,materialCount:p.sources.filter(s=>s.status==='ready').length,deliveryCount:p.deliveries.length,status:p.jobs.some(j=>['running','cancelling'].includes(j.status))?'任务执行中':p.deliveries.length?'已有成片':p.approval?'已确认方案':p.plan?'文案待审':p.topic?'选材中':'新项目',recovered:!!p.recovery})).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))||a.id.localeCompare(b.id));
  }
}
