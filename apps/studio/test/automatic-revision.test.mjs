import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startStudio } from '../src/server.mjs';
import { mediaCapabilities } from '../src/media.mjs';
import { createStore } from '../src/project.mjs';

const fingerprint = data => createHash('sha256').update(data).digest('hex');
const published = root => readdir(path.join(root,'deliveries')).catch(error => {
  if(error.code === 'ENOENT')return [];
  throw error;
});
const placeholder = Buffer.from('P6\n48 32\n255\n', 'ascii');
const still = Buffer.concat([placeholder, Buffer.alloc(48 * 32 * 3, 80)]);

async function waitFor(read, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(16);
  }
  throw Error('Timed out waiting for ' + description);
}

function barrier() {
  let unblock, entered=false;
  const release = new Promise(resolve => { unblock = resolve; });
  return { get started(){return waitFor(()=>entered,'the controlled fixture checkpoint');}, unblock, async hold(signal) {
    entered=true;
    signal.throwIfAborted();
    let abort;
    try {
      await Promise.race([release, new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', abort); }
  }};
}

// A tiny fixture with neutral grey media. Only the first test uses a real
// encoder and decoder; the other jobs isolate queue, revision and recovery behaviour.
async function workbench(t, { actualMedia = false, direction, review, rendering, afterFirst } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-auto-revision-'));
  let service, origin, cookie, renderCount = 0, reviewCount = 0;
  const calls = [], renders = [];
  const probe = async () => ({kind:'image', width:48, height:32, duration:.04, hasAudio:false});
  const deps = { director: { close(){}, async run(id, options) {
    calls.push({id, jobId: options.jobId, kind: options.kind, candidate: options.reviewCandidate});
    const p = service.store.get(id);
    if (options.kind === 'produce') {
      service.store.apply(id, p.revision, [
        {op:'add',clip:{id:'picture',track:'video',assetId:p.assets[0].id,start:0,duration:18,muted:true}},
        {op:'add',clip:{id:'caption',track:'caption',text:'First',start:0,duration:18,style:{fontSize:32}}},
      ], 'codex');
      await afterFirst?.(service.store, id, options);
    } else if (direction) {
      await direction(service.store, id, options);
    }
    return {engine:options.engine, message:'Fixture direction'};
  }}};
  if (!actualMedia) {
    deps.probeMedia = probe;
    deps.media = { async renderProject(p, {output, signal}) {
      renders.push(p.timeline.clips.map(c => [c.id,c.text]));
      await rendering?.(p, ++renderCount, signal);
      const captions = p.timeline.clips.filter(c => c.track === 'caption').map(c=>c.text).join('\n');
      await writeFile(output, 'queue fixture\n'+captions);
      const srtPath = output+'.srt';
      await writeFile(srtPath, captions);
      return {videoPath:output, srtPath};
    }};
    deps.reviewProject = async (p, options) => {
      const data = await readFile(options.videoPath);
      const result = {revision:p.revision, candidatePlayable:true, status:'deliverable', label:'可交付', deliverable:true,
        artifactSha256:fingerprint(data), issues:[], repairs:[]};
      return {...result, ...await review?.(p, ++reviewCount, options.signal)};
    };
  }
  async function open() {
    service = await startStudio({root, dependencies:deps});
    origin = new URL(service.url).origin;
    const login = await fetch(service.url, {redirect:'manual'});
    assert.equal(login.status,303);
    cookie = login.headers.get('set-cookie').split(';')[0];
  }
  await open();
  t.after(async () => { await service.close(); await rm(root,{recursive:true,force:true}); });
  async function request(route, body, {raw=false, status}={}) {
    const response = await fetch(origin+route, {
      method:body===undefined?'GET':'POST', headers:{origin,cookie,'content-type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),
    });
    if(status!==undefined){assert.equal(response.status,status);return response;}
    if(!response.ok)throw Error(route+' '+response.status+' '+await response.text());
    return raw?Buffer.from(await response.arrayBuffer()):response.json();
  }
  async function create(settings={}, lock=false) {
    const p=await request('/api/projects',{title:'Queue regression',mode:'script',profile:{width:192,height:108,fps:18},
      settings:{shareFrames:true,shareTranscript:false,voiceMode:'original',...settings}});
    const route='/api/projects/'+p.id;
    const upload=await fetch(origin+route+'/assets',{method:'POST',headers:{origin,cookie,'x-file-name':'neutral.ppm'},body:still});
    assert.equal(upload.status,201);
    const current=await request(route);
    if(!lock)return current;
    return request(route+'/edits',{baseRevision:current.revision,commands:[
      {op:'add',clip:{id:'user-graphic',track:'graphic',text:'LOCK',start:0,duration:18,geometry:{x:.18,y:.15},style:{fontSize:16}}},
      {op:'lock',id:'user-graphic',locked:true},
    ]});
  }
  const jobs=p=>request('/api/projects/'+p.id+'/jobs');
  const enqueue=(p,kind='produce',extra={})=>request('/api/projects/'+p.id+'/jobs',{kind,engine:'codex',baseRevision:p.revision,...extra});
  const getJob=id=>request('/api/jobs/'+id);
  async function done(id) {
    return waitFor(async()=>{
      const j=await getJob(id);
      if(j.status==='failed')throw Error('Job failed: '+j.error);
      return j.status==='done'&&j;
    },'finished '+id,actualMedia ? 60000 : 12000);
  }
  const file=(id,key)=>request('/api/jobs/'+id+'/file/'+key,undefined,{raw:true});
  return { root, calls,renders,request,create,jobs,enqueue,getJob,done,file,
    get store(){return service.store;},
    async restart(asInterrupted) {
      await service.close();
      if(asInterrupted)await asInterrupted(root);
      await open();
    }
  };
}

test('a real HTTP production freezes a decoded A, makes one same-project revision, and preserves its locked edit and export',async t=>{
  if(!(await mediaCapabilities()).ready)return t.skip('FFmpeg and FFprobe are required for the real candidate case.');
  const gate=barrier();
  let observed;
  const work=await workbench(t,{actualMedia:true,async direction(store,id,options){
    observed=options.reviewCandidate;
    await gate.hold(options.signal);
    const p=store.get(id);
    assert.throws(()=>store.apply(id,p.revision,[{op:'remove',id:'user-graphic'}],'codex'),/锁/);
    store.apply(id,p.revision,[{op:'update',id:'caption',changes:{text:'Second'}}],'codex');
  }});
  const p=await work.create({},true);
  assert.equal(p.settings.autoReview,true);
  const a=await work.enqueue(p);
  const first=await work.done(a.id);
  await waitFor(()=>observed,'the reviewed source candidate');
  const before={};
  for(const key of ['video','subtitle','project','review']) before[key]=await work.file(a.id,key);
  const qa=JSON.parse(before.review),manifest=JSON.parse(before.project);
  assert.equal(qa.candidatePlayable,true);
  assert.equal(fingerprint(before.video),qa.artifactSha256);
  assert.equal(first.cutRole,'first');
  assert.equal(first.revision,manifest.revision);
  assert.equal(manifest.timeline.clips.find(c=>c.id==='caption').text,'First');
  assert.equal(manifest.timeline.clips.find(c=>c.id==='user-graphic').locked,true);
  assert.equal(observed.jobId,a.id);
  assert.equal(observed.revision,first.revision);
  assert.equal(observed.sha256,fingerprint(before.video));
  assert.equal(observed.feedback?.audio?.finalTranscript,undefined);
  assert.equal(fingerprint(await readFile(observed.videoPath)),observed.sha256);
  assert.equal(work.calls[0].candidate,undefined);
  assert.equal(work.calls[1].kind,'revise');
  assert.equal(work.calls[1].id,p.id);
  assert.notEqual(work.calls[1].jobId,a.id);
  gate.unblock();
  const second=await work.done(first.reviewJobId);
  assert.equal(second.cutRole,'self-review');
  assert.equal(second.firstCutId,a.id);
  assert.equal(second.input.baseRevision,first.revision);
  assert.equal(second.revision,first.revision+1);
  const revised=JSON.parse(await work.file(second.id,'project'));
  assert.deepEqual(revised.timeline.clips.find(c=>c.id==='user-graphic'),manifest.timeline.clips.find(c=>c.id==='user-graphic'));
  assert.equal(revised.timeline.clips.find(c=>c.id==='caption').text,'Second');
  const video=await work.file(second.id,'video');
  assert.notEqual(fingerprint(video),fingerprint(before.video));
  assert.equal(JSON.parse(await work.file(second.id,'review')).artifactSha256,fingerprint(video));
  for(const key of Object.keys(before))assert.deepEqual(await work.file(a.id,key),before[key]);
  assert.equal((await work.jobs(p)).length,2);
  assert.deepEqual(work.calls.map(c=>c.kind),['produce','revise']);
});

test('an edit and privacy change during A review cannot silently start an editor against a stale project',async t=>{
  const gate=barrier();
  const work=await workbench(t,{async review(_p,count,signal){if(count===1)await gate.hold(signal);}});
  const p=await work.create();
  const a=await work.enqueue(p);
  await gate.started;
  const route='/api/projects/'+p.id;
  const latest=await work.request(route);
  const locked=await work.request(route+'/edits',{baseRevision:latest.revision,commands:[{op:'lock',id:'caption',locked:true}]});
  await work.request(route+'/configure',{baseRevision:locked.revision,changes:{settings:{...locked.settings,shareFrames:false}}});
  gate.unblock();
  const first=await work.done(a.id);
  assert.equal(first.stale,true);
  const current=await work.request(route);
  assert.equal(current.timeline.clips.find(c=>c.id==='caption').locked,true);
  assert.equal(current.settings.shareFrames,false);
  assert.equal((await work.jobs(p)).length,1);
  assert.equal(work.calls.length,1);
  assert.equal(JSON.parse(await work.file(a.id,'project')).revision,first.revision);
});

test('pausing B during export and restarting renders its saved revision without repeating either Codex turn',async t=>{
  const gate=barrier();
  const work=await workbench(t,{async rendering(_p,count,signal){if(count===2)await gate.hold(signal);},
    async direction(store,id){const p=store.get(id);store.apply(id,p.revision,[{op:'update',id:'caption',changes:{text:'Revised'}}],'codex');}});
  const p=await work.create(),a=await work.enqueue(p),first=await work.done(a.id);
  await gate.started;
  const saved=await work.file(a.id,'video');
  assert.deepEqual(await published(work.root),[]);
  const route='/api/jobs/'+first.reviewJobId;
  await work.request(route+'/pause',{});
  await waitFor(async()=> (await work.getJob(first.reviewJobId)).status==='paused','paused revision export');
  await work.restart();
  await work.request(route+'/resume',{});
  const second=await work.done(first.reviewJobId);
  assert.equal(second.firstCutId,a.id);
  assert.match((await work.file(second.id,'subtitle')).toString(),/Revised/);
  assert.deepEqual(await work.file(a.id,'video'),saved);
  assert.equal((await published(work.root)).length,1);
  assert.equal((await work.jobs(p)).length,2);
  assert.deepEqual(work.calls.map(c=>c.kind),['produce','revise']);
});

test('A is the first playable encoding even when its quality report offers a deterministic repair; an unchanged B is kept once',async t=>{
  const work=await workbench(t,{async review(_p,count){if(count===1)return{status:'repair',label:'需修复',deliverable:false,
    issues:[{id:'test-only',severity:'major',message:'synthetic quality finding'}],repairs:[{kind:'regenerate-subtitles',reason:'synthetic repair'}]};}});
  const p=await work.create(),a=await work.enqueue(p),first=await work.done(a.id);
  assert.equal(first.repairs,0);
  assert.equal(first.qa.deliverable,false);
  const second=await work.done(first.reviewJobId);
  assert.deepEqual(await work.file(a.id,'video'),await work.file(second.id,'video'));
  const original=JSON.parse(await work.file(a.id,'project')),copy=JSON.parse(await work.file(second.id,'project'));
  assert.deepEqual(original.timeline,copy.timeline);
  assert.deepEqual(original.assets,copy.assets);
  assert.equal(original.revision,copy.revision);
  assert.equal((await work.jobs(p)).length,2);
  assert.equal(work.renders.length,2);
  assert.equal(work.calls.length,2);
});

test('ordinary editing, non-playable files, local generation and declined frame sharing cannot create an automatic model turn',async t=>{
  const work=await workbench(t,{async review(p){if(p.settings.autoReview&&p.brief==='unplayable')return {candidatePlayable:false,deliverable:false};}});
  for(const mode of ['private','disabled','local','unplayable']){
    let p=await work.create({shareFrames:mode!=='private',autoReview:mode!=='disabled'});
    if(mode==='unplayable')p=await work.request('/api/projects/'+p.id+'/configure',{baseRevision:p.revision,changes:{brief:'unplayable'}});
    await work.done((await work.enqueue(p,'produce',{engine:mode==='local'?'local':'codex'})).id);
    assert.equal((await work.jobs(p)).length,1,mode);
  }
  const p=await work.create({autoReview:false});
  await work.request('/api/projects/'+p.id+'/jobs',{kind:'revise',reviewCandidate:{jobId:'other-project-fixture'}},{status:422});
  const a=await work.enqueue(p);await work.done(a.id);
  const route='/api/projects/'+p.id,current=await work.request(route);
  let enabled=await work.request(route+'/configure',{baseRevision:current.revision,changes:{settings:{...current.settings,autoReview:true}}});
  for(const kind of ['preview','render','revise']){
    await work.done((await work.enqueue(enabled,kind)).id);
    enabled=await work.request(route);
  }
  assert.equal((await work.jobs(p)).length,4);
});

test('recovery refuses another job’s old turn receipt and keeps self-review bound to Codex',async t=>{
  const gate=barrier();
  let attempts=0;
  const work=await workbench(t,{
    afterFirst(store,id,{jobId}){store.setMeta(id,{directorState:{jobId,turnId:'only-first',edited:true}});},
    async direction(_store,_id,opts){if(++attempts===1)await gate.hold(opts.signal);},
  });
  const p=await work.create(),a=await work.enqueue(p),first=await work.done(a.id);
  await gate.started;
  const secondId=first.reviewJobId, route='/api/jobs/'+secondId;
  const frozen=await work.file(a.id,'video');
  // Simulate the process disappearing after dispatch, before the new turn receives a receipt.
  await work.restart(async root=>{
    const db=createStore(root);
    try{const j=db.getJob(secondId);db.saveJob({...j,status:'running',phase:'creative'});}
    finally{db.close();}
  });
  assert.equal((await work.getJob(secondId)).status,'paused');
  assert.equal(attempts,1);
  await work.request(route+'/resume',{}, {status:409});
  await work.request(route+'/resume',{engine:'local'},{status:422});
  await work.request(route+'/resume',{confirmRetry:true});
  const complete=await work.done(secondId);
  assert.equal(complete.firstCutId,a.id);
  assert.deepEqual(await work.file(a.id,'video'),frozen);
  assert.equal((await work.jobs(p)).length,2);
});

test('saving the first-cut link and its child is a single database transaction',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'studio-cut-commit-'));
  const store=createStore(root);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const p=store.create({mode:'script',title:'transaction fixture'});
  const running={id:'first',projectId:p.id,status:'running',phase:'review',cutRole:'first'};
  store.saveJob(running);
  const first={...running,status:'done',phase:'done',reviewJobId:'review'};
  const second={id:'review',projectId:p.id,status:'queued',phase:'creative',cutRole:'self-review',firstCutId:first.id};
  assert.throws(()=>store.saveCutPair(first,{...second,id:''}));
  assert.deepEqual(store.getJob(first.id),running);
  assert.equal(store.listJobs(p.id).length,1);
  store.saveCutPair(first,second);
  assert.deepEqual(store.getJob(first.id),first);
  assert.deepEqual(store.getJob(second.id),second);
});

test('a user edit during the revised export preserves both frozen candidates and prevents stale automatic publication',async t=>{
  const gate=barrier();
  const work=await workbench(t,{async rendering(_p,count,signal){if(count===2)await gate.hold(signal);},
    async direction(store,id){const p=store.get(id);store.apply(id,p.revision,[{op:'update',id:'caption',changes:{text:'B'}}],'codex');}});
  const p=await work.create(),a=await work.enqueue(p),first=await work.done(a.id);
  await gate.started;
  const route='/api/projects/'+p.id, previous=await work.request(route);
  const user=await work.request(route+'/edits',{baseRevision:previous.revision,commands:[
    {op:'update',id:'caption',changes:{text:'user edit during B export'}},{op:'lock',id:'caption',locked:true},
  ]});
  gate.unblock();
  const second=await work.done(first.reviewJobId);
  assert.equal(second.stale,true);
  assert.equal(second.revision,previous.revision);
  assert.equal(user.revision,previous.revision+1);
  assert.equal(JSON.parse(await work.file(a.id,'project')).timeline.clips.find(c=>c.id==='caption').text,'First');
  assert.equal(JSON.parse(await work.file(second.id,'project')).timeline.clips.find(c=>c.id==='caption').text,'B');
  const current=await work.request(route);
  assert.equal(current.timeline.clips.find(c=>c.id==='caption').text,'user edit during B export');
  assert.equal(current.timeline.clips.find(c=>c.id==='caption').locked,true);
  assert.deepEqual(await published(work.root),[]);
});
