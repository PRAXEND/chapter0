import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {requestedDurationRange,durationFinding} from '../src/duration.mjs';
import {replacementEdits} from '../src/ripple.mjs';
import {portraitLayout,portraitScript,portraitGraph,portraitEnding,publicationFields} from '../src/presentation.mjs';
import {coverComposition,makePublicationPackage} from '../src/publication.mjs';
import {dailySources,youtubeId,acquireYoutube} from '../src/robot-sources.mjs';
import {sourceSelection} from '../src/source-selection.mjs';
import {createStore} from '../src/project.mjs';
import {mediaTool} from '../src/media-runtime.mjs';
const style={id:'henry-hot-news',version:8},profile={width:1080,height:1920,fps:30};
const project={profile,style,title:'机器人的手如何抓牢',settings:{},assets:[],timeline:{clips:[]}};
const make=(id,track,start,duration,extra={})=>({id,track,start,duration,...extra});
test('persist inclusive frame limits and keep local edit requests out of project bounds',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'v8-settings-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createStore(root,{probeMedia:()=>{throw Error();}});t.after(()=>store.close());
  const p=store.create({mode:'topic',style,brief:'从空工程剪一条50–60秒的完整成片。'});
  assert.equal(p.settings.durationMinSeconds,50);assert.equal(p.settings.durationMaxSeconds,60);
  assert.deepEqual(requestedDurationRange('把 18–24 秒换成操作特写'),{});
  const runtime={durationMinSeconds:50,durationMaxSeconds:60};
  assert.deepEqual(requestedDurationRange('将 18–24 秒的视频换成特写，片长保持 50–60 秒。'),runtime);
  assert.deepEqual(requestedDurationRange('请把原片的 18–24 秒的视频换成特写。'),{});
  assert.deepEqual(requestedDurationRange('做一条 50–60 秒的短视频。'),runtime);
  for(const n of [50,55,60])assert.equal(durationFinding(p.settings,n,24),null);
  for(const n of [49.5,60.25])assert.equal(durationFinding(p.settings,n,24).reason,'duration-range');
  assert.throws(()=>store.configure(p.id,p.revision,{settings:{durationMinSeconds:61}}));
  assert.throws(()=>store.configure(p.id,p.revision,{settings:{finalReviewMaxTurns:2}}));
});
test('retime a multi-shot line preserving source intervals, cue points, free-running bed and real locks',()=>{
  const voice=make('voice','narration',20,20);
  const p={profile,assets:[{id:'a',kind:'video',duration:2},{id:'b',kind:'audio',duration:12}],timeline:{clips:[
    voice,make('shot1','video',20,10,{assetId:'a',sourceIn:7}),make('shot2','video',30,10,{assetId:'a'}),
    make('cue','graphic',22,10,{motion:{cueFrames:[0,3,7]},actionFrame:28}),make('bed','music',0,160,{assetId:'b'}),
    make('next','caption',50,8),make('locked','graphic',0,5,{locked:true})]}};
  const edits=replacementEdits(p,voice,new Set(['voice']),40),changes=id=>edits.find(c=>c.id===id)?.changes;
  assert.deepEqual(changes('shot1'),{start:20,duration:20,speed:.5});assert.equal(changes('shot2').start,40);
  assert.deepEqual(changes('cue').motion.cueFrames,[0,6,14]);assert.equal(changes('cue').actionFrame,36);
  assert.equal(changes('bed').duration,180);assert.equal(changes('bed').speed,undefined);
  assert.equal(changes('next').start,70);assert.equal(changes('locked'),undefined);
  p.timeline.clips[2].locked=true;assert.throws(()=>replacementEdits(p,voice,new Set(['voice']),40),/shot2/);
});
test('both portrait styles compile the approved window, title, captions, texture and ending on one project clock',()=>{
  const p={...project,publication:{title:project.title,emphasis:'抓牢'},timeline:{clips:[make('sub','caption',2,70,{text:'看指尖的动作'})]}};
  for(const id of ['henry-hot-news','henry-technical-explainer']){
    p.style={id,version:8};const l=portraitLayout(p);assert.equal(l.contentHeight,608);assert.equal(l.top,656);
    const script=portraitScript(p,l,10,18,1800);
    assert.match(script,/Noto Sans SC/);assert.match(script,/抓牢/);assert.match(script,/看指尖/);
    assert.equal(script.split('Dialogue: 0,').length-1,12);
    assert.match(portraitGraph(p,l,'[base]',10,1800),/setpts=N\+10/);
    assert.deepEqual(portraitEnding(1800,30),{black:1782,fade:1746,musicFade:1740});
  }
  assert.equal(portraitLayout({...p,profile:{width:1920,height:1080}}),null);
});
test('each PNG uses its selected source frame and independent crop, matching title and emphasis',async t=>{
  const p={...project,publication:{title:project.title,emphasis:'抓牢',cover34:{frame:13,x:.3,y:.7},cover43:{frame:48,x:.7,y:.4}},assets:[{id:'a',kind:'image',path:'a'},{id:'b',kind:'image',path:'b'}],timeline:{clips:[make('a1','video',0,30,{assetId:'a'}),make('b1','video',30,30,{assetId:'b'})]}};
  assert.throws(()=>publicationFields({...p.publication,emphasis:'无关'}));
  const dir=await mkdtemp(path.join(os.tmpdir(),'v8-cover-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const chosen=[];
  const covers=await makePublicationPackage(p,{directory:dir,media:{mediaTool,frameAt:async(source,_at,dest)=>{chosen.push(source);await writeFile(dest,Buffer.concat([Buffer.from('P6\n8 8\n255\n'),Buffer.alloc(8*8*3,90)]));}}});
  assert.deepEqual(chosen,['a','b']);
  for(const [key,size] of [['cover34',[1440,1920]],['cover43',[1920,1440]]]){
    const bytes=await readFile(covers[key]);assert.equal(bytes.subarray(1,4).toString(),'PNG');
    assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],size);
    assert.match(coverComposition(p,key).ass,/00FFF0/);
  }
});
test('ready dated source collections keep a pinned fingerprint, actual post date and separate event date',async()=>{
  const sha='a'.repeat(40),day='2026-10-21';
  const readJson=async url=>{
    if(url.endsWith('/HEAD'))return {sha};
    if(url.includes('contents/?'))return [{name:'2026'}];
    if(url.includes('contents/2026?'))return [{name:day},{name:'2026-10-22'}];
    if(url.endsWith('manifest.json'))return {status:url.includes(day)?'ready':'pending',items:[{id:'002',title:'机器人动作',has_video:true}]};
    return {title:'机器人动作',source_url:'https://x.com/demo/status/203',summary:'厂商展示动作',published_at:'2026-09-10',media:[{file:'videos/01.mp4',type:'video',bytes:24,sha256:'c'.repeat(64)}]};
  };
  const [r]=await dailySources('机器人',{kind:'video',readJson});assert.equal(r.date,'2026-09-10');assert.equal(r.eventDate,'');assert.ok(r.downloadUrl.includes(sha));assert.equal(r.expectedBytes,24);
  assert.equal(youtubeId('https://youtube.com/watch?v=12345678901'),'12345678901');
  await assert.rejects(acquireYoutube({url:'https://youtube.com/watch?v=12345678901',youtubeId:'12345678901'},'/tmp',{start:0,end:10},{resolve:async()=>'/mock',execute:async()=>JSON.stringify({id:'12345678901',license:'Standard YouTube License'})}),/授权/);
});
test('manual material choices stay in their project and selected-only mode forbids discovery',async()=>{
  const p={id:'p',settings:{sourceScope:'search'}}, seen=[];
  const sources=sourceSelection({get:()=>p},{search:()=>[{title:'demo',url:'https://example.org/a'}],acquire:async(_s,id,item)=>{seen.push([id,item.title]);return {id:'asset1'};}});
  const [first]=await sources.find(p,'demo');
  await assert.rejects(sources.pick({...p,id:'other'},[{key:first.key}]),/候选/);
  assert.deepEqual(await sources.pick(p,[{key:first.key}]),['asset1']);assert.deepEqual(seen,[['p','demo']]);
  p.settings.sourceScope='project';await assert.rejects(sources.find(p,'demo'),/已有素材/);
});
test('shared portrait filter displays source in its window and uses the absolute fade clock in a one-frame preview',async t=>{
  const {execFileSync}=await import('node:child_process');
  const {symlink}=await import('node:fs/promises');
  const {fileURLToPath}=await import('node:url');
  const directory=await mkdtemp(path.join(os.tmpdir(),'v8-pixel-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await symlink(fileURLToPath(new URL('../src/fonts/',import.meta.url)),path.join(directory,'fonts'));
  const p={...project,profile:{width:270,height:480,fps:30},timeline:{clips:[]}}, l=portraitLayout(p);
  const ff=await mediaTool('ffmpeg'),total=600;
  for(const [at,min,max] of [[30,235,255],[564,110,145],[599,0,4]]){
    await writeFile(path.join(directory,'portrait.ass'),portraitScript(p,l,at,at+1,total));
    const raw=execFileSync(ff,['-loglevel','error','-filter_complex_threads','1','-f','lavfi','-i','color=red:s=270x152:r=30','-filter_complex',portraitGraph(p,l,'[0:v]',at,total),'-map','[outportrait]','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{cwd:directory});
    const center=raw[(240*270+130)*3];assert.ok(center>=min&&center<=max,'sample '+at+' red '+center);
    assert.ok(raw[(60*270+100)*3]<45);
  }
});
