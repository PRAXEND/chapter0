import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../src/project.mjs';
import {sampleClock} from '../src/clip-edit.mjs';
import {graphicKeys} from '../src/graphic-keys.mjs';
import {componentClip} from '../src/motion-components.mjs';
import {startStudio} from '../src/server.mjs';

async function fixture(t,style){
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-timeline-'));
  const probeMedia=async file=>({kind:file.endsWith('.wav')?'audio':'video',hasAudio:true,duration:5,width:320,height:180});
  let store=createStore(root,{probeMedia});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const p=store.create({mode:'script',profile:{width:320,height:180,fps:30},style});
  const asset=async ext=>{const file=path.join(root,'source.'+ext);await writeFile(file,'fixture '+ext);return store.addAsset(p.id,file);};
  return {p,asset,get store(){return store;},
    reopen(){store.close();store=createStore(root,{probeMedia});},
    edit(commands,actor){return store.apply(p.id,store.get(p.id).revision,commands,actor);},
    undo(){return store.undo(p.id,store.get(p.id).revision);},redo(){return store.redo(p.id,store.get(p.id).revision);}};
}
const clip=(p,id)=>p.timeline.clips.find(c=>c.id===id);
const caption=(id,start,duration=10)=>({id,track:'caption',text:id,start,duration});
const add=clip=>({op:'add',clip});

test('a user batch can undo/redo after restart without rewinding director edits, imports or job snapshots',async t=>{
  const f=await fixture(t),v=await f.asset('mov');
  const picture={id:'v',track:'video',assetId:v.id,start:3,duration:20,sourceIn:6,speed:1.25};
  f.edit([add(picture),add(caption('title',1))],'codex');
  const changed=f.edit([{op:'move',id:'v',start:8},{op:'update',id:'title',changes:{text:'新标题'}}]);
  assert.equal(f.store.history(f.p.id).undoLabel,'批量编辑（2 项）');
  f.edit([{op:'update',id:'v',changes:{gain:.4}},add(caption('credits',30))],'codex');
  await f.asset('wav');
  f.store.setMeta(f.p.id,{threadId:'still-current',directorNotes:[{message:'保留'}]});
  f.store.configure(f.p.id,f.store.get(f.p.id).revision,{settings:{shareFrames:true}});
  f.reopen();
  const before=f.store.get(f.p.id);
  assert.throws(()=>f.store.undo(f.p.id,changed.revision),{status:409});
  const reverted=f.undo();assert.equal(reverted.revision,before.revision+1);
  assert.equal(clip(reverted,'v').start,3);assert.equal(clip(reverted,'v').gain,.4);
  assert.equal(clip(reverted,'title').text,'title');assert.ok(clip(reverted,'credits'));
  assert.equal(reverted.assets.length,2);assert.equal(reverted.threadId,'still-current');
  assert.deepEqual(reverted.directorNotes,[{message:'保留'}]);assert.equal(reverted.settings.shareFrames,true);
  assert.equal(clip(f.store.revision(f.p.id,changed.revision),'v').start,8);
  f.reopen();assert.equal(f.store.history(f.p.id).canRedo,true);
  const again=f.redo();assert.equal(clip(again,'v').start,8);assert.equal(clip(again,'v').gain,.4);
  f.undo();
  f.edit([{op:'update',id:'title',changes:{text:'另一版'}}]);
  assert.equal(f.store.history(f.p.id).canRedo,false);assert.throws(()=>f.redo(),{status:409});
});

test('overlapping director writes conflict atomically; another clip can keep its own edits',async t=>{
  const f=await fixture(t);
  f.edit([add(caption('a',0)),add(caption('b',12))],'codex');
  const changed=f.edit([{op:'move',id:'a',start:2},{op:'move',id:'b',start:14}]);
  f.edit([{op:'move',id:'b',start:17}],'codex');
  const live=f.store.get(f.p.id);
  assert.equal(f.store.history(f.p.id).canUndo,false);
  assert.throws(()=>f.undo(),{status:409});
  assert.deepEqual(live,f.store.get(f.p.id));
  f.edit([{op:'move',id:'b',start:14}],'codex');
  assert.equal(f.store.history(f.p.id).canUndo,true);
  const reverted=f.undo();assert.deepEqual(reverted.timeline.clips.map(c=>c.start),[0,12]);
  assert.equal(clip(f.store.revision(f.p.id,changed.revision),'b').start,14);
  f.edit([{op:'lock',id:'a',locked:true}]);
  assert.throws(()=>f.edit([{op:'trim',id:'a',edge:'end',atFrame:6}]),{status:409});
  assert.throws(()=>f.edit([{op:'move',id:'a',start:4}],'codex'),{status:409});
  assert.equal(clip(f.undo(),'a').locked,false);assert.equal(clip(f.redo(),'a').locked,true);
});

