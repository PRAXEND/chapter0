import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {mediaCapabilities, renderProject} from '../src/media.mjs';
import {createStore, validateClip} from '../src/project.mjs';
import {viewportRect} from '../src/viewport.mjs';
import {visibleWindows} from '../src/framing.mjs';
import {projectSourceRegion} from '../src/visual-steps.mjs';
import {reviewVisualEvidence} from '../src/visual-review.mjs';

const exec = promisify(execFile);
async function setup(t) {
  const {ffmpeg, ready} = await mediaCapabilities();
  if (!ready) { t.skip('Requires FFmpeg and ffprobe'); return {}; }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-composition-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  return {dir,ffmpeg};
}
async function pixels(ffmpeg, file, gray=false) {
  const {stdout} = await exec(ffmpeg, ['-v','error','-i',file,'-map','0:v:0','-f','rawvideo','-pix_fmt',gray?'gray':'rgb24','pipe:1'],
    {encoding:'buffer',maxBuffer:16*1024*1024});
  return stdout;
}

test('directed rotation about an inset polygon box survives two turns, movement, a split and excerpt rendering', async t => {
  const {dir,ffmpeg} = await setup(t); if (!dir) return;
  const profile={width:320,height:256,fps:24}, store=createStore(path.join(dir,'store'));
  t.after(()=>store.close());
  let project=store.create({profile,mode:'script'});
  const upper={id:'upper',track:'graphic',start:1,duration:25,text:'',shape:'polygon',
    geometry:{x:.36,y:.25,width:.25,height:.20,points:[[.65,.40],[.95,.40],[.95,.60],[.65,.60]]},
    style:{color:'#ffffff'},keyframes:[{frame:0,rotation:0},{frame:24,x:.66,rotation:720,scale:1.25}]};
  const lower={...upper,id:'lower',geometry:{...upper.geometry,y:.75},
    keyframes:[{frame:0,rotation:0},{frame:24,x:.66,rotation:-720,scale:1.25}]};
  assert.throws(()=>validateClip({...upper,keyframes:[{frame:0,rotation:'720'}]}, {profile}),/旋转角度/);
  project=store.apply(project.id,project.revision,[upper,lower].map(clip=>({op:'add',clip})));
  const original=project;
  const split=store.apply(project.id,project.revision,[{op:'split',id:'upper',atFrame:8,newId:'upper-tail'}]);
  assert.equal(split.timeline.clips.find(c=>c.id==='upper-tail').keyframes[0].rotation,210);
  const motion=store.apply(split.id,split.revision,[{op:'add',clip:{id:'component',track:'graphic',text:'',start:26,duration:4,motion:{version:1,componentId:'impact-title',props:{title:'分割检查'}}}}]);
  assert.throws(()=>store.apply(motion.id,motion.revision,[{op:'split',id:'component',atFrame:28,newId:'bad'}]),/独立动画时钟/);
  for(const [name,p,first] of [['full',original,0],['split',split,0],['window',split,6]]) {
    const output=path.join(dir,name+'.mp4');
    await renderProject(p,{directory:dir,output,preview:name==='window',...(first&&{window:{fromFrame:first,toFrame:26}})});
    const data=await pixels(ffmpeg,output,true),{width,height}=profile;
    for(const n of [0,3,6,7,9,12,15,18,21,24]) {
      const frame=n+1; if(frame<first)continue;
      for(const [half,sign] of [[0,1],[1,-1]]) {
        let count=0,sumX=0,sumY=0;
        for(let y=half*height/2;y<(half+1)*height/2;y++)for(let x=0;x<width;x++)
          if(data[((frame-first)*height+y)*width+x]>195){count++;sumX+=x+.5;sumY+=y+.5;}
        const phase=n/24,angle=sign*phase*4*Math.PI,radius=.3*80*(1+.25*phase);
        const wantX=width*(.36+.30*phase)+radius*Math.cos(angle),wantY=height*(half ? .75 : .25)+radius*Math.sin(angle);
        assert.ok(count>100 && Math.hypot(sumX/count-wantX,sumY/count-wantY)<1.7,
          name+' frame '+frame+' half '+half+' actual '+[sumX/count,sumY/count]+' expected '+[wantX,wantY]);
      }
    }
  }
});

