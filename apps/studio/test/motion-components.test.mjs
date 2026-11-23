import test from 'node:test';
import assert from 'node:assert/strict';
import {componentClip,motionCatalog,motionCues,motionSample,validateMotionClip} from '../src/motion-components.mjs';
import {compositionSamples,pixelDifference} from '../src/composite-parity.mjs';

const profile={width:1920,height:1080,fps:24};
const make=(componentId,extra={})=>componentClip({id:'label',componentId,start:120,duration:120,...extra},profile);
test('six native definitions keep their editable properties and only registered JSX is accepted',()=>{
  assert.equal(new Set(motionCatalog.map(c=>c.id)).size,6);
  for(const spec of motionCatalog){
    const c=make(spec.id);validateMotionClip(c,profile);
    const sample=motionSample(c,profile,126);
    assert.deepEqual([sample.width,sample.height],[spec.width,spec.height]);
    assert.deepEqual(Object.keys(sample.props),spec.fields.map(f=>f.key));
    assert.equal(sample.index,spec.index);
  }
  assert.throws(()=>make('custom-jsx'),/注册/);
  assert.throws(()=>make('impact-title',{props:{html:'<span>new</span>'}}),/未知/);
  assert.throws(()=>make('impact-title',{props:{size:'large'}}),/参数无效/);
  assert.throws(()=>make('staggered-explanation',{cueFrames:[0,14,120]}),/出场帧/);
  assert.throws(()=>make('staggered-explanation',{cueFrames:[0,14,13]}),/出场帧/);
  assert.throws(()=>validateMotionClip({...make('impact-title'),keyframes:[{frame:0,x:.5}]},profile),/独立动效层/);
});
test('moving one narration cue keeps the two other native entrances at their original project frames',()=>{
  const original=make('staggered-explanation',{cueFrames:[0,24,72]});
  const edited=make('staggered-explanation',{cueFrames:[0,48,72],props:{b:'对准槽口'}});
  assert.equal(motionSample(edited,profile,120).frame,0);
  assert.ok(motionSample(original,profile,150).frame>=18);
  assert.ok(motionSample(edited,profile,150).frame<18);
  assert.equal(motionSample(edited,profile,168).frame,18);
  assert.equal(motionSample(edited,profile,192).frame,36);
  assert.equal(motionSample(edited,profile,194).props.b,'对准槽口');
  const rail=make('process-rail',{cueFrames:[0,24,72]});
  assert.deepEqual([motionSample(rail,profile,150).props.second,motionSample(rail,profile,150).props.third],[30,90]);
  const source=make('source-label',{cueFrames:[0,9,30]});
  assert.deepEqual([128,129,150].map(f=>motionSample(source,profile,f).frame),[0,1302,0]);
  const staggered=motionCatalog.find(c=>c.id==='staggered-explanation');
  assert.deepEqual(motionCues(staggered,120,24),[0,14,29]);
});
test('parity checks use layer regions and matching revision frame coordinates',()=>{
  const c=make('source-label',{cueFrames:[0,48]});
  const checks=compositionSamples({profile,timeline:{clips:[c,{...c,id:'hidden',hidden:true}]}});
  assert.deepEqual(checks.map(item=>item.frame),[125,173]);
  const white=Buffer.alloc(8*4*3,255), black=Buffer.from(white);
  for(let y=0;y<4;y++)black.fill(0,y*8*3,(y*8+4)*3);
  const left={x:0,y:0,width:.5,height:1};
  assert.equal(pixelDifference(white,black,8,4,left).matches,false);
  assert.equal(pixelDifference(white,black,8,4,{...left,x:.5}).matches,true);
});

test('a thin rotating signal is compared inside its transformed silhouette at a nonzero angle',()=>{
  const c={track:'graphic',id:'blade',shape:'polygon',start:0,duration:24,geometry:{x:.4,y:.5,width:.4,height:.018,
    points:[[0,0],[1,0],[1,1],[0,1]]},keyframes:[{frame:0,rotation:0},{frame:23,rotation:360}]};
  const p={profile:{width:400,height:200,fps:24},timeline:{clips:[c]}};
  const [sample]=compositionSamples(p,1);
  assert.ok(sample.frame>0);
  const out=Buffer.alloc(400*200*3),preview=Buffer.alloc(out.length);
  const r=sample.bounds;
  for(let y=Math.floor(r.y*200);y<Math.ceil((r.y+r.height)*200);y++)
    for(let x=Math.floor(r.x*400);x<Math.ceil((r.x+r.width)*400);x++)preview.fill(255,(y*400+x)*3,(y*400+x)*3+3);
  const diff=pixelDifference(out,preview,400,200,r,sample.points);
  assert.equal(diff.matches,false);assert.ok(diff.pixels>100&&diff.pixels<800);
});

test('default component placement keeps the original shapes proportional across all workspace aspect ratios',()=>{
  const spec=motionCatalog.find(c=>c.id==='comparison-guide');
  for(const p of [{width:1080,height:1920,fps:30},{width:1920,height:1080,fps:24},{width:1000,height:1000,fps:60}]){
    const {geometry:g}=componentClip({id:'divide',componentId:spec.id,start:0,duration:180},p);
    assert.ok(Math.abs(g.width*p.width/(g.height*p.height)-spec.width/spec.height)<1e-8);
  }
});
