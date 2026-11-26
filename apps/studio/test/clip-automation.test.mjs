import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore,validateClip} from '../src/project.mjs';
import {timelineCommands} from '../src/clip-edit.mjs';
import {audioDecode,buildVisualInput,probeMedia,renderProject,renderProjectFrame,renderPreviewWindow} from '../src/media.mjs';
import {requiredTool,ffBase,inputArgs} from '../src/media-runtime.mjs';
import {validateTimeMap,setTimeMap,sourceAt,localAtSource,curveRuns,timeKeys,focusKeys,blendKeys,defaultMask} from '../www/clip-automation.js';
import {visiblePanes} from '../src/viewport.mjs';
import {pictureIdentity} from '../src/playback-identity.mjs';

const profile={width:160,height:90,fps:24};
const clip={id:'top',assetId:'a',track:'video',start:10,duration:48,sourceIn:24,gain:.5};
const points=[{frame:0,sourceFrame:0},{frame:12,sourceFrame:6},{frame:36,sourceFrame:42},{frame:48,sourceFrame:48}];
const focus={from:{x:.15,y:.45,zoom:1},keys:[{frame:16,x:.8,y:.2,zoom:1.5},{frame:33,x:.5,y:.6,zoom:2}],to:{x:.8,y:.7,zoom:1.5}};

test('source map, sampling clock and independently editable camera keys survive split, retrim, move, flat rate and undo',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-map-history-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=createStore(dir,{probeMedia:async()=>({kind:'video',duration:8,...profile,hasAudio:true})});t.after(()=>store.close());
  let p=store.create({mode:'script',profile});
  const f=path.join(dir,'fixture.mov');await writeFile(f,Buffer.from('local asset'));
  const a=await store.addAsset(p.id,f);p=store.get(p.id);
  const apply=(commands,actor='user')=>p=store.apply(p.id,p.revision,commands,actor);
  apply([{op:'add',clip:{...clip,assetId:a.id,mask:defaultMask,framing:focus}}]);
  const originalPicture=pictureIdentity(p);
  apply([{op:'time-map',id:clip.id,points}]);const mapped=p.timeline.clips[0];
  assert.notEqual(pictureIdentity(p),originalPicture);
  for(let f=0;f<=48;f+=.5)assert.ok(Math.abs(localAtSource(mapped,sourceAt(mapped,f))-f)<1e-9);
  assert.equal(sourceAt(mapped,12),30);assert.equal(sourceAt(mapped,36),66);
  const bad=[{frame:0,sourceFrame:0},{frame:1,sourceFrame:30},{frame:48,sourceFrame:48}];
  assert.throws(()=>apply([{op:'time-map',id:clip.id,points:bad}]),/速度/);
  assert.throws(()=>apply([{op:'update',id:clip.id,changes:{mask:{...defaultMask,x:2}}}]),/蒙版/);
  assert.throws(()=>apply([{op:'update',id:clip.id,changes:{framing:{...focus,keys:[{frame:60,x:0,y:0,zoom:1}]}}}]),/取景/);
  apply([{op:'split',id:clip.id,newId:'right',atFrame:31}]);const right=p.timeline.clips[1],left=p.timeline.clips[0];
  assert.deepEqual(right.mask,defaultMask);assert.equal(left.duration,21);assert.equal(right.timeMap.offsetFrames,21);
  for(const half of [left,right])for(let f=0;f<half.duration;f++){
    const absolute=f+half.start-mapped.start;
    assert.equal(sourceAt(half,f),sourceAt(mapped,absolute));
    const before=blendKeys(focusKeys(mapped),absolute),after=blendKeys(focusKeys(half),f);
    for(const key of ['x','y','zoom'])assert.ok(Math.abs(before[key]-after[key])<1e-8);
  }
  p=store.undo(p.id,p.revision);assert.deepEqual(p.timeline.clips,[mapped]);
  p=store.redo(p.id,p.revision);assert.deepEqual(p.timeline.clips,[left,right]);
  apply([{op:'trim',id:'right',edge:'start',atFrame:34}]);let tail=p.timeline.clips[1];assert.equal(tail.timeMap.offsetFrames,24);
  apply([{op:'move',id:'right',start:110}]);tail=p.timeline.clips[1];assert.equal(sourceAt(tail,5),sourceAt(mapped,29));
  apply([{op:'speed',id:'right',speed:tail.speed}]);assert.equal(p.timeline.clips[1].timeMap,null);
  apply([{op:'lock',id:'right',locked:true}]);assert.throws(()=>apply([{op:'time-map',id:'right',points:null}],'codex'),/锁定/);
  assert.throws(()=>validateClip({...mapped,track:'music'},p),/录像/);
});

