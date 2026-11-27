import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createStore} from '../src/project.mjs';
import {draftPreviews} from '../src/draft-preview.mjs';
import {timelinePlayback} from '../src/timeline-playback.mjs';
import {playbackIdentity,pictureIdentity} from '../src/playback-identity.mjs';
import {startStudio} from '../src/server.mjs';
import {createTimelinePlayer} from '../www/timeline-player.js';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
const hash=b=>createHash('sha256').update(b).digest('hex');
const fps=25,profile={width:320,height:180,fps};
const recording='frozen local file fixture',frames=337;
function populate(store){
  const fresh=store.create({mode:'script',profile}),p=store.apply(fresh.id,1,[{op:'add',clip:{id:'line',track:'caption',text:'第一个字',start:0,duration:frames}}]);
  return p;
}
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'vs-playback-')),records=[];
  const media={probeMedia:async()=>({kind:'video',frames,width:320,height:180,frameRate:fps,duration:frames/fps}),
    fileHash:async f=>hash(await readFile(f)),
    async renderProjectFrame(p,{frame,output,signal}){
      records.push({frame,revision:p.revision,signal});
      await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,24);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});
      await mkdir(path.dirname(output),{recursive:true});await writeFile(output,'frame '+p.revision+' '+frame);
    },
    async renderProject(p,{window,output}){records.push({window,revision:p.revision});await mkdir(path.dirname(output),{recursive:true});await writeFile(output,'window fixture');},
  };
  const app=await startStudio({root,dependencies:{media},owner:false}),first=await fetch(app.url,{redirect:'manual'});
  const origin=new URL(app.url).origin,headers={cookie:first.headers.get('set-cookie').split(';')[0]};
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  return {root,headers,store:app.store,p:populate(app.store),media,records,api:(u,options={})=>fetch(origin+u,{headers,...options})};
}
async function freeze(store,p){
  const directory=path.join(store.paths(p.id).outputs,'frozen-job');await mkdir(directory,{recursive:true});
  const file=path.join(directory,'video.mp4');await writeFile(file,recording);
  store.saveJob({id:'frozen-job',projectId:p.id,kind:'render',status:'done',revision:p.revision,snapshot:p,
    qa:{candidatePlayable:true,artifactSha256:hash(recording)},files:{video:file}});
  return file;
}
const route=(p,f,mode='still')=>'/api/projects/'+p.id+'/playback?revision='+p.revision+'&frame='+f+'&mode='+mode;
test('HTTP selects an identical frozen cut, handles byte ranges and refuses it after a content edit or replacement',async t=>{
  const {store,headers,api,p,records}=await fixture(t),file=await freeze(store,p);
  let d=await (await api(route(p,234))).json();
  assert.equal(d.source,'cut');assert.deepEqual([d.fromFrame,d.toFrame,d.fps],[0,frames,fps]);
  assert.equal((await (await api(d.url)).text()),recording);
  const partial=await api(d.url,{headers:{...headers,range:'bytes=2-5'}});assert.equal(partial.status,206);assert.equal(await partial.text(),recording.slice(2,6));
  const locked=store.apply(p.id,p.revision,[{op:'lock',id:'line',locked:true}]);
  assert.equal(playbackIdentity(p),playbackIdentity(locked));
  assert.equal((await api(d.url)).status,409);
  d=await (await api(route(locked,234))).json();assert.equal(d.source,'cut');
  await writeFile(file,'tampered local data');
  assert.equal((await api(d.url)).status,404);assert.equal((await (await api(route(locked,234))).json()).source,'frame');
  const unlocked=store.apply(p.id,locked.revision,[{op:'lock',id:'line',locked:false}]);
  const changed=store.apply(p.id,unlocked.revision,[{op:'update',id:'line',changes:{text:'第二个字'}}]);
  await writeFile(file,recording);
  assert.notEqual(playbackIdentity(changed),playbackIdentity(p));
  const still=await (await api(route(changed,111))).json();
  assert.equal(still.source,'frame');assert.equal(await (await api(still.url)).text(),'frame '+changed.revision+' 111');
  assert.equal((await api(route(changed,frames))).status,422);
  const first=await (await api(route(changed,149,'play'))).json(),next=await (await api(route(changed,150,'play'))).json();
  const last=await (await api(route(changed,299,'play'))).json();
  assert.deepEqual([first.fromFrame,first.toFrame,next.fromFrame,next.toFrame,last.fromFrame,last.toFrame],[149,299,149,299,299,337]);
  assert.equal(records.filter(r=>r.window).length,2);
  assert.equal((await (await api(route(changed,179))).json()).source,'window');
});
test('a voice-only edit can reuse the frozen picture until a changed layer or end clock alters the image',()=>{
  const shot={id:'shot',track:'video',assetId:'camera',start:0,duration:100};
  const voice={id:'voice',track:'narration',assetId:'sound',start:10,duration:40};
  const project=clips=>({profile,assets:[{id:'camera',sha256:hash('camera')},{id:'sound',sha256:hash('sound')}],timeline:{clips}});
  const before=project([shot,voice]),after=project([shot,{...voice,start:12}]);
  assert.notEqual(playbackIdentity(before),playbackIdentity(after));
  assert.equal(pictureIdentity(before),pictureIdentity(after));
  assert.notEqual(pictureIdentity(before),pictureIdentity(project([shot,{...voice,start:95,muted:true}])));
  assert.notEqual(pictureIdentity(before),pictureIdentity(project([{...shot,sourceIn:1},voice])));
  assert.notEqual(pictureIdentity(before),pictureIdentity({...after,assets:[{id:'camera',sha256:hash('other')}]}));
  assert.equal(pictureIdentity({...before,assets:[]}),null);
});
test('independent QA renders the same time span even after frozen-picture playback has populated its cache',async t=>{
  const {p,store,media,records}=await fixture(t),drafts=draftPreviews(store,media);
  t.after(()=>drafts.close());
  const playback=await drafts.segment(p,0,undefined,'verified-frozen-picture.mp4');
  const comparison=await drafts.open(p,0);
  assert.deepEqual([comparison.fromFrame,comparison.toFrame],[playback.fromFrame,playback.toFrame]);
  assert.notEqual(playback.name,comparison.name);
  assert.equal(records.filter(r=>r.window).length,2);
});

