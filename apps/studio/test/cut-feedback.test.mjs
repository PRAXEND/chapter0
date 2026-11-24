import test from 'node:test';
import assert from 'node:assert/strict';
import {cutFeedback} from '../src/cut-feedback.mjs';

const profile={width:640,height:360,fps:24};
const project=(assets,clips,extra={})=>({revision:3,mode:'script',profile,settings:{},assets,timeline:{clips},...extra});
const asset=(id,kind,sha256=id,source={})=>({id,kind,sha256,name:id,duration:100,source});
const shot=(id,assetId,start,duration,extra={})=>({id,assetId,start,duration,track:'video',...extra});
const mediaUrl='https://archive.example/media/estuary.mp4';

test('actual visible photo returns, layered or missing background and partial sample evidence stay distinct',()=>{
  const p=project([
    asset('photo-a','image','photo',''),asset('photo-copy','image','photo'),
    asset('covered','video'),asset('cave','video','cave',{url:'https://archive.example/tides',credit:'Local archive'})
  ],[
    shot('never-visible','covered',2,4),shot('first','photo-a',2,8),shot('cave','cave',10,10),
    shot('return','photo-copy',20,5),{track:'caption',id:'intro',text:'estuary',start:0,duration:2},
    {track:'graphic',id:'outro',shape:'polygon',start:25,duration:3},shot('hidden','cave',28,100,{hidden:true}),
    shot('off','cave',28,20,{enabled:false})
  ]);
  const qa={revision:3,status:'advisory',candidatePlayable:true,artifactSha256:'rendered',evidence:{duration:28/24,
    visual:{motion:[{assetId:'cave',fromFrame:10,toFrame:19,result:'changing-footage'}],motionCoverage:{changingFrames:10,sampledVideoFrames:10}}},
    issues:[{id:'test',severity:'minor',fromFrame:10,toFrame:19,message:'可见主体有变化',fix:'do not prescribe a cut'}]};
  const r=cutFeedback(p,qa);
  assert.deepEqual(r.picture.coverage,{videoFrames:10,stillFrames:13,mixedFrames:0,unknownFrames:0,gapFrames:5});
  assert.deepEqual(r.picture.gaps,[{fromFrame:0,toFrame:2,overlays:['caption']},{fromFrame:25,toFrame:28,overlays:['graphic']}]);
  assert.equal(r.picture.opening.assetIds.length,0);assert.equal(r.picture.closing.assetIds.length,0);
  assert.equal(r.picture.sources.some(s=>s.assetId==='covered'),false);
  assert.equal(r.picture.repeatedStills[0].appearances,2);assert.equal(r.picture.repeatedStills[0].openingAndClosing,false);
  assert.equal(r.picture.motionSamples.samples[0].toFrame,20);
  assert.equal(r.review.issues[0].toFrame,20);assert.ok(!JSON.stringify(r).includes('prescribe'));
  assert.equal(r.picture.policy,'unspecified');
});

test('simultaneous panes and incoming dissolves count each timeline interval once per kind',()=>{
  const assets=[asset('still','image'),asset('motion','video')],full=shot('whole','still',0,24);
  const pane={x:.5,y:0,width:.5,height:1};
  const split=cutFeedback(project(assets,[full,shot('insert','motion',6,12,{viewport:pane})]));
  assert.deepEqual(split.picture.coverage,{videoFrames:12,stillFrames:24,mixedFrames:12,unknownFrames:0,gapFrames:0});
  assert.deepEqual(split.picture.windows.find(w=>w.assetId==='motion').viewport,pane);
  const blend=cutFeedback(project(assets,[full,shot('dissolve','motion',12,12,{transition:{type:'crossfade',duration:5}})]));
  assert.equal(blend.picture.coverage.stillFrames,17);assert.equal(blend.picture.coverage.mixedFrames,5);
  assert.equal(blend.picture.coverage.videoFrames,12);
});