test('two-layer mask, inversion, feather, multipoint camera and source-time curves render in actual exports and precise previews',async t=>{
  const ffmpeg=await requiredTool('ffmpeg');
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-clip-media-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const ff=(args)=>execFileSync(ffmpeg,[...ffBase,...args],{maxBuffer:16*1024*1024});
  const back=path.join(dir,'red.png'),front=path.join(dir,'blue.mkv');
  ff(['-f','lavfi','-i','color=red:s=160x90','-frames:v','1',back]);
  ff(['-f','lavfi','-i','color=blue:s=256x144:r=24','-f','lavfi','-i','sine=frequency=640:sample_rate=48000','-filter:v',
    "drawbox=x=50:y=45:w=26:h=28:c=lime:t=fill,drawbox=x=178:y=46:w=24:h=28:c=yellow:t=fill",'-t','4','-c:v','ffv1','-c:a','pcm_s16le',front]);
  const assets=[{id:'a',path:front,...await probeMedia(front)},{id:'back',path:back,...await probeMedia(back)}],mask={...defaultMask,width:.55,height:.8,feather:.06};
  const top={...clip,start:0,...setTimeMap(clip,points),mask};validateTimeMap(top,assets[0],24);
  const p={id:'field',profile,revision:1,assets,timeline:{clips:[{id:'0',track:'video',assetId:'back',start:0,duration:48},top]}};
  function rgb(file,n=0){return ff(['-i',file,'-vf','select=eq(n\\,'+n+')','-frames:v','1','-an','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);}
  const color=(buf,x,y)=>[...buf.subarray((y*160+x)*3,(y*160+x)*3+3)],red=c=>c[0]>180&&c[2]<50,blue=c=>c[2]>155&&c[0]<70;
  for(const inverse of [false,true]){
    top.mask={...mask,invert:inverse};
    const file=path.join(dir,inverse?'inverse.mp4':'mask.mp4');
    const out=await renderProject(p,{directory:dir,output:file});assert.equal(out.frames,48);
    const chunk=await renderPreviewWindow(p,{directory:dir,output:path.join(dir,'clip.mp4'),window:{fromFrame:15,toFrame:22}});
    const jpg=await renderProjectFrame(p,{directory:dir,output:path.join(dir,'still.jpg'),frame:18,maxWidth:160});
    for(const raw of [rgb(file,18),rgb(chunk.videoPath,3),rgb(jpg)]){
      assert.ok((inverse?red:blue)(color(raw,80,45)),'actual mask center '+color(raw,80,45));
      assert.ok((inverse?blue:red)(color(raw,6,7)),'actual uncovered corner '+color(raw,6,7));
      const soft=color(raw,80,9);assert.ok(soft[0]>35&&soft[2]>35,'visible feather '+soft);
    }
    const pcm=ff(['-v','error','-i',file,'-map','0:a:0','-f','s16le','-ac','1','pipe:1']);
    let rises=0;for(let i=2;i<pcm.length;i+=2)if(pcm.readInt16LE(i)>0&&pcm.readInt16LE(i-2)<=0)rises++;
    assert.ok(rises>1180&&rises<1370,'640 Hz stays near its pitch across the 2-second retimed video '+rises);
  }
  top.mask={...mask,invert:false};top.transition={type:'fade',duration:9};
  await renderProjectFrame(p,{directory:dir,output:path.join(dir,'transition.jpg'),frame:4,maxWidth:160});
  assert.ok(red(color(rgb(path.join(dir,'transition.jpg')),5,5)),'lower shot remains intact outside a transitioning full-pane mask');
  const panes=visiblePanes(p.timeline.clips.map(clip=>({clip})),profile);
  assert.equal(panes.length,2);
  assert.ok(panes.find(s=>s.shot.clip.id==='0').regions.every(r=>!(r.x<.5&&r.x+r.width>.5&&r.y<.5&&r.y+r.height>.5)));
  top.mask=null;top.transition=null;top.framing={from:{x:.25,y:.4,zoom:3},keys:[{frame:18,x:.75,y:.4,zoom:3}],to:{x:.25,y:.4,zoom:3}};
  const k=await renderProjectFrame(p,{directory:dir,output:path.join(dir,'focus.jpg'),frame:18,maxWidth:160});
  const center=color(rgb(k),80,45);assert.ok(center[0]>180&&center[1]>160&&center[2]<80,'middle camera key lands on right-hand yellow feature '+center);
});

test('an explicitly positioned v8 portrait caption moves across the actual footage; existing captions remain in the template',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-portrait-caption-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const ffmpeg=await requiredTool('ffmpeg'),image=path.join(dir,'blue.png');
  execFileSync(ffmpeg,[...ffBase,'-f','lavfi','-i','color=blue:s=240x134','-frames:v','1',image]);
  const p={profile:{width:240,height:426,fps:24},style:{id:'henry-hot-news',version:8},title:'Title',assets:[{id:'a',path:image}],timeline:{clips:[
    {id:'footage',track:'video',assetId:'a',start:0,duration:100},{id:'cap',track:'caption',start:0,duration:50,text:'MOVE',
      style:{fontSize:16},keyframes:[{frame:0,x:.24,y:.5},{frame:40,x:.76,y:.5}]}]}};
  const center=async frame=>{
    const file=path.join(dir,'cap.jpg');await renderProjectFrame(p,{directory:dir,output:file,frame,maxWidth:240});
    const b=execFileSync(ffmpeg,[...ffBase,'-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    let count=0,xSum=0;for(let y=197;y<229;y++)for(let x=0;x<240;x++){const i=3*(y*240+x);if(Math.min(b[i],b[i+1],b[i+2])>165){count++;xSum+=x;}}
    return {x:xSum/count,count};
  };
  assert.equal((await center(4)).count,0);
  p.timeline.clips[1].portraitPlacement='free';
  const first=await center(2),last=await center(39);assert.ok(first.count>30&&last.count>30);assert.ok(first.x<75&&last.x>165);
  p.settings={captionDisplay:'sidecar'};assert.equal((await center(4)).count,0);
});