test('requests share their exact frame, cancel a superseded worker and reject a completed result on an old revision',async t=>{
  const {p,store,media,records}=await fixture(t),drafts=draftPreviews(store,media),service=timelinePlayback(store,media,drafts);
  t.after(()=>drafts.close());
  const a=new AbortController(),b=new AbortController();
  const one=drafts.still(p,12,a.signal),two=drafts.still(p,12,b.signal);
  while(!records.length)await delay(2);
  a.abort();await assert.rejects(one,{name:'AbortError'});await two;assert.equal(records.length,1);assert.equal(records[0].signal.aborted,false);
  const same=await drafts.still(p,12);assert.ok(same.name.endsWith('.jpg'));assert.equal(records.length,1);
  const cancel=new AbortController(),old=drafts.still(p,19,cancel.signal);
  while(records.length<2)await delay(2);cancel.abort();await assert.rejects(old,{name:'AbortError'});assert.equal(records[1].signal.aborted,true);
  const request=service.describe(p,{revision:p.revision,frame:41,mode:'still'});
  while(!records.some(r=>r.frame===41))await delay(2);
  store.apply(p.id,p.revision,[{op:'update',id:'line',changes:{start:1}}]);
  await assert.rejects(request,e=>e.status===409);
});

function testVideoHost(){
  class Element extends EventTarget {
    constructor(tag){super();this.tag=tag;this.style={};this.readyState=0;this.seeking=false;this.currentTime=0;this.complete=false;this.naturalWidth=0;}
    set src(value){this.source=value;if(this.tag==='img'){this.naturalWidth=10;this.complete=true;queueMicrotask(()=>this.dispatchEvent(new Event('load')));}}
    get src(){return this.source;}
    getAttribute(key){return key==='src'?this.source:null;}
    removeAttribute(key){if(key==='src'){this.source=null;this.complete=false;this.naturalWidth=0;}}
    load(){this.currentTime=0;this.readyState=this.source?4:0;}
    play(){this.paused=false;return Promise.resolve();}
    pause(){this.paused=true;}
    remove(){}
  }
  const children=[],doc={createElement:tag=>new Element(tag)},host={append:(...nodes)=>children.push(...nodes)};
  const video=new Element('video');video.ownerDocument=doc;video.parentElement=host;children.push(video);
  return {video,children};
}
test('controller uses project frame time through a window seam, ignores stale drags and discards media when the revision changes',async()=>{
  const {video,children}=testVideoHost(),states=[],calls=[],framesSeen=[];
  const p={id:'work',revision:2,profile,timeline:{clips:[{id:'c',start:0,duration:frames}]}};
  const request=async raw=>{
    const u=new URL(raw,'http://localhost'),f=Number(u.searchParams.get('frame')),revision=Number(u.searchParams.get('revision'));
    const still=u.searchParams.get('mode')==='still',from=still?f:Math.floor(f/150)*150;calls.push({f,revision});
    if(f===19)await delay(35);
    return {ok:true,json:async()=>({source:still?'frame':'window',url:'/media-'+revision+'-'+from+(still?'.jpg':'.mp4'),
      revision,frame:f,fromFrame:from,toFrame:Math.min(frames,still?from+1:from+150),fps,length:frames})};
  };
  const player=createTimelinePlayer({project:p,video,onState:s=>states.push(s),onFrame:f=>framesSeen.push(f),request});
  const wait=async condition=>{for(let i=0;i<100&&!condition();i++)await delay(3);assert.ok(condition());};
  try{
    await wait(()=>states.at(-1)?.status==='paused');
    const outdated=player.seek(19);await player.seek(148);await outdated;
    assert.equal(states.at(-1).frame,148);assert.equal(children.find(c=>c.tag==='img'&&c.style.display!=='none').src,'/media-2-148.jpg');
    await player.play();await wait(()=>calls.some(c=>c.f===150));assert.equal(player.playing,true);
    children[0].dispatchEvent(new Event('ended'));await wait(()=>states.at(-1)?.status==='playing'&&states.at(-1).frame===150);
    children[1].currentTime=.2;children[1].dispatchEvent(new Event('timeupdate'));assert.equal(player.frame,155);
    await player.pause();await player.step(-1);assert.equal(player.frame,154);
    player.setProject({...p,revision:3});await wait(()=>states.at(-1)?.source==='frame'&&states.at(-1).status==='paused');
    assert.equal(children.find(c=>c.tag==='img'&&c.style.display!=='none').src,'/media-3-154.jpg');assert.ok(framesSeen.includes(150));
  }finally{player.destroy();}
});
test('slow cold scrubbing shows intermediate samples without a blank, drops reversed targets and clears immediately on an edit',async()=>{
  const {video,children}=testVideoHost();
  const p={id:'scrub',revision:1,profile,timeline:{clips:[{start:0,duration:frames}]}};
  const samples=[],started=[],states=[];
  const request=async raw=>{
    const q=new URL(raw,'http://localhost').searchParams,f=Number(q.get('frame')),revision=Number(q.get('revision'));started.push(f);
    await delay(70);
    return {ok:true,json:async()=>({source:'frame',url:'/still-'+revision+'-'+f+'.jpg',fromFrame:f,toFrame:f+1,frame:f,revision,fps,length:frames})};
  };
  const player=createTimelinePlayer({project:p,video,request,onState:s=>{
    states.push(s);
    if(s.status==='scrubbing'&&s.displayedFrame!=null&&samples.at(-1)!==s.displayedFrame)samples.push(s.displayedFrame);
  }}),shown=()=>children.find(c=>c.tag==='img'&&c.style.display!=='none'&&c.naturalWidth>0);
  const wait=async done=>{for(let i=0;i<130&&!done();i++)await delay(3);assert.ok(done());};
  try{
    await wait(()=>states.at(-1)?.status==='paused');
    for(let f=10;f<=80;f+=2){player.seek(f,{scrub:true});assert.ok(shown());await delay(9);}
    await player.seek(81);assert.equal(player.displayedFrame,81);
    assert.ok(samples.filter(f=>f>0&&f<80).length>=3,JSON.stringify(samples));
    assert.ok(started.length<16,'queued every transient target');
    player.seek(140,{scrub:true});await wait(()=>started.includes(140));
    player.seek(48,{scrub:true});await wait(()=>player.displayedFrame===48);
    assert.ok(!samples.includes(140),'reversed stale sample was painted');
    player.setProject({...p,revision:2});assert.equal(player.displayedFrame,null);assert.equal(shown(),undefined);
    await wait(()=>states.at(-1)?.status==='paused');assert.equal(shown().src,'/still-2-48.jpg');
  }finally{player.destroy();}
});

