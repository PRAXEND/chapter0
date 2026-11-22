import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {mediaTool} from '../src/media.mjs';
import {fileSha256} from '../src/style.mjs';
import {reviewProject} from '../src/review.mjs';

const exec=promisify(execFile);
const profile={width:160,height:96,fps:25},duration=4,frames=duration*profile.fps;
const style={id:'example-science',version:3,rules:[{id:'voice-speed'},{id:'instrumental-bed'}],
  audioBlueprint:{voice:{preferred_saved_name:'本期技术解说',speed:1.2},
    music:{title:'Licensed bed',author:'Test',url:'https://example.org/music',license:'CC0'}}};
const basic={...style,rules:[]};
test('style audit compares the music stem in the actual mix, verifies the chosen voice, and honours explicit audio choices',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-style-audio-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const ffmpeg=await mediaTool('ffmpeg'),voice=path.join(dir,'voice.wav'),bed=path.join(dir,'bed.wav'),ref=path.join(dir,'reference.wav');
  const source=(filter,file)=>exec(ffmpeg,['-v','error','-f','lavfi','-i',filter,'-c:a','pcm_s16le',file]);
  await Promise.all([
    source('anoisesrc=color=pink:amplitude=0.3:sample_rate=48000:duration=4:seed=23',voice),
    source('aevalsrc=0.13*sin(2*PI*(169*t+11*t*t))+0.09*sin(2*PI*(477*t+16*t*t)):s=48000:d=4',bed),
    source('sine=frequency=221:sample_rate=48000:duration=1',ref)
  ]);
  const hashes=await Promise.all([voice,bed,ref].map(fileSha256)),[voiceHash,bedHash,refHash]=hashes;
  const mixed=path.join(dir,'mixed.mp4'),dry=path.join(dir,'voice-only.mp4'),whisperBed=path.join(dir,'low-gain.mp4'),vary=path.join(dir,'changing-bed.mp4');
  async function encode(file,gain) {
    await exec(ffmpeg,['-v','error','-f','lavfi','-i','color=black:s=160x96:r=25:d=4','-i',voice,'-i',bed,
      '-filter_complex','[2:a]volume='+gain+'[b];[1:a][b]amix=inputs=2:normalize=0[a]','-map','0:v','-map','[a]',
      '-t','4','-c:a','aac','-b:a','160k','-c:v','libx264','-pix_fmt','yuv420p',file]);
  }
  await Promise.all([encode(mixed,.2),encode(dry,0),encode(whisperBed,.035),encode(vary,"'if(lt(t,2),0.04,0.2)':eval=frame")]);
  const p={mode:'script',revision:1,profile,style:{id:style.id,version:3},settings:{voiceMode:'clone',voiceSelection:'style',
    voiceLibraryId:'narrator',voiceReferenceAssetId:'ref',musicMode:'library',musicSelection:'style'},
    styleAudio:{styleId:style.id,styleVersion:3,voice:{status:'matched',referenceHash:refHash},music:{status:'matched',assetId:'m',sha256:bedHash}},
    assets:[{id:'v',kind:'image',hasAudio:false},{id:'n',path:voice,sha256:voiceHash,duration,source:{mode:'clone',voiceId:'narrator',referenceHash:refHash,
      speechRate:1.2,baseDuration:4.8,measuredSeconds:4,tempoMethod:'ffmpeg-atempo',generatedHash:voiceHash}},
    {id:'m',path:bed,sha256:bedHash,duration,source:{kind:'style-music',title:'Licensed bed',author:'Test',url:'https://example.org/music',license:'CC0',styleResourceHash:bedHash}},
    {id:'ref',path:ref,sha256:refHash,duration:1,source:{consent:true,sourceVoice:'narrator'}}],
    timeline:{clips:[{id:'image',track:'video',assetId:'v',start:0,duration:frames},{id:'n-clip',track:'narration',assetId:'n',start:0,duration:frames},
      {id:'m-clip',track:'music',assetId:'m',start:0,duration:frames,gain:.2,ducking:false}]}};
  const check=(project,videoPath=mixed,styleSpec=style)=>reviewProject(project,{videoPath,styleSpec});
  let result=await check(p),audio=result.evidence.styleAudio;
  assert.equal(result.status,'deliverable',JSON.stringify(result.issues));
  assert.equal(audio.voice.status,'verified');assert.equal(audio.music.status,'verified');
  assert.equal(audio.music.coverageFrames,100);assert.equal(audio.music.mixStatus,'present');
  assert.ok(audio.music.windows.length>=2&&audio.music.windows.every(w=>w.status==='present'&&Math.abs(w.measuredGain-.2)<.04),JSON.stringify(audio));
  result=await check(p,dry);
  assert.equal(result.status,'repair',JSON.stringify(result));
  assert.equal(result.candidatePlayable,true);assert.equal(result.evidence.styleAudio.music.mixStatus,'missing-in-samples');
  assert.equal(result.issues.filter(i=>i.id==='style-audio-music').length,1);
  assert.equal(result.evidence.styleAudio.voice.status,'verified');

  const quiet=structuredClone(p);quiet.timeline.clips[2].gain=.035;
  result=await check(quiet,whisperBed);
  assert.equal(result.evidence.styleAudio.music.status,'verified',JSON.stringify(result.evidence.styleAudio.music));
  result=await check(p,vary);assert.equal(result.evidence.styleAudio.music.mixStatus,'present');
  assert.equal(result.evidence.styleAudio.music.ducking.observed,'variation-in-samples',JSON.stringify(result.evidence.styleAudio.music.windows));
  assert.equal(result.evidence.styleAudio.music.status,'unverified');
  const doubled=structuredClone(p);doubled.assets[1].source.baseDuration=6;
  assert.equal((await check(doubled)).evidence.styleAudio.voice.status,'unverified');
  const generic=structuredClone(p);generic.settings.voiceMode='system';generic.assets[1].source={mode:'system',model:'Tingting'};
  generic.assets[2].source={bedStyle:'calm',provider:'Video Studio',license:'Studio original composition'};
  result=await check(generic);
  assert.equal(result.status,'unverified');assert.equal(result.candidatePlayable,true);
  assert.deepEqual([result.evidence.styleAudio.voice.status,result.evidence.styleAudio.music.status,result.evidence.styleAudio.music.mixStatus],['preview-only','preview-only','present']);
  generic.settings.voiceSelection='user';generic.settings.musicSelection='user';generic.settings.musicAssetId='m';
  result=await check(generic);assert.equal(result.status,'deliverable',JSON.stringify(result));
  assert.equal(result.evidence.styleAudio.voice.status,'user-selected');
  generic.settings.voiceMode='import';generic.settings.narrationAssetId='n';generic.assets[1].source={kind:'user-recording'};
  generic.settings.musicMode='none';generic.settings.musicEnabled=false;
  const shouldBeSilent=structuredClone(generic);shouldBeSilent.timeline.clips.at(-1).muted=true;
  result=await check(shouldBeSilent,mixed);assert.equal(result.evidence.styleAudio.music.status,'unexpected');assert.equal(result.status,'repair');
  assert.equal((await check(shouldBeSilent,dry)).evidence.styleAudio.music.status,'user-off');
  generic.timeline.clips.pop();
  result=await check(generic,dry);assert.equal(result.status,'deliverable');assert.equal(result.evidence.styleAudio.music.status,'user-off');
  const legacyQuiet=structuredClone(generic);delete legacyQuiet.settings.musicSelection;delete legacyQuiet.settings.musicAssetId;
  assert.equal((await check(legacyQuiet,dry)).evidence.styleAudio.music.status,'unverified');

  const absent=structuredClone(p);absent.timeline.clips[2].role='sfx';
  result=await check(absent,dry);
  assert.equal(result.status,'repair');assert.equal(result.evidence.styleAudio.music.status,'missing');
  const duplicate=structuredClone(p);duplicate.assets[2]={...duplicate.assets[2],path:voice,sha256:voiceHash,
    source:{...duplicate.assets[2].source,styleResourceHash:voiceHash}};
  result=await check(duplicate,dry);assert.equal(result.evidence.styleAudio.music.mixStatus,'unverified');
  const alternative=structuredClone(p);alternative.styleAudio.music={assetId:'m',sha256:bedHash,status:'alternative',sourceLUFS:-17,voiceLUFS:-18};
  alternative.assets[2].source={title:'Another instrumental',license:'CC0',credit:'Test composition'};
  result=await check(alternative);assert.equal(result.evidence.styleAudio.music.sources[0].identity,'licensed-alternative');
  assert.equal(result.evidence.styleAudio.music.status,'verified');
  const original=structuredClone(generic);original.settings.voiceMode='original';original.timeline.clips=[{id:'original-source',track:'video',assetId:'n',start:0,duration:frames}];
  original.assets[1].kind='video';original.assets[1].hasAudio=true;
  assert.equal((await check(original,dry)).evidence.styleAudio.voice.status,'user-selected');
  const wrongReference=structuredClone(p);
  await writeFile(ref,'reference changed');
  assert.equal((await check(wrongReference)).evidence.styleAudio.voice.status,'unverified');
  result=await check(p,dry,basic);assert.equal(result.evidence.styleAudio,undefined);
});
