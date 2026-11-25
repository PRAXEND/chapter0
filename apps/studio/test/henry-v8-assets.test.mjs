import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {createStore} from '../src/project.mjs';
import {componentClip,motionCatalog,motionSample} from '../src/motion-components.mjs';
import {components} from '../src/motion-jsx.generated.mjs';
import {serialize} from '../src/motion-dom.mjs';
import {archiveSound,soundResources,supportsSound} from '../src/style-sounds.mjs';
import {resolveProductionAudio} from '../src/style-audio-preparation.mjs';
import {styleAudioPolicy} from '../src/style-audio.mjs';
import {createStyleLibrary} from '../src/style.mjs';
import {reviewStyleAudio} from '../src/style-audio-review.mjs';
import {presetId,presetRevision,presetFiles} from '../src/qwen-preset.mjs';
import {newsTransition,shakeFilter,splitPictureEffects} from '../src/news-effects.mjs';
import {mediaTool} from '../src/media-runtime.mjs';

const profile={width:1920,height:1080,fps:30};
const hot={id:'henry-hot-news',version:8},tech={id:'henry-technical-explainer',version:8};
const hash=data=>createHash('sha256').update(data).digest('hex');
async function workspace(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'v8-edits-'));
  const store=createStore(root,{probeMedia:async file=>({kind:path.extname(file)==='.ppm'?'image':'audio',duration:170,hasAudio:path.extname(file)!=='.ppm'})});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true})});
  return {root,store,styleLibrary:createStyleLibrary(root,{legacyHome:false})};
}
function graphic(componentId,id,start=30,duration=100,opts={}){
  return componentClip({id,componentId,start,duration,...opts},profile);
}
test('all seven news sources keep native IDs and local props, semantic cues, signed tilt and the recovered four-corner projection',async()=>{
  const blue=JSON.parse(await readFile(new URL('../../../user-packs/henry-video-styles/styles/henry-hot-news-v8.json',import.meta.url))).reproduction_bundle;
  for(const spec of motionCatalog.filter(s=>s.styleId===hot.id)){
    const ref=blue.motion_graphics.find(x=>x.id===spec.sourceId);
    assert.ok(ref);assert.deepEqual(spec.fields.map(f=>f.key),ref.editableProperties.map(f=>f.key));
    const clip=graphic(spec.id,'on-stage',0,spec.referenceDuration);
    const sample=motionSample(clip,profile,9);
    const html=serialize(components[sample.index-1]({props:sample.props},sample.frame,sample.duration));
    assert.ok(html.includes('<div'));assert.doesNotMatch(html,/matrix3d\([^)]*ref-/);
    if(spec.fontFallback)assert.match(html,/Noto Sans SC/);
    if(spec.id==='hot-surface-projection'){
      const m=html.match(/matrix3d\(([^)]+)\)/)[1].split(',').map(Number);
      for(const [[x,y],[tx,ty]] of [[0,0],[500,0],[500,150],[0,150]].map((pair,i)=>[pair,blue.specific_edit_recipe.projection_corners[i]])){
        const z=m[3]*x+m[7]*y+1;
        assert.ok(Math.abs((m[0]*x+m[4]*y+m[12])/z+1240-tx)<1e-7);
        assert.ok(Math.abs((m[1]*x+m[5]*y+m[13])/z+725-ty)<1e-7);
      }
    }
  }
  const c=graphic('hot-orbit-mechanism','mechanism',9,120,{cueFrames:[0,47,75]});
  assert.deepEqual([9,56,84,128].map(at=>motionSample(c,profile,at).frame),[0,65,161,229]);
  assert.doesNotThrow(()=>graphic('hot-reaction-text','rx',0,54,{props:{tilt:-12,count:2}}));
  assert.throws(()=>graphic('hot-reaction-text','rx',0,54,{props:{count:1.5}}));
});
test('project edits align archived effects to exact cue frames and preserve user gain, lock, mute and explicit removal',async t=>{
  const {store}=await workspace(t);let p=store.create({mode:'topic',style:tech,profile});
  const edit=(commands,actor='user')=>p=store.apply(p.id,p.revision,commands,actor);
  const g=graphic('staggered-explanation','three',30,100,{cueFrames:[0,30,70]});
  edit([{op:'add',clip:g}]);const soundAt=key=>p.timeline.clips.find(c=>c.soundBinding?.key===key);
  const sound=soundAt('cue-1');assert.equal(sound.start+1,60);assert.equal(sound.actionFrame,60);
  assert.equal(p.assets.length,1);assert.equal(hash(await readFile(p.assets[0].path)),soundResources[0].sha256);
  edit([{op:'update',id:sound.id,changes:{gain:.076}},{op:'lock',id:sound.id,locked:true}]);
  assert.throws(()=>edit([{op:'update',id:g.id,changes:{start:45}}],'codex'),/已锁定/);
  assert.equal(store.get(p.id).timeline.clips.find(c=>c.id===g.id).start,30);
  edit([{op:'lock',id:sound.id,locked:false}]);
  edit([{op:'update',id:g.id,changes:{start:45,motion:{...g.motion,cueFrames:[0,44,70]}}}],'codex');
  assert.equal(soundAt('cue-1').start+1,89);assert.equal(soundAt('cue-1').gain,.076);
  edit([{op:'remove',id:sound.id}]);edit([{op:'update',id:g.id,changes:{start:50}}]);
  assert.equal(soundAt('cue-1'),undefined);
  const active=()=>p.timeline.clips.filter(c=>c.soundBinding);
  edit([{op:'update',id:g.id,changes:{muted:true}}]);assert.ok(active().every(s=>s.muted));
  edit([{op:'remove',id:g.id}]);assert.equal(active().length,0);
  const quiet=graphic('staggered-explanation','silent',0,90,{soundDesign:{enabled:false}});
  edit([{op:'add',clip:quiet}]);assert.equal(active().length,0);
});
test('the project sound switch, a single shared picture/graphic impact, and dedicated voice files obey project controls',async t=>{
  const {root,store}=await workspace(t);
  let p=store.create({mode:'script',style:hot,profile,settings:{sceneSound:false}});
  const file=path.join(root,'picture.ppm');await writeFile(file,'static file fixture');
  const picture=await store.addAsset(p.id,file);
  const speech=path.join(root,'reference.wav');await writeFile(speech,'private reference fixture');
  const voice=await store.addAsset(p.id,speech,{role:'voice-reference',consent:true});
  p=store.get(p.id);
  const edit=(commands)=>p=store.apply(p.id,p.revision,commands,'user');
  const sounds=()=>p.timeline.clips.filter(c=>c.soundBinding);
  const shot={track:'video',id:'shot',assetId:picture.id,start:5,duration:40,pictureEffects:[{type:'camera-shake',duration:7}]};
  const overlay=graphic('hot-impact-lines','lines',5,18);
  edit([{op:'add',clip:shot},{op:'add',clip:overlay}]);
  assert.equal(sounds().length,0);
  p=store.configure(p.id,p.revision,{settings:{sceneSound:true}});
  assert.equal(sounds().length,1);assert.equal(sounds()[0].soundBinding.ownerId,'lines');
  assert.throws(()=>edit([{op:'update',id:'lines',changes:{soundDesign:{assetId:voice.id}}}]),/音效/);
  edit([{op:'remove',id:'lines'}]);assert.equal(sounds().length,1);
  assert.equal(sounds()[0].soundBinding.ownerId,'shot');assert.equal(sounds()[0].actionFrame,5);
  edit([{op:'update',id:sounds()[0].id,changes:{muted:true}}]);
  edit([{op:'update',id:'shot',changes:{start:9}}]);assert.equal(sounds()[0].muted,true);
  p=store.configure(p.id,p.revision,{settings:{sceneSound:false}});
  assert.equal(sounds().length,0);
});
test('both pinned styles choose Dylan as their production voice, verify provenance, protect an explicit selection and find their exact original music',async t=>{
  const deps=await workspace(t);
  for(const style of [hot,tech]){
    let p=deps.store.create({mode:'script',style,profile});
    assert.equal(p.settings.voiceMode,'preset');assert.equal(p.settings.presetVoice,'dylan');
    p=await resolveProductionAudio(deps,p);assert.equal(p.styleAudio.voice.status,'matched');
    assert.equal(p.styleAudio.music.status,'matched');assert.match(p.styleAudio.music.license,style===hot?/ChatCut/:/CC BY/);
    const defaultSpec=await deps.styleLibrary.get(style.id,8);
    for(const resource of soundResources.filter(s=>supportsSound(style,s.id)))assert.equal(hash(archiveSound(style,resource.id).data),resource.sha256);
    assert.equal(defaultSpec.components.length,style===hot?7:6);
    const digest='1'.repeat(64),record={path:'/verification/speech.wav',id:'n',kind:'audio',sha256:digest,source:{
      mode:'preset',preset:'dylan',model:presetId,modelRevision:presetRevision,modelSha256:presetFiles['model.safetensors'][1],generatedHash:digest,
      speechRate:1.2,baseDuration:1.2,measuredSeconds:1,tempoMethod:'ffmpeg-atempo-once'}};
    const qaProject={...p,settings:{...p.settings,musicSelection:'user',musicEnabled:false},assets:[record],timeline:{clips:[{id:'voice',track:'narration',start:0,duration:30,assetId:'n'}]}};
    const options={hashFile:async()=>digest,probeDuration:async()=>1,voiceWindows:[{clip:'voice',sourceHash:digest,windows:[{similarity:.94,offset:0}]}]};
    let checked=await reviewStyleAudio(qaProject,defaultSpec,options);assert.equal(checked.evidence.voice.status,'verified',JSON.stringify(checked.evidence.voice));
    record.source.modelRevision='unknown';checked=await reviewStyleAudio(qaProject,defaultSpec,options);assert.notEqual(checked.evidence.voice.status,'verified');
    const override=deps.store.configure(p.id,p.revision,{settings:{voiceMode:'system',voiceSelection:'user'}});
    assert.equal((await resolveProductionAudio(deps,override)).styleAudio.voice.status,'user-selected');
    assert.equal(deps.store.get(p.id).settings.voiceMode,'system');
  }
  assert.equal(styleAudioPolicy({...hot,version:7,rules:[{id:'voice-speed'}]}).voice.preset,undefined);
});
test('local shake, whip and organic transition operate on the picture in a single decoded frame, including source clock after splitting',async t=>{
  const ffmpeg=await mediaTool('ffmpeg');if(!ffmpeg)return t.skip('FFmpeg unavailable');
  // Emit one unencoded RGB image into memory per assertion.
  const frame=(graph,src1='color=red:s=64x32',src2='color=blue:s=64x32')=>execFileSync(ffmpeg,['-v','error','-f','lavfi','-i',src1,'-f','lavfi','-i',src2,
    '-filter_complex',graph+'[result]','-map','[result]','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  for(const type of ['whip-pan','organic-dissolve']){
    const one=phase=>frame('[0:v][1:v]'+newsTransition(type,phase));
    assert.ok(one('0')[2]>180);assert.ok(one('1')[0]>180);
    const mid=one('.5');let reds=0,blues=0;
    for(let i=0;i<mid.length;i+=3){if(mid[i]>180)reds++;if(mid[i+2]>180)blues++;}
    assert.ok(reds>120&&blues>120);
  }
  const clip={track:'video',start:0,duration:24,pictureEffects:[{type:'camera-shake',offsetFrames:3,duration:15,strength:1,zoom:1.2,rotation:2}]};
  const [left,right]=splitPictureEffects(clip.pictureEffects,8);
  assert.equal(left[0].duration,5);assert.equal(right[0].phaseFrames,5);
  const at=(clip,start)=>frame('[0:v]'+shakeFilter(clip,start,{width:64,height:32,fps:30}),'testsrc2=s=64x32:r=30');
  assert.deepEqual(at(clip,11),at({...clip,start:8,duration:16,pictureEffects:right},11));
  assert.notDeepEqual(at(clip,0),at(clip,11));
});