test('revision stream publishes the committed project only and catches up on reconnect',async t=>{
  const {p,store,api}=await fixture(t);
  const route='/api/projects/'+p.id+'/revisions';
  const ctl=new AbortController();t.after(()=>ctl.abort());
  const res=await api(route,{signal:ctl.signal});assert.equal(res.headers.get('content-type'),'text/event-stream');
  const reader=res.body.pipeThrough(new TextDecoderStream()).getReader();
  const announced=async()=>Number((await reader.read()).value.trim().slice(6));
  assert.equal(await announced(),p.revision);
  const edit=text=>({op:'update',id:'line',changes:{text}});
  assert.throws(()=>store.apply(p.id,p.revision,[edit('未提交'),{op:'remove',id:'missing'}]),/改变/);
  const other=populate(store);store.apply(other.id,other.revision,[edit('其他工程')]);
  store.setMeta(p.id,{directorNotes:'progress'});
  const committed=store.applySceneEdit(p.id,p.revision,[edit('新提交')],{},'codex');
  assert.equal(await announced(),committed.revision);
  await reader.cancel();ctl.abort();
  const latest=store.apply(p.id,committed.revision,[edit('离线期间提交')]);
  const back=await api(route);const replay=back.body.pipeThrough(new TextDecoderStream()).getReader();
  assert.equal((await replay.read()).value,'data: '+latest.revision+'\n\n');await replay.cancel();
});

test('a legacy frozen cut with stretched lettering is replaced by a live frame until a corrected export exists',async t=>{
  const {store,p,media}=await fixture(t);
  const raw={id:'legacy-label',track:'graphic',start:0,duration:frames,
    geometry:{x:.5,y:.5,width:.39,height:.025},motion:{componentId:'hot-source-label',props:{}}};
  const legacy={...p,timeline:{clips:[raw]}};
  await freeze(store,legacy);
  const drafts=draftPreviews(store,media),player=timelinePlayback(store,media,drafts);
  t.after(()=>drafts.close());
  const options={revision:legacy.revision,frame:12,mode:'still'};
  assert.equal((await player.describe(legacy,options)).source,'frame');
  store.saveJob({...store.getJob('frozen-job'),textAspectVersion:1});
  assert.equal((await player.describe(legacy,options)).source,'cut');
});
