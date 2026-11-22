import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createStore} from '../src/project.mjs';
import {createDirector} from '../src/production.mjs';
import {resolveProductionAudio} from '../src/style-audio-preparation.mjs';
import {voiceLibrary} from '../src/voices.mjs';
import {fileHash,probeMedia} from '../src/media.mjs';
import {mediaTool} from '../src/media-runtime.mjs';

const wish={id:'my-audio-rules',version:2,name:'自选解说',rules:[{id:'voice-speed'},{id:'instrumental-bed'}],
  audioBlueprint:{voice:{preferred_saved_name:'授权解说',speed:1.2},music:{title:'Test bed',author:'Studio',url:'https://example.test/bed',
    license:'CC BY 4.0',license_url:'https://creativecommons.org/licenses/by/4.0/',source_seconds:[1,7]}},references:[],templates:[]};
async function wav(file,{seconds=8,frequency=700,level=.3}={}) {
  const rate=24000,count=Math.round(seconds*rate),b=Buffer.alloc(44+count*2);
  b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(count*2,40);
  for(let i=0;i<count;i++)b.writeInt16LE(Math.round(Math.sin(2*Math.PI*i*frequency/rate)*level*25000),44+2*i);
  await writeFile(file,b);
}
async function fixture(t,real=false){
  const home=await mkdtemp(path.join(os.tmpdir(),'style-audio-production-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const store=createStore(home,{probeMedia:real?probeMedia:async file=>({kind:path.extname(file)==='.ppm'?'image':'audio',duration:8,hasAudio:path.extname(file)!=='.ppm'})});
  t.after(()=>store.close());
  const music=path.join(home,'soundtrack.wav');await wav(music);
  const sha256=await fileHash(music);
  const styles={get:async()=>wish,getMusicResource:async()=>({verified:true,available:true,path:music,sha256})};
  return {home,store,styles,music,sha256};
}

test('unbound style uses a named local audition; matching consent and explicit project choices win',async t=>{
  const {home,store,styles,sha256}=await fixture(t);
  const deps={store,styleLibrary:styles};
  const p=store.create({mode:'script',style:{id:wish.id,version:wish.version},settings:{cloudEnabled:false,cloudBudget:0}});
  let ready=await resolveProductionAudio(deps,p);
  assert.equal(ready.settings.voiceMode,'preset');assert.equal(ready.settings.presetVoice,'dylan');
  assert.equal(ready.styleAudio.voice.status,'preview-only');assert.equal(ready.styleAudio.voice.referenceHash,null);
  assert.equal(ready.styleAudio.music.status,'matched');assert.equal(ready.styleAudio.music.sha256,sha256);
  assert.equal((await resolveProductionAudio(deps,ready)).revision,ready.revision);
  const archived=await resolveProductionAudio({...deps,styleLibrary:{...styles,getMusicResource:async()=>null}},ready);
  assert.equal(archived.styleAudio.music.assetId,ready.styleAudio.music.assetId);
  assert.equal(archived.styleAudio.music.status,'alternative');assert.equal(archived.styleAudio.music.sourceStart,1);
  const audition=store.create({mode:'script',style:p.style});
  const prepared=await resolveProductionAudio(deps,audition,{voiceOnly:true});
  assert.equal(prepared.settings.presetVoice,'dylan');assert.equal(prepared.assets.length,0);
  const voices=voiceLibrary(store),sample=path.join(home,'approved.wav');await wav(sample,{frequency:330});
  const reference=await store.addAsset(p.id,sample,{name:'合成测试录音'});const entry=await voices.enroll(p.id,{name:'授权解说',assetId:reference.id,referenceText:'本地测试。',consent:true});
  ready=await resolveProductionAudio(deps,store.get(p.id));
  assert.equal(ready.settings.voiceMode,'clone');assert.equal(ready.settings.voiceLibraryId,entry.id);
  assert.equal(ready.styleAudio.voice.status,'matched');assert.equal(ready.styleAudio.voice.referenceHash,reference.sha256);
  const fresh=store.create({mode:'script',style:p.style,brief:'本期不需要背景音乐。请用系统中文配音。'});
  const user=await resolveProductionAudio(deps,fresh);
  assert.equal(user.settings.voiceMode,'system');assert.equal(user.styleAudio.voice.status,'user-selected');
  assert.equal(user.settings.musicMode,'none');assert.equal(user.styleAudio.music.status,'user-selected');
  assert.equal(user.settings.cloudEnabled,false);assert.equal(user.settings.cloudBudget,0);
});

test('local production applies one pitch-preserving speed change, aligns final speech, and measures a fixed licensed bed',async t=>{
  if(!await mediaTool('ffmpeg'))return t.skip('FFmpeg unavailable');
  const {home,store,styles,sha256}=await fixture(t,true);
  const p=store.create({mode:'script',title:'信号灯',script:'红色信号亮起。',style:{id:wish.id,version:2},profile:{width:160,height:90,fps:24}});
  const pic=path.join(home,'signal.ppm');await writeFile(pic,Buffer.concat([Buffer.from('P6\n32 24\n255\n'),Buffer.alloc(32*24*3,50)]));
  await store.addAsset(p.id,pic);
  const measured=[];
  const audio={async synthesize(_,opts){
    assert.equal(opts.mode,'preset');assert.equal(opts.voice,'dylan');assert.ok(!opts.referencePath);
    await wav(opts.output,{seconds:2.4,frequency:220});return {duration:2.4,preset:'dylan',model:'test-generator',modelRevision:'local-test'};
  },async transcribe(file){const info=await probeMedia(file);measured.push(info.duration);return [{text:p.script,start:.1,end:info.duration-.1}];}};
  const d=createDirector({store,styleLibrary:styles,audio,media:{}});t.after(()=>d.close());
  await d.run(p.id,{kind:'produce',engine:'local'});
  const ready=store.get(p.id),n=ready.timeline.clips.find(c=>c.track==='narration'),v=ready.assets.find(a=>a.id===n.assetId);
  assert.equal(v.source.mode,'preset');assert.equal(v.source.preset,'dylan');assert.equal(v.source.referenceHash,null);
  assert.equal(v.source.speechRate,1.2);assert.equal(v.source.tempoMethod,'ffmpeg-atempo-once');
  assert.notEqual(v.sha256,v.source.baseSha256);assert.ok(Math.abs(v.duration-2)<.035);
  assert.equal(measured[0],v.duration);assert.equal(n.speed,1);
  const c=ready.timeline.clips.find(c=>c.track==='music');assert.equal(c.sourceIn,24);assert.equal(c.ducking,false);
  assert.equal(ready.styleAudio.music.sha256,sha256);assert.equal(ready.styleAudio.music.mixMethod,'measured-fixed');
  assert.ok(Math.abs(ready.styleAudio.music.voiceLUFS-ready.styleAudio.music.sourceLUFS-20*Math.log10(c.gain)-14)<.06);
  const candidate=ready.assets.find(a=>a.id===c.assetId);assert.equal(candidate.source.license,'CC BY 4.0');assert.equal(candidate.source.author,'Studio');
});
