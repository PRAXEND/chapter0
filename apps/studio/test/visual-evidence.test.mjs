import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {createStyleLibrary,compileScene,fileSha256} from '../src/style.mjs';
import {projectSourceRegion} from '../src/visual-steps.mjs';
import {shotFingerprint} from '../src/director-visual.mjs';
import {reviewVisualEvidence,visualRequirements} from '../src/visual-review.mjs';
import {nativeMediaTool} from '../../../plugins/video-studio/workbench/media.mjs';
const execute=promisify(execFile);
const profile={width:320,height:180,fps:25};
const style={id:'henry-technical-explainer',version:8,templates:[{id:'step-reveal'}]};
const videoFirstStyle={id:'renamed-field-style',templates:[{id:'step-reveal'}],rules:[{id:'video-first',basis:'user_direction',instruction:'以有信息的运动画面为主体，必要原图可短暂出现。'}]};
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
  const large=compileScene(scene,{...profile,width:1280,height:720});
  assert.ok(large.find(c=>c.evidenceAnchor.stage==='mechanism'&&c.templateRole==='evidence-label').style.fontSize>=45);
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
  const green=await encode('plain-paint.mp4','drawbox=color=0x48e1d1:t=fill');
  result=await review(project,green);assert.equal(result.evidence.confirmedSteps.length,0);
  const generic={...project,timeline:{clips:[shot,{id:'floating',track:'graphic',text:'注意这里',start:0,duration:100,keyframes:[{frame:0,x:.1,y:.1},{frame:20,x:.4,y:.5}]}]}};
  result=await review(generic,plain);assert.deepEqual(result.findings.map(f=>[f.id,f.severity]),[['required-located-visual','major']]);
  result=await review({...generic,brief:'展示原图，允许简单处理。',settings:{}},plain);assert.equal(result.findings.length,0);
  result=await review({...project,settings:{visualRequirements:{motionFootage:true}}},marked);assert.ok(result.findings.some(f=>f.id==='required-moving-footage'&&f.severity==='major'));
  const mismatched={...project,timeline:{clips:[...project.timeline.clips,{track:'caption',id:'wrong-cue',start:36,duration:36,text:'工厂正在向订单系统写入价格数据。'}]}};
  result=await review(mismatched,marked);
  assert.equal(result.findings.find(f=>f.id.startsWith('visual-words-'))?.fromFrame,36);
  const falseReturn={...project,timeline:{clips:[shot,...layers.filter(c=>c.evidenceAnchor.stage==='detail')]}};
  result=await review(falseReturn,marked);assert.equal(result.evidence.returnToOriginal,false);
  assert.ok(result.findings.some(f=>f.id==='required-science-execution'));
  const otherStyle={...generic,style:{id:'renamed-science'},brief:'严格遵循所选风格',settings:{},timeline:{clips:[shot]}};
  result=await reviewVisualEvidence(otherStyle,{videoPath:plain,ffmpeg,hashFile:fileSha256,styleSpec:{templates:[{id:'step-reveal'}]}});
  assert.equal(result.findings[0].id,'required-science-execution');
  const ordinaryPhoto={...project,settings:{visualRequirements:{editableEvidence:true}},brief:'在原照上做局部解释并给一处可编辑强调。'};
  const reviewRule=(p,f=marked)=>reviewVisualEvidence(p,{ffmpeg,videoPath:f,styleSpec:videoFirstStyle,hashFile:fileSha256});
  const A=await reviewRule(ordinaryPhoto);assert.equal(A.evidence.styleExecution.motionStatus,'unmet');
  assert.equal(A.evidence.motionCoverage.stillFrames,100);assert.deepEqual(A.findings.map(f=>[f.id,f.severity]),[['style-video-first','minor']]);
  result=await reviewRule({...ordinaryPhoto,brief:'本片必须忠实复刻 Henry 科普风格。'});assert.ok(result.findings.some(f=>f.id==='style-video-first'&&f.severity==='major'));
  for(const override of [{brief:'全片只用原照片，加入可编辑强调。'}, {settings:{visualRequirements:{motionFootage:false,styleFidelity:true}}}]){
    result=await reviewRule({...ordinaryPhoto,...override});assert.equal(result.evidence.styleExecution.motionStatus,'photo-adaptation');assert.deepEqual(result.findings,[]);
  }
  result=await reviewRule({...ordinaryPhoto,brief:'开头只用原照，再转到实验。'});assert.equal(result.evidence.styleExecution.motionStatus,'unmet');
  const synchronized={...ordinaryPhoto,timeline:{clips:[shot,...layers.filter(l=>l.templateRole!=='evidence-label'),{id:'sub',track:'caption',text:'中部平行条带的上缘明显发亮。',start:0,duration:36}]}};
  result=await reviewRule(synchronized);assert.ok(result.evidence.steps.some(s=>s.annotation==='synchronized-caption'&&s.frameMatch.visible));
  assert.ok(!result.findings.some(f=>f.id==='required-located-visual'));
  result=await reviewRule({...synchronized,timeline:{clips:synchronized.timeline.clips.filter(c=>c.shape!=='outline')}});
  assert.ok(result.findings.some(f=>f.id==='required-located-visual'));
  const cropOnly={...generic,timeline:{clips:[{...shot,framing:{from:{x:.4,y:.4,zoom:1.3},to:{x:.6,y:.6,zoom:1.3}}}]}};
  assert.equal((await review(cropOnly,plain)).findings[0].severity,'unknown');
});


