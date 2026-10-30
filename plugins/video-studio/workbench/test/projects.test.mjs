import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initialStudio,brief,inputHash} from '../studio-workflow.mjs';
import {ProjectStore} from '../projects.mjs';
import {recoverLegacyProjects} from '../recover-projects.mjs';
import {fileHash} from '../media.mjs';
import {mkdir} from 'node:fs/promises';

test('projects retain independent plans, selections, jobs and deliveries after switching and restarting',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'studio-projects-test-'));
  try{
    const first=initialStudio();Object.assign(first,{topic:'已有视频',sources:[{id:'source-1',status:'ready'}],selected:['source-1'],plan:{script:'已审阅文案'},approval:{planHash:'approved'},jobs:[{id:'job-1',status:'completed'}],deliveries:[{id:'delivery-1'}]});
    const store=await new ProjectStore(data).init(first),second=initialStudio();await store.save(second);
    const rows=store.list(second.id);assert.equal(rows.length,2);assert.equal(rows.find(p=>p.current).id,second.id);assert.equal(rows.find(p=>p.id===first.id).status,'已有成片');
    const original=store.load(first.id);original.plan.script='未保存的本地改动';assert.equal(store.load(first.id).plan.script,'已审阅文案');
    const reopened=await new ProjectStore(data).init(second);assert.deepEqual(reopened.load(first.id),first);assert.deepEqual(reopened.load(second.id).sources,[]);
    assert.deepEqual(JSON.parse(await readFile(path.join(data,'projects',first.id+'.json'),'utf8')).selected,['source-1']);
    assert.throws(()=>reopened.load('../workbench-v2'),/找不到/);assert.throws(()=>reopened.load('not-registered'),/找不到/);
  }finally{await rm(data,{recursive:true,force:true});}
});

test('unreadable project records remain on disk and do not hide other saved projects',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'studio-project-corrupt-test-'));
  try{
    const current=initialStudio();await new ProjectStore(data).init(current);const bad=path.join(data,'projects','old-broken.json');await writeFile(bad,'broken original bytes');
    const store=await new ProjectStore(data).init(current);assert.equal(store.list(current.id).length,1);assert.equal(store.errors.length,1);assert.equal(await readFile(bad,'utf8'),'broken original bytes');
  }finally{await rm(data,{recursive:true,force:true});}
});

test('a newer project snapshot survives interruption before the current-project mirror is updated',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'studio-project-interrupt-test-'));
  try{
    const older={...initialStudio(),updatedAt:'2026-10-28T01:00:00Z'},newer={...older,topic:'最后保存的内容',updatedAt:'2026-10-28T02:00:00Z'};
    const first=await new ProjectStore(data).init(older);await first.save(newer);
    const reopened=await new ProjectStore(data).init(older);assert.equal(reopened.load(older.id).topic,newer.topic);
  }finally{await rm(data,{recursive:true,force:true});}
});

test('legacy recovery restores only recorded projects and hash-matching files, without inventing approval or task success',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'studio-recovery-test-'));
  try{
    const current=initialStudio(),store=await new ProjectStore(data).init(current),run=path.join(data,'runs','prior-project'),job=path.join(data,'jobs','old-production'),output=path.join(data,'output'),delivery=path.join(output,'prior-delivery');
    for(const folder of [run,job,delivery])await mkdir(folder,{recursive:true});
    const previous=initialStudio();Object.assign(previous,{topic:'可恢复旧项目',title:'可恢复旧项目',run,outputRoot:output});
    const request={run,brief:brief(previous),settings:{music:'none'},outputDirectory:output,selectedSources:[],planHash:'not-evidence-of-approval',inputHash:inputHash(previous)};
    await writeFile(path.join(job,'request.json'),JSON.stringify(request));await writeFile(path.join(job,'output.schema.json'),JSON.stringify({properties:{status:{}}}));
    const identity={projectId:'recorded-project',timelineId:'recorded-timeline',editorUrl:'https://app.chatcut.io/editor/recorded-project'};
    await writeFile(path.join(run,'run.json'),JSON.stringify({created_at:'2026-10-28T01:00:00Z',project:identity}));
    await writeFile(path.join(run,'workbench-plan.json'),JSON.stringify({title:'旧方案',summary:'',script:'真实保存的旧文本',shots:[{id:'1',from:0,to:3,sourceIds:[],narration:'',visual:'文字卡',screenText:'测试',transition:'直接'}],gaps:[],notes:[]}));
    // Text bytes exercise recovery identity/hash checks only; no media validation or rendering is claimed.
    const exported=path.join(run,'test-only-export.mp4'),video=path.join(delivery,'final.mp4');await writeFile(exported,'test-only recovery bytes');await writeFile(video,'test-only recovery bytes');
    await writeFile(path.join(delivery,'project.json'),JSON.stringify(identity));
    await writeFile(path.join(delivery,'delivery-report.json'),JSON.stringify({video:{decodeVerified:true,path:exported,bytes:24,sha256:await fileHash(video)}}));
    assert.equal(await recoverLegacyProjects(data,current,store),1);
    const restored=store.load(store.list(current.id).find(p=>p.recovered).id);assert.equal(restored.topic,previous.topic);assert.equal(restored.approval,null);assert.equal(restored.plan.script,'真实保存的旧文本');assert.equal(restored.deliveries.length,1);assert.equal(restored.jobs[0].status,'completed');
    assert.equal(restored.deliveries[0].verified.sha256,await fileHash(video));assert.equal(await recoverLegacyProjects(data,current,store),0);
    await writeFile(video,'changed after export');
    const otherData=await mkdtemp(path.join(os.tmpdir(),'studio-recovery-reject-test-'));
    try{const other=await new ProjectStore(otherData).init(current);await recoverLegacyProjects(data,current,other);const rejected=other.load(other.list(current.id).find(p=>p.recovered).id);assert.equal(rejected.deliveries.length,0);assert.equal(rejected.jobs[0].status,'interrupted');}
    finally{await rm(otherData,{recursive:true,force:true});}
  }finally{await rm(data,{recursive:true,force:true});}
});


test('legacy recovery recognizes the same run after moving data behind a compatibility symlink',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'studio-data-alias-'));
  try{
    const data=path.join(folder,'new'),alias=path.join(folder,'old'),run=path.join(data,'runs','existing'),job=path.join(data,'jobs','old-job');
    await mkdir(run,{recursive:true});await mkdir(job,{recursive:true});await symlink(data,alias,process.platform==='win32'?'junction':'dir');
    const p=initialStudio();p.topic='Existing source project';p.run=path.join(alias,'runs','existing');
    await writeFile(path.join(run,'run.json'),JSON.stringify({created_at:new Date().toISOString(),brief:brief(p),sources:[]}));
    await writeFile(path.join(job,'request.json'),JSON.stringify({run:p.run,brief:brief(p),selectedSources:[]}));
    await writeFile(path.join(job,'output.schema.json'),JSON.stringify({properties:{script:{type:'string'}}}));
    const store=await new ProjectStore(data).init(p);
    assert.equal(await recoverLegacyProjects(data,p,store),0);assert.equal(store.records.size,1);assert.equal(store.load(p.id).run,p.run);
  }finally{await rm(folder,{recursive:true,force:true});}
});