test('two actual video windows retain independent source times, crop, speed and a pane-local wipe in a preview', async t => {
  const {dir,ffmpeg}=await setup(t);if(!dir)return;
  const profile={width:192,height:96,fps:12},assets=[];
  const sequences={left:[[255,0,0],[0,255,0],[0,0,255],[255,0,255]],right:[[255,255,0],[0,255,255],[255,0,0],[255,0,255]]};
  for(const [id,colors] of Object.entries(sequences)){
    const bytes=Buffer.alloc(128*64*3*32);
    for(let f=0;f<32;f++)for(let y=0;y<64;y++)for(let x=0;x<128;x++){
      const chosen=(id==='left')===(x<64)?colors[Math.floor(f/4)%4]:[0,0,0];
      bytes.set(chosen,3*((f*64+y)*128+x));
    }
    const raw=path.join(dir,id+'.rgb'),file=path.join(dir,id+'.mkv');
    await writeFile(raw,bytes);
    await exec(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','rgb24','-video_size','128x64','-framerate','12','-i',raw,'-c:v','ffv1',file]);
    assets.push({id,path:file,kind:'video',duration:32/12});
  }
  const viewport=x=>({x,y:0,width:.5,height:1});
  const make=(id,side,start,duration,sourceIn,speed)=>({id,track:'video',assetId:id,start,duration,sourceIn,speed,
    viewport:viewport(side),framing:{from:{x:side ? 1 : 0,y:.5,zoom:1}}});
  const left=make('left',0,0,14,4,1),right={...make('right',.5,2,12,0,2),transition:{type:'wipe-right',duration:6}};
  const project={profile,assets,revision:1,timeline:{clips:[left,right]}};
  for(const c of [left,right])validateClip(c,project);
  assert.throws(()=>validateClip({...left,viewport:{x:.9,y:0,width:.3,height:1}},project),/分屏/);
  assert.deepEqual(viewportRect(viewport(.5),{width:322,height:96}),{x:162,y:0,width:160,height:96});
  for(const first of [0,4]){
    const file=path.join(dir,'panes-'+first+'.mp4');
    await renderProject(project,{directory:dir,output:file,preview:first>0,...(first&&{window:{fromFrame:first,toFrame:14}})});
    const data=await pixels(ffmpeg,file),near=(n,x,color)=>{
      const i=3*((n-first)*profile.width*profile.height+48*profile.width+x);
      const actual=[...data.subarray(i,i+3)];
      assert.ok(actual.every((v,k)=>Math.abs(v-color[k])<32),'frame '+n+' x='+x+' actual '+actual+' expected '+color);
    };
    if(!first){near(0,48,[0,255,0]);near(0,144,[0,0,0]);}
    near(4,48,[0,0,255]); near(4,108,[0,255,255]); near(4,180,[0,0,0]);
    near(8,48,[255,0,255]); near(8,144,[255,0,255]);
    near(12,48,[255,0,0]); near(12,144,[0,255,255]);
  }
});

test('the inspector can follow an exposed pane even with an older full-frame layer under two opaque halves',()=>{
  const profile={width:192,height:96};
  const shots=[{id:'back'}, {id:'left',viewport:{x:0,y:0,width:.5,height:1}}, {id:'right',viewport:{x:.5,y:0,width:.5,height:1}}]
    .map(c=>({clip:{...c,start:0,duration:10}}));
  const active=visibleWindows(shots,profile);
  assert.deepEqual(active.map(w=>[w.shot.clip.id,w.from,w.to,w.regions]),[
    ['left',0,9,[shots[1].clip.viewport]],['right',0,9,[shots[2].clip.viewport]],
  ]);
  const positioned=projectSourceRegion({x:.4,y:.4,width:.2,height:.2},{width:80,height:80,viewport:shots[2].clip.viewport},profile,0);
  assert.equal(positioned.x,.75);assert.equal(positioned.y,.5);assert.ok(Math.abs(positioned.width-.1)<1e-8);
  const inset=visibleWindows(shots.slice(0,2),profile);
  assert.deepEqual(inset[0].regions,[shots[2].clip.viewport]);
});

test('a locked left pane allows an independent right edit; slicing the lower shot keeps its original stacking',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-pane-lock-'));
  const store=createStore(path.join(dir,'store'),{probeMedia:async()=>({kind:'video',duration:5,hasAudio:false,width:160,height:80})});
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  let p=store.create({mode:'script',profile:{width:160,height:80,fps:12}});
  const file=path.join(dir,'asset.mov');await writeFile(file,'fixture');
  const asset=await store.addAsset(p.id,file);
  const make=(id,x,start,duration)=>({id,track:'video',start,duration,assetId:asset.id,viewport:{x,y:0,width:.5,height:1}});
  const left=make('left',0,0,36),right=make('right',.5,0,36),insert=make('insert',.5,5,16);
  p=store.apply(p.id,store.get(p.id).revision,[left,right,insert].map(clip=>({op:'add',clip})));
  p=store.apply(p.id,p.revision,[{op:'lock',id:'left',locked:true}]);
  p=store.apply(p.id,p.revision,[{op:'update',id:'right',changes:{sourceIn:3}}],'codex');
  assert.throws(()=>store.apply(p.id,p.revision,[{op:'update',id:'right',changes:{viewport:{x:.3,y:0,width:.7,height:1}}}],'codex'),/锁定/);
  p=store.apply(p.id,p.revision,[{op:'split',id:'right',atFrame:10,newId:'tail'}],'codex');
  const sample=f=>visibleWindows(p.timeline.clips.map(clip=>({clip})),p.profile)
    .filter(v=>v.from<=f&&f<=v.to).map(v=>v.shot.clip.id);
  assert.deepEqual(sample(14),['left','insert']);
  assert.deepEqual(sample(22),['left','tail']);
});