test('witnessed moving footage can carry a science sequence without annotation; a frozen final and a stale check cannot establish it',async t=>{
  const ffmpeg=await nativeMediaTool('ffmpeg');if(!ffmpeg){t.skip('requires FFmpeg');return;}
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-science-footage-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const make=async(input,name)=>{
    const f=path.join(dir,name+'.mp4');await execute(ffmpeg,['-v','error','-f','lavfi','-i',input,'-t','3','-c:v','libx264','-pix_fmt','yuv420p','-threads','1',f]);return f;
  };
  const moving=await make('testsrc2=size=160x90:rate=25','moving'),frozen=await make('color=c=black:s=160x90:r=25','frozen');
  const sha256=await fileSha256(moving),asset={id:'sequence',kind:'video',path:moving,width:160,height:90,sha256},stages=['problem','mechanism','verification'];
  const subjects=['第一次处于画面左方','第二个区域发生变化','末端的结果可见'];
  const clips=stages.map((stage,i)=>({id:'shot'+i,track:'video',assetId:asset.id,sourceIn:i*25,start:i*25,duration:25}));
  const frames=[],checks=[],storyboard=[];
  for(const [i,stage] of stages.entries()) {
    const at=i*25+9,description=subjects[i],frame=path.join(dir,stage+'.jpg');
    await execute(ffmpeg,['-v','error','-ss',String(at/25),'-i',moving,'-frames:v','1','-threads','1',frame]);
    const hash=await fileSha256(frame);
    frames.push({source:'asset',assetId:asset.id,assetHash:sha256,seconds:at/25,sha256:hash},{source:'timeline',stage,frame:at,sha256:hash});
    checks.push({stage,frame:at,needsFix:false,observation:description});
    storyboard.push({assetId:asset.id,start:i*25,duration:25,visualSteps:[{stage,atFrame:at,assetHash:sha256,sourceFrame:at,observation:description,witnessFrameHash:hash}]});
  }
  const project={profile:{...profile,width:160,height:90},style:{id:'field-science',templates:[{id:'step-reveal'}]},brief:'忠实遵循所选风格',assets:[asset],settings:{visualRequirements:{styleFidelity:true}},timeline:{clips},storyboard};
  project.visualDirection={frames,checks,timelineHash:shotFingerprint(project)};
  const review=videoPath=>reviewVisualEvidence(project,{videoPath,ffmpeg,hashFile:fileSha256});
  let result=await review(moving);
  assert.deepEqual(result.findings,[],JSON.stringify(result));assert.equal(result.evidence.witnessedShots.length,3);
  const measured=(p,videoPath)=>reviewVisualEvidence(p,{videoPath,ffmpeg,hashFile:fileSha256,styleSpec:videoFirstStyle});
  result=await measured(project,moving);assert.equal(result.evidence.styleExecution.motionStatus,'met',JSON.stringify(result.evidence));
  assert.equal(result.evidence.motionCoverage.informativeFrames,75);
  const raw=await measured({...project,visualDirection:null,storyboard:[]},moving);
  assert.equal(raw.evidence.styleExecution.motionStatus,'unverified');
  const photoFile=path.join(dir,'problem.jpg'),photo={id:'still',kind:'image',path:photoFile,sha256:await fileSha256(photoFile),width:160,height:90};
  const mixed={...project,brief:'从现场转到原照。',settings:{},assets:[asset,photo],timeline:{clips:[clips[0],{id:'photo',track:'video',assetId:photo.id,start:25,duration:50,sourceIn:0}]}};
  mixed.visualDirection={frames,checks:[checks[0]],timelineHash:shotFingerprint(mixed)};
  const mixedFilm=path.join(dir,'mixed.mp4');
  await execute(ffmpeg,['-v','error','-i',moving,'-loop','1','-framerate','25','-i',photoFile,'-filter_complex','[0:v]trim=end=1,setpts=PTS-STARTPTS[v0];[1:v]trim=end=2,setpts=PTS-STARTPTS[v1];[v0][v1]concat=n=2:v=1:a=0,format=yuv420p[out]','-map','[out]','-t','3','-c:v','libx264','-threads','1',mixedFilm]);
  const B=await measured(mixed,mixedFilm);assert.equal(B.evidence.styleExecution.motionStatus,'partial');assert.deepEqual([B.evidence.motionCoverage.changingFrames,B.evidence.motionCoverage.stillFrames,B.evidence.motionCoverage.totalFrames],[25,50,75]);
  assert.deepEqual(B.findings.map(f=>[f.id,f.severity]),[['style-video-first','minor']]);
  result=await review(frozen);assert.ok(result.findings.some(f=>f.id==='required-science-execution'),JSON.stringify(result));
  project.visualDirection.checks[1]={...checks[1],needsFix:true,observation:'字幕讲到第二个区域，成片还在第一个区域。'};
  result=await review(moving);assert.ok(result.findings.some(f=>f.id==='visual-witness-34'&&f.fromFrame===34));
  project.timeline.clips[0].gain=.2;
  result=await review(moving);assert.ok(!result.findings.some(f=>f.id==='visual-witness-34'));assert.equal(result.evidence.witnessedShots,undefined);
});
