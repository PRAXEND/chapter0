import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {Readable} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {normalizeVoiceRequest,voiceAnswer,recordVoiceAnswer,pendingVoiceRequest,requireVoiceRequest,voiceContext,saveVoiceRecording,consentText} from '../voices.mjs';
import {renderVoiceRequest,currentVoiceRequest} from '../public/voice-ui.js';

const candidate={key:'choice',name:'试听样例',summary:'测试候选',sampleUrl:'https://93.184.215.14/test-only.mp3',provider:'internal-test',voiceId:'real-catalog-key-fixture',voiceType:'official'};
const job={action:'produce',status:'needs_input',inputHash:'inputs',planHash:'plan'};
const project=r=>({narration:true,jobs:[{...job,voiceRequest:r}],approval:{inputHash:'inputs',planHash:'plan'}});
test('voice choice accepts only an actual offered tuple and does not preselect or expose internal identity',async()=>{
  const r=await normalizeVoiceRequest({kind:'voice_choice',message:'请选择',candidates:[candidate]},job);
  const answer=voiceAnswer(r,{action:'select',key:'choice'});
  assert.equal(answer.voice.voiceId,candidate.voiceId);assert.equal(answer.voice.provider,candidate.provider);assert.equal(answer.voice.selected_by_user,true);
  assert.throws(()=>voiceAnswer(r,{action:'select',key:'guessed'}));
  const html=renderVoiceRequest(r);assert.ok(html.includes('<audio controls'));assert.ok(!html.includes('autoplay'));assert.ok(!html.includes(candidate.provider));assert.ok(!html.includes(candidate.voiceId));
  await assert.rejects(()=>normalizeVoiceRequest({kind:'voice_choice',candidates:[{...candidate,sampleUrl:'http://127.0.0.1/private'}]},job));
  await assert.rejects(()=>normalizeVoiceRequest({kind:'voice_choice',candidates:[candidate,candidate]},job));
  await assert.rejects(()=>normalizeVoiceRequest({kind:'voice_choice',candidates:[]},job));
});
test('clone request needs explicit consent, full intake and exact request; source choice alone is insufficient',async()=>{
  const r=await normalizeVoiceRequest({kind:'clone_choice',candidates:[]},job);
  assert.deepEqual(voiceAnswer(r,{action:'clone'}),{action:'clone'});
  assert.throws(()=>voiceAnswer(r,{action:'recording',name:'我的声音',consent:true}));
  const intake=await normalizeVoiceRequest({kind:'clone_recording',candidates:[]},job);
  for(const consent of [false,undefined,'true'])assert.throws(()=>voiceAnswer(intake,{action:'recording',name:'我的声音',consent}));
  assert.throws(()=>voiceAnswer(intake,{action:'recording',name:'',consent:true}));
  assert.throws(()=>voiceAnswer(intake,{action:'recording',name:'声音',consent:true,previewText:'好'.repeat(101)}));
  const answer=voiceAnswer(intake,{action:'recording',name:'声音',consent:true,previewText:'🙂'.repeat(100)});
  assert.equal(answer.consentText,consentText);assert.equal([...answer.previewText].length,100);
  const html=renderVoiceRequest(intake);assert.ok(html.includes(consentText));assert.ok(!html.includes('checked'));assert.ok(html.includes('type="file"'));
  assert.deepEqual(voiceAnswer(intake,{action:'official'}),{action:'official'});
});
test('answers persist across JSON reload and cannot be replayed for another plan, project or narration-off mode',async()=>{
  const r=await normalizeVoiceRequest({kind:'clone_choice'},job),p=project(r);
  assert.equal(currentVoiceRequest(p).id,pendingVoiceRequest(p,'inputs').id);
  assert.throws(()=>requireVoiceRequest(p,'changed',r.id));assert.throws(()=>requireVoiceRequest(p,'inputs','other'));
  recordVoiceAnswer(p,r,voiceAnswer(r,{action:'official'}));
  const restored=JSON.parse(JSON.stringify(p));assert.equal(pendingVoiceRequest(restored,'inputs'),null);
  assert.throws(()=>requireVoiceRequest(restored,'inputs',r.id));
  const savedVoice={name:'已确认音色',provider:'fixture',voiceId:'saved',selected_by_user:true};
  assert.deepEqual(voiceContext(restored,'inputs',savedVoice),{savedVoice,answers:restored.voiceAnswers});
  assert.deepEqual(voiceContext(restored,'new-input').answers,[]);
  restored.approval.planHash='new-plan';assert.deepEqual(voiceContext(restored,'inputs').answers,[]);
  const off={...project(r),narration:false};assert.equal(pendingVoiceRequest(off,'inputs'),null);assert.equal(currentVoiceRequest(off),null);
  assert.equal(await normalizeVoiceRequest(undefined,job),null);
});
test('invalid sample duration/type is rejected and removed; voice recording has its own directory',async()=>{
  const run=await mkdtemp(path.join(os.tmpdir(),'voice-sample-test-'));
  try{
    for(const info of [{hasAudio:false,duration:30},{hasAudio:true,duration:9.9},{hasAudio:true,duration:180.1},{hasAudio:true,duration:NaN}]){
      await assert.rejects(()=>saveVoiceRecording(Readable.from('fixture'),{run,name:'sample.wav',inspect:async()=>info}));
      assert.deepEqual(await readdir(path.join(run,'voice-references')),[]);
    }
    await assert.rejects(()=>saveVoiceRecording(Readable.from('fixture'),{run,name:'sample.exe',inspect:async()=>({})}));
    const r=await saveVoiceRecording(Readable.from('fixture'),{run,name:'sample.flac',inspect:async()=>({hasAudio:true,duration:30,sha256:'test',bytes:7})});
    assert.equal(path.dirname(r.path),path.join(run,'voice-references'));assert.equal(r.duration,30);
    assert.deepEqual(await readdir(run),['voice-references']);
  }finally{await rm(run,{recursive:true,force:true});}
});
