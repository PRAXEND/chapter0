import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {createStyleLibrary,compileScene,fileSha256} from '../src/style.mjs';
import {projectSourceRegion} from '../src/visual-steps.mjs';
import {reviewVisualEvidence,visualRequirements} from '../src/visual-review.mjs';
import {nativeMediaTool} from '../../../plugins/video-studio/workbench/media.mjs';
const execute=promisify(execFile);
const profile={width:320,height:180,fps:25};
const style={id:'henry-technical-explainer',version:8,templates:[{id:'step-reveal'}]};
const example=(hash)=>({style,start:0,duration:100,anchorAssetId:'photo',anchorSourceFrame:0,
  evidenceView:{width:320,height:180,sha256:hash,start:0,duration:100},
  visualSteps:[{stage:'detail',atFrame:0,label:'亮脊',observation:'中部平行条带的上缘明显发亮。',region:{x:.22,y:.55,width:.22,height:.22}},
    {stage:'mechanism',atFrame:36,label:'沟槽阴影',observation:'相邻沟槽的背光面有暗带。',region:{x:.57,y:.32,width:.20,height:.19}},
    {stage:'verification',atFrame:72,label:'回看靴印',observation:'整幅靴印里能看到交替的亮脊和凹槽。',region:{x:0,y:0,width:1,height:1}}]});

test('science style maps real source regions to the canvas across contain, crop and camera motion',async()=>{
  const portrait={width:100,height:100},r={x:0,y:0,width:.5,height:.5};
  let box=projectSourceRegion(r,portrait,profile,0);assert.equal(box.width,.28125);assert.equal(box.x,.359375);
  assert.equal(projectSourceRegion(r,{...portrait,pixelAspect:16/9},profile,0).x,.25);
  box=projectSourceRegion({x:.4,y:.4,width:.2,height:.2},{...portrait,fit:'cover'},profile,0);assert.equal(box.x,.5);assert.ok(Math.abs(box.y-.5)<1e-7);
  const moving={width:320,height:180,start:12,duration:10,framing:{from:{x:.5,y:.5,zoom:1},to:{x:.5,y:.5,zoom:2}}};
  assert.ok(Math.abs(projectSourceRegion({x:.4,y:.4,width:.2,height:.2},moving,profile,21).width-.4)<1e-7);
  const scene=example('0'.repeat(64)),layers=compileScene(scene,profile);
  assert.equal(layers.filter(c=>c.shape==='outline').length,2);assert.equal(layers.filter(c=>c.templateRole==='process-rail'&&c.stageActive).length,3);
  assert.equal(layers.filter(c=>c.templateRole==='process-rail'&&c.start<=45&&c.start+c.duration>45).length,3);
  assert.deepEqual(layers.filter(c=>c.shape==='outline').map(c=>c.start),[0,36]);assert.ok(layers.every(c=>c.locked===false&&c.evidenceAnchor.sha256===scene.evidenceView.sha256));
  const invalid=structuredClone(scene);invalid.visualSteps[1].region.x=.94;assert.throws(()=>compileScene(invalid,profile),/兴趣区/);
  const off=structuredClone(scene);off.evidenceView.framing={from:{x:.85,y:.80,zoom:4}};assert.throws(()=>compileScene(off,profile),/裁出/);
  assert.equal(visualRequirements({brief:'不用可编辑强调，保留原图。'}).editableEvidence,false);
  const library=createStyleLibrary(os.tmpdir(),{legacyHome:false});const plan=(await library.get(style.id,8)).executionPlan;
  assert.ok(plan.stages.mechanism.components.includes('process-rail'));assert.ok(plan.prototype.some(row=>row.component==='comparison-guide'));
});

test('review distinguishes an unrelated effect from a single still with visible, editable evidence and a return to the original',async t=>{
  const ffmpeg=await nativeMediaTool('ffmpeg');if(!ffmpeg){t.skip('requires FFmpeg');return;}
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-evidence-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const photo=path.join(dir,'sample.ppm'),values=Buffer.alloc(320*180*3);
  for(let j=0;j<180;j++)for(let i=0;i<320;i++){const v=65+Math.floor((Math.sin(i*.14+j*.07)+1)*45);values.fill(v,(j*320+i)*3,(j*320+i)*3+3);}
  await writeFile(photo,Buffer.concat([Buffer.from('P6\n320 180\n255\n'),values]));
  const hash=await fileSha256(photo),scene=example(hash),layers=compileScene(scene,profile);
  const shot={id:'shot',track:'video',assetId:'photo',start:0,duration:100,sourceIn:0},asset={id:'photo',sha256:hash,path:photo,width:320,height:180,kind:'image'};
  const project={style,profile,brief:'中文技术科普，带一处能在原图上核对的可编辑强调，最后回到照片。',assets:[asset],settings:{visualRequirements:{styleFidelity:true}},timeline:{clips:[shot,...layers]}};
  const filter=layers.filter(c=>c.shape==='outline').map(c=>{const g=c.geometry;return 'drawbox=x='+Math.round((g.x-g.width/2)*320)+':y='+Math.round((g.y-g.height/2)*180)+':w='+Math.round(g.width*320)+':h='+Math.round(g.height*180)+':color=0x'+c.style.color.slice(1)+':t=3:enable=\'between(n,'+c.start+','+(c.start+c.duration-1)+')\'';}).join(',');
  const encode=async(name,vf)=>{const out=path.join(dir,name);await execute(ffmpeg,['-v','error','-loop','1','-framerate','25','-i',photo,'-t','4',...(vf?['-vf',vf]:[]),'-c:v','libx264','-pix_fmt','yuv420p','-threads','1',out]);return out;};
  const marked=await encode('shown.mp4',filter),plain=await encode('plain.mp4','');
  const review=(p,videoPath)=>reviewVisualEvidence(p,{ffmpeg,videoPath,hashFile:fileSha256});
  let result=await review(project,marked);
  assert.deepEqual(result.findings,[],JSON.stringify(result));assert.equal(result.evidence.distinctFocusedRegions,2);assert.equal(result.evidence.returnToOriginal,true);
  result=await review(project,plain);assert.equal(result.findings[0].severity,'unknown');assert.equal(result.evidence.confirmedSteps.length,0);
  const generic={...project,timeline:{clips:[shot,{id:'floating',track:'graphic',text:'注意这里',start:0,duration:100,keyframes:[{frame:0,x:.1,y:.1},{frame:20,x:.4,y:.5}]}]}};
  result=await review(generic,plain);assert.deepEqual(result.findings.map(f=>[f.id,f.severity]),[['required-located-visual','major']]);
  result=await review({...generic,brief:'展示原图，允许简单处理。',settings:{}},plain);assert.equal(result.findings.length,0);
  result=await review({...project,settings:{visualRequirements:{motionFootage:true}}},marked);assert.ok(result.findings.some(f=>f.id==='required-moving-footage'&&f.severity==='major'));
  const cropOnly={...generic,timeline:{clips:[{...shot,framing:{from:{x:.4,y:.4,zoom:1.3},to:{x:.6,y:.6,zoom:1.3}}}]}};
  assert.equal((await review(cropOnly,plain)).findings[0].severity,'unknown');
});