test('final review identifies moving and static panels from their own output pixels and counts the shared seconds once',async t=>{
  const {dir,ffmpeg}=await setup(t);if(!dir)return;
  const profile={width:192,height:96,fps:12},length=36;
  const bytes=Buffer.alloc(128*64*length);let seed=777;
  for(let n=0;n<length;n++)for(let y=0;y<64;y++)for(let x=0;x<128;x++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    bytes[(n*64+y)*128+x]=x<64?seed>>>24:118;
  }
  const raw=path.join(dir,'source.gray'),file=path.join(dir,'two-areas.mkv');
  await writeFile(raw,bytes);
  await exec(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','gray','-video_size','128x64','-framerate','12','-i',raw,'-c:v','ffv1',file]);
  const shots=[0,.5].map((x,i)=>({id:i?'still-pane':'moving-pane',track:'video',assetId:'sample',start:0,duration:length,
    viewport:{x,y:0,width:.5,height:1},framing:{from:{x:i ? 1 : 0,y:.5,zoom:1}}}));
  const asset={id:'sample',path:file,kind:'video',width:128,height:64,duration:3};
  const project={brief:'验证',revision:1,profile,assets:[asset],settings:{visualRequirements:{motionFootage:true}},timeline:{clips:shots},
    style:{id:'test',rules:[{id:'video-first'}]}};
  const out=path.join(dir,'motion-check.mp4');
  await renderProject(project,{directory:dir,output:out});
  const {evidence}=await reviewVisualEvidence(project,{ffmpeg,videoPath:out,hashFile:async()=>null});
  assert.equal(evidence.sourceWindows.length,2);
  const m=evidence.motion.find(x=>x.clipId==='moving-pane'),s=evidence.motion.find(x=>x.clipId==='still-pane');
  assert.equal(m.result,'changing-footage');assert.equal(s.sourceResult,'changing-footage');
  assert.equal(s.candidateResult,'no-detectable-change');assert.equal(s.confirmedFrozen,true);
  assert.deepEqual([evidence.motionCoverage.totalFrames,evidence.motionCoverage.changingFrames,evidence.motionCoverage.confirmedStationaryFrames],[36,36,0]);
});