test('fractional-speed split/trim preserve source endpoints and original sampling phase on audio and video',async t=>{
  const f=await fixture(t),video=await f.asset('mov'),audio=await f.asset('wav');
  const v={id:'take',assetId:video.id,track:'video',start:20,duration:44,sourceIn:7,speed:1.25,
    transition:{type:'dissolve',duration:8},framing:{from:{x:.4,y:.5,zoom:1.2},to:{x:.6,y:.5,zoom:2.1}}};
  const n={id:'voice',assetId:audio.id,track:'narration',start:20,duration:44,sourceIn:7,speed:1.25,muted:false,gain:.45};
  f.edit([add(v),add(n)]);
  let p=f.edit([{op:'split',id:'take',atFrame:25,newId:'tail'},{op:'split',id:'voice',atFrame:25,newId:'answer'}]);
  for(const id of ['take','tail','voice','answer'])assert.deepEqual(sampleClock(clip(p,id)),{start:20,duration:44,sourceIn:7});
  assert.equal(clip(p,'tail').sourceIn,13.25);assert.equal(clip(p,'answer').gain,.45);
  assert.equal(clip(p,'tail').transition.offsetFrames,5);assert.equal(clip(p,'tail').transition.duration,3);
  p=f.edit([{op:'trim',id:'tail',edge:'start',atFrame:29},{op:'trim',id:'tail',edge:'end',atFrame:36}]);
  const short=clip(p,'tail');assert.equal(short.sourceIn,18.25);assert.equal(short.duration,7);
  assert.deepEqual(sampleClock(short),{start:20,duration:44,sourceIn:7});assert.equal(short.transition,null);
  assert.ok(Math.abs(short.framing.from.x-(.4+.2*9/43))<1e-8);
  assert.ok(Math.abs(short.framing.to.x-(.4+.2*15/43))<1e-8);
  p=f.edit([{op:'move',id:'tail',start:60}]);assert.deepEqual(sampleClock(clip(p,'tail')),{start:51,duration:44,sourceIn:7});
  p=f.edit([{op:'speed',id:'tail',speed:1.5}]);
  const fast=clip(p,'tail');assert.equal(fast.duration,6);assert.equal(fast.sourceIn+fast.speed*fast.duration,27);
  assert.equal(fast.sampleWindow,null);assert.equal(fast.start,60);
  assert.throws(()=>f.edit([{op:'trim',id:'tail',edge:'start',atFrame:1}]),/原片开头/);
  assert.throws(()=>f.edit([{op:'trim',id:'tail',edge:'end',atFrame:200}]),/原片/);
  assert.equal(f.store.get(f.p.id).revision,p.revision);
});

test('source boundaries, crop/volume controls and extending both edges of a real audio source',async t=>{
  const f=await fixture(t),a=await f.asset('wav'),v=await f.asset('mov');
  f.edit([add({id:'bed',track:'music',assetId:a.id,start:10,sourceIn:10,duration:130,gain:.3}),add({id:'v',track:'video',assetId:v.id,start:0,duration:10})]);
  let p=f.edit([{op:'trim',id:'bed',edge:'start',atFrame:0},{op:'trim',id:'bed',edge:'end',atFrame:150},
    {op:'update',id:'v',changes:{fit:'cover',framing:{from:{x:.65,y:.5,zoom:2}},muted:true}}]);
  assert.equal(clip(p,'bed').sourceIn,0);assert.equal(clip(p,'bed').duration,150);assert.equal(clip(p,'v').muted,true);
  assert.equal(clip(p,'v').framing.from.zoom,2);
  assert.throws(()=>f.edit([{op:'trim',id:'bed',edge:'end',atFrame:151}]),/原片/);
  assert.throws(()=>f.edit([{op:'update',id:'v',changes:{fit:'wrong'}}]),{status:422});
  assert.throws(()=>f.edit([{op:'update',id:'v',changes:{muted:'false'}}]),{status:422});
  p=f.edit([{op:'update',id:'bed',changes:{track:'narration',gain:0}}]);
  assert.equal(clip(p,'bed').gain,0);assert.equal(clip(p,'bed').track,'narration');
  assert.throws(()=>f.edit([{op:'update',id:'bed',changes:{track:'video'}}]),/素材/);
});

test('captions and native graphic slices retain animated boundaries; JSX rejects time cuts without restarting cues',async t=>{
  const f=await fixture(t);
  const c={...caption('sub',20,30),keyframes:[{frame:4,x:.1,opacity:.2},{frame:24,x:.9,opacity:1}]};
  const g={id:'graphic',track:'graphic',text:'转',start:20,duration:30,keyframes:[{frame:0,rotation:0},{frame:30,rotation:720}]};
  const jsx=componentClip({id:'jsx',componentId:'staggered-explanation',start:66,duration:55},f.p.profile);
  f.edit([add(c),add(g),add(jsx)]);
  let p=f.edit([{op:'trim',id:'sub',edge:'start',atFrame:34},{op:'trim',id:'sub',edge:'end',atFrame:39},
    {op:'split',id:'graphic',atFrame:35,newId:'right'}]);
  assert.equal(clip(p,'sub').duration,5);assert.equal(graphicKeys(clip(p,'sub'))[0].x,.5);
  assert.equal(graphicKeys(clip(p,'graphic')).at(-1).rotation,360);assert.equal(graphicKeys(clip(p,'right'))[0].rotation,360);
  p=f.edit([{op:'trim',id:'sub',edge:'start',atFrame:31},{op:'split',id:'sub',atFrame:33,newId:'sub-right'}]);
  assert.equal(clip(p,'sub-right').text,'sub');
  for(const command of [{op:'trim',edge:'end',atFrame:100},{op:'split',atFrame:90,newId:'bad'},{op:'speed',speed:2}])
    assert.throws(()=>f.edit([{id:'jsx',...command}]),/JSX/);
  assert.equal(clip(f.edit([{op:'move',id:'jsx',start:93}]),'jsx').duration,55);
});