test('mapped source windows honor trim, speed, parent offsets and distinguish unrelated files on a shared catalog page',()=>{
  const page='https://archive.example/surveys';
  const originals=[asset('estuary','video','original',{url:page,originalUrl:mediaUrl,credit:'Field team'}),
    asset('copy','video','original',{url:page}),asset('other','video','unique',{url:page,originalUrl:'https://archive.example/media/wind.mp4'}),
    asset('excerpt','video','cropped',{url:page,parentAssetId:'estuary',parentSha256:'original',sourceInSeconds:13}),
    asset('uncalibrated','video','uncalibrated',{url:page,parentSha256:'original'})];
  const clips=[shot('s1','estuary',0,48,{sourceIn:240,speed:2}),shot('s2','copy',48,48,{sourceIn:312}),
    shot('s3','other',96,48,{sourceIn:288}),shot('s4','excerpt',144,24),shot('s5','uncalibrated',168,24)];
  const r=cutFeedback(project(originals,clips));
  assert.deepEqual(r.picture.windows[0],{clipId:'s1',assetId:'estuary',fromFrame:0,toFrame:48,sourceFrom:10,sourceTo:14});
  const overlaps=r.picture.overlappingSourceWindows;
  assert.equal(overlaps.length,3);
  assert.deepEqual([overlaps[0].sourceFrom,overlaps[0].sourceTo,overlaps[0].via],[13,14,'file-sha256']);
  assert.equal(overlaps[1].via,'parent-range');
  assert.ok(overlaps.every(w=>!w.clipIds.includes('s3')&&!w.clipIds.includes('s5')));
  assert.equal(r.picture.sources[0].credit,'Field team');
});

test('an adjacent edit or continuous split display is not described as two separate appearances; explicit photo briefs stay authoritative',()=>{
  const a=asset('slide','image','h',{url:'file:///Users/private/scan.jpg'}),b=asset('copy','image','h');
  const p=project([a,b],[shot('p1','slide',0,12),shot('p2','copy',12,12)],{brief:'全片只用提供的照片。'});
  const r=cutFeedback(p);const g=r.picture.repeatedStills[0];
  assert.equal(g.placements,2);assert.equal(g.appearances,1);assert.equal(g.openingAndClosing,true);
  assert.equal(r.picture.policy,'images-only');assert.equal(r.picture.sources[0].url,undefined);
  p.brief='仅开头使用照片，随后展示现场。';p.settings.visualRequirements={motionFootage:false};
  assert.equal(cutFeedback(p).picture.policy,'photo-led');
  p.settings={};assert.equal(cutFeedback(p).picture.policy,'unspecified');
});

test('final voice and music samples are distinct from timeline placement, custom voice identity, effect audibility and a different revision',()=>{
  const assets=[asset('v','audio','voice',{mode:'preset',preset:'dylan'}),asset('bed','audio','bed',{title:'Folk Study'}),
    asset('hit','audio','hit',{role:'sfx'}),asset('photo','image')];
  const clips=[shot('base','photo',0,48),{id:'nar',assetId:'v',track:'narration',start:0,duration:48},
    {id:'bg',assetId:'bed',track:'music',start:0,duration:48},{id:'cue',assetId:'hit',track:'music',start:18,duration:6,muted:true},
    {id:'m',track:'graphic',start:6,duration:12,motion:{componentId:'process-rail'}}];
  const p=project(assets,clips,{settings:{voiceMode:'preset',targetDuration:3,sceneSound:false}}),qa={revision:3,issues:[],
    evidence:{audio:[{clip:'nar',sourceHash:'voice',windows:[{similarity:.97},{similarity:.44}]}],
      compositeParity:{checks:[{clipId:'m',frame:10,matches:true},{clipId:'base',matches:false}]},styleAudio:{
        voice:{status:'preview-only',sources:[{clipId:'nar',sha256:'voice',mode:'preset',voiceId:'dylan',identity:'preset-preview',paceMeasured:true,effectiveRate:1.2,matchedWindows:1}]},
        music:{status:'verified',mixStatus:'present',windows:[{status:'present',gainDb:-17.5},{status:'unverified',gainDb:4},{status:'present',gainDb:-17.1}]}}}};
  const r=cutFeedback(p,qa);
  assert.equal(r.targetSeconds,3);assert.equal(r.audio.voice.sources[0].identity,'preset-preview');assert.equal(r.audio.voice.matchedWindows,1);
  assert.deepEqual(r.audio.music.sampleCounts,{present:2,unverified:1});assert.deepEqual(r.audio.music.sampleGainRangeDb,[-17.5,-17.1]);
  assert.deepEqual([r.audio.music.clips,r.audio.effects.clips,r.audio.effects.enabledClips,r.audio.effects.mixStatus],[1,1,0,'not-sampled']);
  assert.deepEqual(r.graphics.componentCounts,{'process-rail':1});assert.deepEqual(r.graphics.previewExportSamples,{match:1});
  const stale=cutFeedback({...p,revision:4},qa);
  assert.equal(stale.review.link,'different-or-unknown-revision');assert.equal(stale.audio.voice.matchedWindows,0);
  assert.equal(stale.audio.voice.sources[0].identity,undefined);assert.equal(stale.audio.music.mixStatus,'not-sampled');
});
