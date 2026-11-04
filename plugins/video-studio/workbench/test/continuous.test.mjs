import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {productionCheckpointReader,inspectPreparation} from '../continuous.mjs';
import {fileHash} from '../media.mjs';
import {brief,initialStudio} from '../studio-workflow.mjs';
import {voiceScope,pendingVoiceRequest} from '../voices.mjs';
import {currentVoiceRequest} from '../public/voice-ui.js';

async function fixture(){
  const run=await mkdtemp(path.join(os.tmpdir(),'continuous-'));
  const context={jobDirectory:run,productionCheckpointPath:path.join(run,'checkpoint.json'),productionCheckpointResultPath:path.join(run,'response.json')};
  return {run,context,job:{id:'current'},value:{schema:1,jobId:'current',requestId:'one'}};
}
test('one production session adopts each changed checkpoint once and receives real host hashes',async()=>{
  const f=await fixture();try{
    let count=0;const poll=productionCheckpointReader({...f,adopt:async()=>{count++;return {planHash:'actual-plan',inputHash:'actual-input'};}});
    await poll();await writeFile(f.context.productionCheckpointPath,'{"schema":');await poll();assert.equal(count,0);
    await writeFile(f.context.productionCheckpointPath,JSON.stringify(f.value));await Promise.all([poll(),poll(),poll()]);
    assert.equal(count,1);assert.deepEqual(JSON.parse(await readFile(f.context.productionCheckpointResultPath,'utf8')),{...f.value,ok:true,planHash:'actual-plan',inputHash:'actual-input'});
    await writeFile(f.context.productionCheckpointPath,JSON.stringify({...f.value,requestId:'two'}));await poll();assert.equal(count,2);
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('a local validation error returns to the same session without another search or silent approval',async()=>{
  const f=await fixture();try{
    const poll=productionCheckpointReader({...f,adopt:async()=>{throw Error('source window outside actual file');}});
    await writeFile(f.context.productionCheckpointPath,JSON.stringify(f.value));await poll();
    const response=JSON.parse(await readFile(f.context.productionCheckpointResultPath,'utf8'));assert.equal(response.ok,false);assert.match(response.error,/source window/);assert.equal(response.planHash,undefined);
    await writeFile(f.context.productionCheckpointPath,JSON.stringify({...f.value,jobId:'old'}));await poll();
    const invalid=JSON.parse(await readFile(f.context.productionCheckpointResultPath,'utf8'));assert.equal(invalid.ok,false);assert.equal(invalid.jobId,'current');assert.match(invalid.error,/当前任务/);
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('retrying receipt persistence does not save or approve the same plan twice',async()=>{
  const f=await fixture();try{
    let count=0;const poll=productionCheckpointReader({...f,adopt:async()=>{count++;return {planHash:'same-plan'};}});
    await writeFile(f.context.productionCheckpointPath,JSON.stringify(f.value));
    await mkdir(f.context.productionCheckpointResultPath);
    await assert.rejects(poll);assert.equal(count,1);
    await rm(f.context.productionCheckpointResultPath,{recursive:true});await poll();
    assert.equal(count,1);assert.equal(JSON.parse(await readFile(f.context.productionCheckpointResultPath,'utf8')).planHash,'same-plan');
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('cancellation during adoption never emits a success receipt',async()=>{
  const f=await fixture();try{
    let release;const adopted=new Promise(r=>release=r);let started;const ready=new Promise(r=>started=r);
    const poll=productionCheckpointReader({...f,adopt:async()=>{started();await adopted;return {planHash:'late'};}});
    await writeFile(f.context.productionCheckpointPath,JSON.stringify(f.value));const waiting=poll();await ready;f.job.cancelRequested=true;release();await waiting;
    await assert.rejects(readFile(f.context.productionCheckpointResultPath),{code:'ENOENT'});
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('preparation verifies actual bytes, source offsets, uniqueness, run containment and budget',async()=>{
  const f=await fixture();try{
    const file=path.join(f.run,'source.mp4');await writeFile(file,'fixture bytes');const sha256=await fileHash(file);
    const source={id:'s1',title:'actual',localPath:file,sha256,start:12};
    const value={sources:[source],editorial:{title:'one story',rationale:'visible action',music:'none',captions:false},plan:{gaps:[]}};
    const req={max_video_sources:2,max_download_seconds:20},inspect=async()=>({sha256,bytes:13,hasVideo:true,duration:3,width:100,height:200});
    const accepted=await inspectPreparation(value,f.run,req,inspect);assert.equal(accepted[0].start,12);assert.equal(accepted[0].end,15);assert.equal(accepted[0].kind,'video');
    await assert.rejects(inspectPreparation({...value,sources:[source,source]},f.run,req,inspect),/编号/);
    await assert.rejects(inspectPreparation({...value,sources:[{...source,sha256:'wrong'}]},f.run,req,inspect),/哈希/);
    await assert.rejects(inspectPreparation(value,f.run,{...req,max_download_seconds:2},inspect),/预算/);
    await assert.rejects(inspectPreparation({...value,plan:{gaps:['missing fact']}},f.run,req,inspect),/missing fact/);
    const outside=path.join(os.tmpdir(),'outside-'+path.basename(f.run));await writeFile(outside,'outside');
    try{const link=path.join(f.run,'link.mp4');await symlink(outside,link);await assert.rejects(inspectPreparation({...value,sources:[{...source,localPath:link}]},f.run,req,inspect));}finally{await rm(outside,{force:true});}
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('selected stable voice is part of the real run brief, not only a UI preference',()=>{
  const voice={provider:'provider',voiceId:'chosen',name:'Chosen',voiceType:'custom',selected_by_user:true};
  const p={...initialStudio(),voiceChoice:voice};assert.deepEqual(brief(p).requirements.voice,voice);
});
test('a real voice problem before a continuous checkpoint has a usable recovery form',()=>{
  const p={...initialStudio(),narration:true,approval:null};
  const request={id:'voice-input',voiceScope:voiceScope(p),planHash:null,inputHash:'before-plan'};
  p.jobs=[{action:'create',status:'needs_input',voiceIntent:'saved',voiceSelectionId:null,voiceRequest:request}];
  assert.equal(pendingVoiceRequest(p,'changed-sources'),request);assert.equal(currentVoiceRequest(p),request);
  p.voiceIntent='official';assert.equal(pendingVoiceRequest(p,'changed-sources'),null);assert.equal(currentVoiceRequest(p),null);
});