test('same-track ripple deletion moves only following clips and their bound events, with atomic lock/overlap protection',async t=>{
  const f=await fixture(t,{id:'henry-technical-explainer',version:8}),a=await f.asset('wav');
  const owner=componentClip({id:'owner',componentId:'impact-title',start:40,duration:50,soundDesign:{assetId:a.id}},f.p.profile);
  const head={id:'gap',track:'graphic',text:'删',start:10,duration:12};
  let p=f.edit([add(head),add(owner),add(caption('caption',65)),add({id:'bed',track:'music',assetId:a.id,start:90,duration:15})]);
  const cue=p.timeline.clips.find(c=>c.soundBinding);assert.equal(cue.start,40);
  f.edit([{op:'lock',id:cue.id,locked:true}]);
  const locked=f.store.get(f.p.id);
  assert.throws(()=>f.edit([{op:'ripple-remove',id:'gap'}]),{status:409});assert.deepEqual(f.store.get(f.p.id),locked);
  f.edit([{op:'lock',id:cue.id,locked:false},add({...head,id:'overlap',start:15})]);
  assert.throws(()=>f.edit([{op:'ripple-remove',id:'gap'}]),/重叠/);
  f.edit([{op:'remove',id:'overlap'},{op:'lock',id:'owner',locked:true}]);
  assert.throws(()=>f.edit([{op:'ripple-remove',id:'gap'}]),/锁/);
  f.edit([{op:'lock',id:'owner',locked:false}]);
  p=f.edit([{op:'ripple-remove',id:'gap'}]);
  assert.equal(clip(p,'gap'),undefined);assert.equal(clip(p,'owner').start,28);assert.equal(clip(p,cue.id).start,28);
  assert.equal(clip(p,'bed').start,90);assert.equal(clip(p,'caption').start,65);
  assert.equal(p.timeline.clips.filter(c=>c.soundBinding).length,1);
  p=f.undo();assert.equal(clip(p,'gap').duration,12);assert.equal(clip(p,cue.id).start,40);
  p=f.redo();assert.equal(clip(p,cue.id).start,28);
  p=f.edit([add({id:'audio-cut',track:'music',assetId:a.id,start:0,duration:10})]);
  p=f.edit([{op:'ripple-remove',id:'audio-cut'}]);assert.equal(clip(p,cue.id).start,28);assert.equal(clip(p,'bed').start,80);
});

test('normal authenticated API rejects stale or missing revisions and keeps durable edit state per project',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-edits-http-'));
  const app=await startStudio({root,dependencies:{director:{close(){}}}});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const origin=new URL(app.url).origin,login=await fetch(app.url,{redirect:'manual'});
  const headers={cookie:login.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
  const api=(suffix,body)=>fetch(origin+'/api/projects'+suffix,{headers,...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{})});
  const p=await (await api('',{mode:'topic'})).json(),uri='/'+p.id;
  assert.deepEqual(await (await api(uri+'/history')).json(),{revision:1,canUndo:false,canRedo:false,undoLabel:null,redoLabel:null});
  const a=await (await api(uri+'/edits',{baseRevision:1,commands:[add(caption('a',1,20))]})).json();
  assert.equal(a.revision,2);assert.equal((await api(uri+'/undo',{})).status,409);
  const results=await Promise.all([api(uri+'/edits',{baseRevision:2,commands:[{op:'split',id:'a',atFrame:8,newId:'b'}]}),
    api(uri+'/edits',{baseRevision:2,commands:[{op:'split',id:'a',atFrame:7,newId:'c'}]})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await (await api(uri+'/history')).json()).undoLabel,'分割片段');
  assert.equal((await api(uri+'/undo',{baseRevision:2})).status,409);
  const undo=await (await api(uri+'/undo',{baseRevision:3})).json();assert.equal(undo.revision,4);assert.equal(undo.timeline.clips.length,1);
  const redo=await (await api(uri+'/redo',{baseRevision:4})).json();assert.equal(redo.revision,5);assert.equal(redo.timeline.clips.length,2);
  const other=await (await api('',{mode:'topic'})).json();assert.equal((await (await api('/'+other.id+'/history')).json()).canUndo,false);
  assert.equal((await fetch(origin+'/api/projects'+uri+'/undo',{method:'POST'})).status,403);
});
