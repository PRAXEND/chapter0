import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {startStudio} from '../src/server.mjs';
import {createStore} from '../src/project.mjs';
import {createQueue} from '../src/jobs.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function awaitJob(store,id,status){for(let i=0;i<200;i++){const j=store.getJob(id);if(j.status===status)return j;await delay(20);}throw Error('timeout '+JSON.stringify(store.getJob(id)));}
test('one-time loopback entry, same origin, scoped edits and blind UI',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'vs-http-'));
 let sourceOpened;
 const service=await startStudio({root,dependencies:{openSource:url=>{sourceOpened=url;},director:{account:()=>({connected:true}),close(){}}}});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const origin=new URL(service.url).origin;
 assert.equal((await fetch(origin+'/api/projects')).status,403);
 const first=await fetch(service.url,{redirect:'manual'});assert.equal(first.status,303);
 assert.equal((await fetch(service.url,{redirect:'manual'})).status,403);
 const cookie=first.headers.get('set-cookie').split(';')[0];const headers={cookie,'Content-Type':'application/json'};
 assert.equal((await fetch(origin+'/api/projects',{method:'POST',headers:{...headers,Origin:'https://example.org'},body:'{}'})).status,403);
 const p=await (await fetch(origin+'/api/projects',{method:'POST',headers,body:JSON.stringify({mode:'interview',title:'原声'})})).json();
 assert.equal(p.settings.voiceMode,'original');
 const opts=base=>({method:'POST',headers,body:JSON.stringify({baseRevision:base,commands:[{op:'add',clip:{id:'title',track:'graphic',start:0,duration:10,text:'开头'}}]})});
 const route=origin+'/api/projects/'+p.id+'/edits';
 assert.equal((await fetch(route,opts(1))).status,200);assert.equal((await fetch(route,opts(1))).status,409);
 service.store.setMeta(p.id,{facts:[{text:'公开报告',url:'https://example.org/report'},{url:'file:///private/secret'}]});
 const openFact=i=>fetch(origin+'/api/projects/'+p.id+'/facts/'+i+'/open',{method:'POST',headers,body:'{}'});
 assert.equal((await openFact(0)).status,200);assert.equal(sourceOpened,'https://example.org/report');
 assert.equal((await openFact(1)).status,422);assert.equal((await openFact(99)).status,404);
 assert.equal((await fetch(origin+'/blind/app.js',{headers})).status,200);
 assert.equal((await fetch(origin+'/api/jobs/unknown/file/video',{headers})).status,404);
});
test('render jobs freeze exact creative evidence, survive interruption, and keep revision-specific media',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'vs-queue-'));const store=createStore(root);
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const p=store.create({title:'任务',mode:'script'});store.setMeta(p.id,{directorNotes:[{type:'required',frame:0,message:'缺少片尾证据'}]});
 let calls=0, observed;const deps={store,director:{},media:{async renderProject(p,{output,signal}){calls++;
    if(calls===1)await new Promise((_,no)=>signal.addEventListener('abort',()=>no(new Error('pause')),{once:true}));
    await writeFile(output,'render');await writeFile(output+'.srt','');return {videoPath:output,srtPath:output+'.srt'};}},
    async reviewProject(p){observed=p;return {status:'unverified',label:'待复核',deliverable:false,issues:[]};}};
 const queue=createQueue(deps);const j=queue.enqueue(p.id,'render',{baseRevision:1});await awaitJob(store,j.id,'running');await delay(20);queue.pause(j.id);await awaitJob(store,j.id,'paused');
 store.configure(p.id,1,{brief:'修改后的方向'});queue.resume(j.id);const done=await awaitJob(store,j.id,'done');await queue.close();
 assert.equal(done.stale,true);assert.equal(done.revision,1);assert.equal(observed.directorNotes[0].type,'required');assert.ok(done.files.project.endsWith('project.vstudio.json'));
 store.saveJob({...j,id:'lost-creative',phase:'creative',status:'running',input:{engine:'codex'}});
 const next=createQueue(deps);next.recover();assert.equal(store.getJob('lost-creative').status,'paused');assert.throws(()=>next.resume('lost-creative'),/检查/);await next.close();
});
test('the system releases an interrupted owner lock and a second instance cannot take an open database',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'vs-owner-'));await writeFile(path.join(root,'service.pid'),'');
  const app=await startStudio({root});try{await assert.rejects(startStudio({root}),/已由打开/);}finally{await app.close();}
  const restarted=await startStudio({root});await restarted.close();await rm(root,{recursive:true,force:true});
});
test('the local assembly remains a playable draft and records its engine in the portable project', async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'vs-local-draft-'));
  const store=createStore(root,{probeMedia:async()=>({kind:'image',duration:0,width:160,height:90})});
  const p=store.create({mode:'topic',title:'验证草稿',settings:{engine:'local'}});
  const source=path.join(root,'source.png');await writeFile(source,'fixture');
  const asset=await store.addAsset(p.id,source);
  const director={async run(id){
    store.apply(id,store.get(id).revision,[{op:'add',clip:{id:'photo',track:'video',assetId:asset.id,start:0,duration:24}}],'codex');
    return {engine:'local',message:'素材顺排'};
  }};
  const queue=createQueue({store,director,deliveryRoot:path.join(root,'deliveries'),
    media:{async renderProject(_p,{output}){await writeFile(output,'video');await writeFile(output+'.srt','');return {videoPath:output,srtPath:output+'.srt'};}},
    reviewProject:async()=>({deliverable:true,label:'可交付',issues:[]})});
  t.after(async()=>{await queue.close();store.close();await rm(root,{recursive:true,force:true});});
  const queued=queue.enqueue(p.id,'produce');
  assert.equal(queued.input.engine,'local');
  const done=await awaitJob(store,queued.id,'done');
  assert.ok(done.files.video);
  assert.equal(done.published,undefined);
  assert.equal(done.snapshot.lastDirection.engine,'local');
  const explicit=await awaitJob(store,queue.enqueue(p.id,'render',{engine:'local'}).id,'done');
  assert.ok(explicit.published.video);
});
test('a spoken change during local export starts an actual creative revision on the current timeline',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'vs-redirect-'));
  const store=createStore(root);
  const p=store.create({mode:'script',title:'途中改稿'});
  store.apply(p.id,p.revision,[{op:'add',clip:{id:'line',track:'caption',text:'原句',start:0,duration:10}}]);
  let rendering;
  const ready=new Promise(resolve=>{rendering=resolve;});
  let directing,release;
  const received=new Promise(resolve=>{directing=resolve;});
  const director={async run(_id,input){directing(input);await new Promise(resolve=>{release=resolve;input.signal.addEventListener('abort',resolve,{once:true});});return {};}};
  const media={async renderProject(_p,{signal}){rendering();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}};
  const queue=createQueue({store,media,director,reviewProject(){}});
  t.after(async()=>{release?.();await queue.close();store.close();await rm(root,{force:true,recursive:true});});
  const job=queue.enqueue(p.id,'render',{engine:'local'});
  await ready;
  const newJob=await queue.redirect(job.id,{message:'保留原声，改成特写'});
  const actual=await received;
  assert.equal(actual.engine,'codex');assert.equal(actual.message,'保留原声，改成特写');
  assert.equal(store.getJob(job.id).status,'paused');assert.equal(newJob.revision,2);
});
