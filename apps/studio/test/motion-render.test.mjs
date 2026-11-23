import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {watch} from 'node:fs';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {sourceHashes,components} from '../src/motion-jsx.generated.mjs';
import {serialize} from '../src/motion-dom.mjs';
import {motionFont,verifyMotionFont} from '../src/motion-font.mjs';
import {motionSample} from '../src/motion-components.mjs';
import {mediaCapabilities,renderProject} from '../src/media.mjs';

const exec=promisify(execFile);
const profile={width:640,height:360,fps:24};
const duration=44;
const names=['impact-title','source-label','process-rail','staggered-explanation','fragment-title','comparison-guide'];
const edits=[
  {label:'现场手记',title:'潮水停在这里',size:70},
  {lab:'资料来源 · 研究室',hardware:'资料来源 · 现场 A'},
  {a:'观察',b:'测量',c:'核验'},
  {a:'看水线',b:'对潮位',c:'找刻度'},
  {title:'海岸：潮位记录'},
  {left:'之前的刻度',right:'之后的刻度'}
];

test('the offline compiler preserves all six release source digests and treats model copy as text',async()=>{
  for(const [i,hash] of sourceHashes.entries()){
    const file='mg-'+String(i+1).padStart(2,'0')+'.jsx';
    const source=await readFile(new URL('../../../user-packs/henry-video-styles/reproduction/technical-explainer/'+file,import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'),hash);
  }
  const clip={track:'graphic',start:0,duration,motion:{componentId:names[0],props:{title:'<img src=x onerror=alert(1)>',font:'none;position:fixed'}}};
  const s=motionSample(clip,profile,20);
  const html=serialize(components[s.index-1]({props:s.props},s.frame,s.duration));
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(html,/<img|position:fixed/i);
});

async function frame(ffmpeg,file,index){
  const result=await exec(ffmpeg,['-v','error','-i',file,'-vf','select=eq(n\\,'+index+')','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:'buffer',maxBuffer:profile.width*profile.height*3+4096});
  assert.equal(result.stdout.length,profile.width*profile.height*3);
  return result.stdout;
}
const rgb=(buf,x,y)=>[...buf.subarray((y*profile.width+x)*3,(y*profile.width+x)*3+3)];
const maxDelta=(a,b)=>Math.max(...a.map((n,i)=>Math.abs(n-b[i])));
function changed(a,b,region=[0,0,profile.width,profile.height],delta=48){
  let count=0;
  for(let y=region[1];y<region[3];y++)for(let x=region[0];x<region[2];x++)if(maxDelta(rgb(a,x,y),rgb(b,x,y))>delta)count++;
  return count;
}

test('six shipped JSX components render with alpha on footage, preserve cue timing, track order and identical window frames', {skip:process.platform!=='darwin',timeout:240_000},async t=>{
  const {ready,ffmpeg}=await mediaCapabilities();if(!ready)return t.skip('requires FFmpeg');
  const evidence=process.env.VIDEO_STUDIO_MOTION_TEST_OUTPUT;
  const directory=evidence?path.resolve(evidence):await mkdtemp(path.join(os.tmpdir(),'studio-wk-motion-'));
  await mkdir(directory,{recursive:true});
  const prev=process.env.VIDEO_STUDIO_MOTION_CACHE;
  process.env.VIDEO_STUDIO_MOTION_CACHE=path.join(directory,'cache');
  t.after(async()=>{
    if(prev==null)delete process.env.VIDEO_STUDIO_MOTION_CACHE;else process.env.VIDEO_STUDIO_MOTION_CACHE=prev;
    if(!evidence)await rm(directory,{recursive:true,force:true});
  });
  const bgFile=path.join(directory,'coast.ppm');
  const pixels=Buffer.alloc(profile.width*profile.height*3);
  for(let y=0;y<profile.height;y++)for(let x=0;x<profile.width;x++){
    const k=(y*profile.width+x)*3;pixels[k]=66+Math.round(x*55/profile.width);pixels[k+1]=24+Math.round(y*65/profile.height);pixels[k+2]=62+Math.round(x*45/profile.width);
  }
  await writeFile(bgFile,Buffer.concat([Buffer.from('P6\n'+profile.width+' '+profile.height+'\n255\n'),pixels]));
  const gap=6,total=gap+(duration+gap)*6;
  const clips=names.map((id,i)=>({
    id,track:'graphic',start:gap+i*(duration+gap),duration,
    motion:{componentId:id,props:edits[i],...([1,2,3].includes(i)?{cueFrames:i===1?[0,25]:[0,13,30]}:{})},
    geometry:{x:.5,y:.48,width:.94,height:.70}
  }));
  const comparison=clips.at(-1);
  // Verify normal captions paint above the full-height cyan divider even if inserted lower in the array.
  const caption={id:'caption',track:'caption',start:comparison.start+22,duration:8,text:'━━ 同一画面 ━━',geometry:{x:.5,y:.48},style:{color:'#ffff00',backgroundColor:'#ff0000',fontSize:32}};
  const base={id:'background',track:'video',assetId:'bg',start:0,duration:total};
  const project={id:'native-jsx-regression',profile,revision:1,assets:[{id:'bg',path:bgFile,kind:'image'}],timeline:{clips:[base,caption,...clips]}};
  const output=path.join(directory,'six-components.mp4');
  const full=await renderProject(project,{directory,output});
  assert.equal(full.frames,total);assert.equal(full.motion.clips,6);
  assert.ok(full.motion.uniqueFrames<duration*4,'held states must reuse original renderings');
  const blank=await frame(ffmpeg,output,1);
  const sampled=[];
  for(const [i,clip] of clips.entries()){
    const normal=await frame(ffmpeg,output,clip.start+18);
    const count=changed(blank,normal);
    assert.ok(count>120,names[i]+': '+count+' changed pixels');
    const corner=maxDelta(rgb(blank,7,8),rgb(normal,7,8));
    const insideBox=maxDelta(rgb(blank,32,45),rgb(normal,32,45));
    assert.ok(corner<=10&&insideBox<=12,names[i]+': underlying source disappeared');
    if([0,2,3,4].includes(i)){
      const entered=await frame(ffmpeg,output,clip.start+1);
      assert.ok(changed(entered,normal)>140,names[i]+': missing frame-by-frame entrance');
    }
    const after=await frame(ffmpeg,output,clip.start+duration);
    assert.ok(changed(blank,after,undefined,24)<40,'overlay retained after '+names[i]);
    sampled.push({component:names[i],renderedPixels:count,sceneCornerDelta:corner,transparentRegionDelta:insideBox});
  }
  // A static component must show every requested frame, through the last one.
  for(const [index,visible] of [[comparison.start-1,false],[comparison.start,true],[comparison.start+duration-1,true],[comparison.start+duration,false]]){
    const actual=await frame(ffmpeg,output,index);
    assert.equal(changed(blank,actual)>500,visible,'static component at exact edge '+index);
  }
  const label=clips[1];
  const before=await frame(ffmpeg,output,label.start+24),switched=await frame(ffmpeg,output,label.start+25);
  assert.ok(changed(before,switched)>100,'source identity must change on the actual cue');
  const atCaption=await frame(ffmpeg,output,caption.start+2);
  const under=await frame(ffmpeg,output,comparison.start+18);
  const split=rgb(under,319,173),subtitle=rgb(atCaption,319,173);
  assert.ok(split[1]>split[0]+15 && split[1]-rgb(blank,319,173)[1]>65,'expected narrow cyan divider blended with source: '+split);
  assert.ok(subtitle[0]>subtitle[2]+90,'expected caption painted above cyan divider: '+subtitle);
  const from=clips[3].start+10,to=clips[4].start+30;
  const windowFile=path.join(directory,'window.mp4');
  const short=await renderProject(project,{directory,output:windowFile,preview:true,window:{fromFrame:from,toFrame:to}});
  assert.equal(short.motion.rasterized,0);assert.equal(short.frames,to-from);
  for(const at of [from,clips[3].start+16,clips[3].start+36,clips[4].start+5,to-1]){
    const a=await frame(ffmpeg,output,at),b=await frame(ffmpeg,windowFile,at-from);
    assert.ok(changed(a,b,undefined,32)<220,'preview does not match original frame '+at);
  }
  assert.match(await readFile(full.srtPath,'utf8'),/同一画面/);
  if(evidence)await writeFile(path.join(directory,'six-components.json'),JSON.stringify({profile,full,short,sources:sourceHashes,sampled,clips:project.timeline.clips},null,2));
});


test('cancelling during genuine WebKit rasterization preserves the existing output pair and the next render can resume', {skip:process.platform!=='darwin',timeout:90_000}, async t=>{
  if(!(await mediaCapabilities()).ready)return t.skip('requires FFmpeg');
  const directory=await mkdtemp(path.join(os.tmpdir(),'studio-native-cancel-'));
  const cache=path.join(directory,'cache');
  const oldCache=process.env.VIDEO_STUDIO_MOTION_CACHE;
  process.env.VIDEO_STUDIO_MOTION_CACHE=cache;
  t.after(async()=>{
    if(oldCache==null)delete process.env.VIDEO_STUDIO_MOTION_CACHE;else process.env.VIDEO_STUDIO_MOTION_CACHE=oldCache;
    await rm(directory,{recursive:true,force:true});
  });
  const project={id:'cancel-native',profile,assets:[],timeline:{clips:[{id:'reveal',track:'graphic',start:0,duration:104,motion:{componentId:'staggered-explanation',props:edits[3],cueFrames:[0,36,70]}}]}};
  const output=path.join(directory,'draft.mp4'),srt=path.join(directory,'draft.srt');
  await writeFile(output,'earlier video');await writeFile(srt,'earlier captions');
  const abort=new AbortController();
  const observer=watch(directory,{recursive:true},(_,name)=>{
    // Wait for native WebKit to be producing actual PNG content before cancelling.
    if(name && name.includes('.media-') && name.endsWith('.png'))abort.abort(new Error('取消本机动效'));
  });
  try{
    await assert.rejects(renderProject(project,{directory,output,signal:abort.signal}),/取消本机动效/);
  }finally{observer.close();}
  assert.equal(await readFile(output,'utf8'),'earlier video');
  assert.equal(await readFile(srt,'utf8'),'earlier captions');
  const leftovers=await readdir(directory,{recursive:true});
  assert.ok(!leftovers.some(name=>name.includes('.media-')),'cancelled job left a partial batch');
  const resumed=await renderProject(project,{directory,output,window:{fromFrame:4,toFrame:5}});
  assert.equal(resumed.frames,1);assert.equal(resumed.motion.uniqueFrames,1);
});

test('one-pixel moves of a one-frame JSX layer preserve odd as well as even canvas coordinates', {skip:process.platform!=='darwin',timeout:40_000},async t=>{
  const {ready,ffmpeg}=await mediaCapabilities();if(!ready)return t.skip('requires FFmpeg');
  const directory=await mkdtemp(path.join(os.tmpdir(),'studio-native-pixel-'));
  const oldCache=process.env.VIDEO_STUDIO_MOTION_CACHE;process.env.VIDEO_STUDIO_MOTION_CACHE=path.join(directory,'cache');
  t.after(async()=>{
    if(oldCache==null)delete process.env.VIDEO_STUDIO_MOTION_CACHE;else process.env.VIDEO_STUDIO_MOTION_CACHE=oldCache;
    await rm(directory,{recursive:true,force:true});
  });
  const clips=Array.from({length:4},(_,i)=>({
    id:'grid-'+i,track:'graphic',start:2*i+1,duration:1,
    motion:{componentId:'comparison-guide',props:{left:'',right:'',cyan:'#ffffff'}},
    geometry:{x:.5+i/profile.width,y:.5,width:1,height:1}
  }));
  const output=path.join(directory,'grid.mp4');
  const r=await renderProject({id:'odd',profile,assets:[],timeline:{clips}},{directory,output});
  assert.equal(r.motion.uniqueFrames,1);
  for(const [i,clip] of clips.entries()){
    const visible=await frame(ffmpeg,output,clip.start),blank=await frame(ffmpeg,output,clip.start-1);
    const row=Array.from({length:profile.width},(_,x)=>rgb(visible,x,170)[0]);
    assert.equal(row.findIndex(n=>n>80),319+i);
    assert.ok(rgb(blank,319+i,170)[0]<20);
  }
});


test('the declared Chinese typeface is a bundled, licensed variable font and reaches the actual WebKit and MP4 pixels', {skip:process.platform!=='darwin',timeout:100_000},async t=>{
  assert.equal(await verifyMotionFont(),motionFont);
  const license=await readFile(motionFont.license);
  assert.match(license.toString(),/SIL OPEN FONT LICENSE/);
  assert.equal(createHash('sha256').update(license).digest('hex'),motionFont.licenseSha256);
  const {ready,ffmpeg}=await mediaCapabilities();if(!ready)return t.skip('requires FFmpeg');
  const directory=await mkdtemp(path.join(os.tmpdir(),'studio-embedded-noto-'));
  const oldCache=process.env.VIDEO_STUDIO_MOTION_CACHE;process.env.VIDEO_STUDIO_MOTION_CACHE=path.join(directory,'cache');
  t.after(async()=>{
    if(oldCache==null)delete process.env.VIDEO_STUDIO_MOTION_CACHE;else process.env.VIDEO_STUDIO_MOTION_CACHE=oldCache;
    await rm(directory,{recursive:true,force:true});
  });
  // One static native JSX source and identical subtitle copy. Only the selected typeface changes.
  const fonts=[undefined,'PingFang SC','serif'];
  const clips=fonts.map((font,i)=>({id:'font-'+i,track:'graphic',start:4*i,duration:4,
    geometry:{x:.5,y:.45,width:.8,height:.24},motion:{componentId:'source-label',
      props:{lab:'潮位 Aa18 月印 - 猎户座返回',...(font&&{font})}}}));
  const output=path.join(directory,'types.mp4');
  const rendered=await renderProject({id:'font-probe',profile,assets:[],timeline:{clips}},{directory,output});
  const proof=rendered.motion.font;
  assert.equal(proof.sha256,motionFont.sha256);
  assert.equal(proof.status,'loaded');assert.equal(proof.family,'Noto Sans SC');assert.equal(proof.weight,'100 900');
  assert.equal(new Set([proof.regularRaster,proof.boldRaster,proof.systemSansRaster,proof.serifRaster]).size,4);
  const images=await Promise.all(clips.map(c=>frame(ffmpeg,output,c.start+1)));
  assert.ok(changed(images[0],images[1],undefined,35)>80,'default font silently drew the installed sans fallback');
  assert.ok(changed(images[0],images[2],undefined,35)>80,'default font silently drew generic serif');
});
