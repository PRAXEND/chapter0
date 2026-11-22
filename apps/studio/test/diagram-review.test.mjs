import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {renderProject,mediaTool} from '../src/media.mjs';
import {fileSha256} from '../src/style.mjs';
import {reviewVisualEvidence} from '../src/visual-review.mjs';

test('final glyphs and relative object movement distinguish an explanatory diagram from a labelled still, camera move, or animated words',async t=>{
  const ffmpeg=await mediaTool('ffmpeg');if(!ffmpeg){t.skip('requires FFmpeg');return;}
  const temp=await mkdtemp(path.join(os.tmpdir(),'studio-schematic-test-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const profile={width:640,height:360,fps:24},duration=96,file=path.join(temp,'rock.ppm'),bytes=Buffer.alloc(320*180*3);
  for(let y=0;y<180;y++)for(let x=0;x<320;x++){const n=(y*320+x)*3;bytes.fill(40+Math.round(20*Math.sin(x*.08+y*.05)),n,n+3);}
  await writeFile(file,Buffer.concat([Buffer.from('P6\n320 180\n255\n'),bytes]));
  const asset={id:'photo',kind:'image',path:file,width:320,height:180,sha256:await fileSha256(file)};
  const style={id:'technical-proof',version:4},styleSpec={...style,rules:[{id:'video-first',basis:'user_direction'}],templates:[{id:'step-reveal'}]};
  const original={id:'source',track:'video',start:0,duration,sourceIn:0,assetId:asset.id,gain:0,fit:'contain'};
  const label=(id,text,start,duration,y)=>({id,track:'graphic',start,duration,text,geometry:{x:.31,y},style:{fontSize:28,color:'#FFFFFF',backgroundColor:'#061218'}});
  const shape=(id,x,y,width,height,color)=>({id,track:'graphic',shape:'outline',text:'',start:0,duration,geometry:{x,y,width,height},style:{color,strokeWidth:4}});
  const piston=shape('moving-piston',.29,.32,.22,.08,'#F7CB52'),datum=shape('fixed-ground',.42,.59,.12,.045,'#48E1D1');
  piston.keyframes=[[0,.32],[15,.32],[32,.50],[52,.50],[68,.31],[95,.31]].map(([frame,y])=>({frame,x:.29,y,scale:1,opacity:1}));
  const title=label('heading','原理示意图',0,96,.12),press=label('step1','活塞压下',0,49,.78),lift=label('step2','活塞抬起',49,47,.78);
  const base={profile,style,brief:'说明工作过程。',assets:[asset],revision:1};
  const withClips=clips=>({...base,timeline:{clips}});
  const meaningful=withClips([original,title,press,lift,piston,datum]);
  const render=async(p,name)=>(await renderProject(p,{directory:temp,output:path.join(temp,name+'.mp4')})).videoPath;
  const inspect=(p,videoPath)=>reviewVisualEvidence(p,{styleSpec,ffmpeg,videoPath,hashFile:fileSha256});
  const verified=await inspect(meaningful,await render(meaningful,'editable-diagram')),animation=verified.evidence.explanatoryAnimation;
  assert.equal(animation.diagramFrames,96,JSON.stringify(animation));assert.equal(animation.actionFrames,33);
  assert.deepEqual(animation.windows[0].actions.map(a=>[a.fromFrame,a.middleFrame,a.toFrame,a.objectId,a.referenceId]),[[15,24,32,piston.id,datum.id],[52,60,68,piston.id,datum.id]]);
  assert.equal(verified.evidence.motionCoverage.stillFrames,96);assert.equal(verified.evidence.motionCoverage.changingFrames,0);
  assert.equal(verified.evidence.styleExecution.motionStatus,'partial');assert.deepEqual(verified.findings.map(f=>f.severity),['minor']);

  const unsigned=withClips([original,press,lift,piston,datum]);
  assert.equal((await inspect(meaningful,await render(unsigned,'moving-but-identity-absent'))).evidence.explanatoryAnimation.actionFrames,0);
  const fixed={...piston,keyframes:[]};
  const withoutMotion=withClips([original,title,press,lift,fixed,datum]);
  const still=await render(withoutMotion,'only-labelled-still');
  for(const p of [withoutMotion,meaningful]){
    const check=await inspect(p,still);assert.equal(check.evidence.explanatoryAnimation.actionFrames,0);
    assert.equal(check.findings.find(f=>f.id==='style-video-first')?.severity,'major');
  }
  const pan=withClips([{...original,framing:{from:{x:.33,y:.5,zoom:1.5},to:{x:.65,y:.5,zoom:1.5}}},title,
    {...press,track:'caption',keyframes:[{frame:0,x:.23,scale:1},{frame:46,x:.51,scale:1.4}]},lift,fixed,datum]);
  assert.equal((await inspect(pan,await render(pan,'camera-and-text'))).evidence.explanatoryAnimation.actionFrames,0);
  const moveTogether=c=>({...c,keyframes:[{frame:0,x:c.geometry.x,y:c.geometry.y},{frame:40,x:c.geometry.x+.13,y:c.geometry.y},{frame:95,x:c.geometry.x,y:c.geometry.y}]});
  const translated=withClips([original,title,press,lift,moveTogether(fixed),moveTogether(datum)]);
  assert.equal((await inspect(translated,await render(translated,'translated-panel'))).evidence.explanatoryAnimation.actionFrames,0);
});
