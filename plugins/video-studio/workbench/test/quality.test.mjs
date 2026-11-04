import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileHash} from '../media.mjs';
import {bindCandidate,verifyCandidate,registerIndependentReview,reviewDeliveryPackage,validateDeliveryFiles,enforceIndependentReview,assertCanProduce} from '../quality.mjs';

async function fixture(){
  const run=await mkdtemp(path.join(os.tmpdir(),'oneclick-quality-')),file=path.join(run,'final.mp4'),manifest=path.join(run,'manifest.json');
  await writeFile(file,'Synthetic protocol bytes; not a valid rendered video');await writeFile(manifest,'{}');
  await writeFile(path.join(run,'run.json'),JSON.stringify({revision:7,project:{projectId:'project',timelineId:'timeline',planHash:'plan',inputHash:'inputs'}}));
  const producer={id:'producer',threadId:'producer-thread',inputHash:'inputs',planHash:'plan',toolCalls:[{server:'chatcut',tool:'track_export',status:'completed'}]};
  const result={status:'exported',projectId:'project',timelineId:'timeline',files:[{path:file,role:'video'}]};
  const candidate=await bindCandidate(result,run,producer),probe={artifact_sha256:await fileHash(file),subtitle_sha256:null,frames:90,revision:7,manifest};
  return {run,file,manifest,producer,result,candidate,probe};
}
test('claimed export without actual recorded project/tool evidence cannot become a candidate',async()=>{
  const f=await fixture();try{await assert.rejects(()=>bindCandidate(f.result,f.run,{...f.producer,toolCalls:[]}),/真实/);await assert.rejects(()=>bindCandidate({...f.result,projectId:'invented'},f.run,f.producer),/不一致/);}finally{await rm(f.run,{recursive:true,force:true});}
});
test('candidate mutation and producer self-review are rejected',async()=>{
  const f=await fixture();try{
    await assert.rejects(()=>registerIndependentReview({...f,result:{checks:[]},job:{id:'different',threadId:'producer-thread'}}),/独立/);
    await writeFile(f.file,'changed');await assert.rejects(()=>verifyCandidate(f.candidate,f.run),/变化/);
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('matching project IDs cannot reuse an export under a different plan or input',async()=>{
  const f=await fixture();try{
    for(const change of [{planHash:'new-plan'},{inputHash:'new-inputs'},{planHash:null}]){
      await assert.rejects(()=>bindCandidate(f.result,f.run,{...f.producer,...change}),/当前制作方案与输入/);
    }
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('objective gate rejection is recorded as failure without approving the failed export',async()=>{
  const f=await fixture();try{
    const evidence={path:f.manifest,sha256:await fileHash(f.manifest)},saved=[];
    const result={checks:[{check:'audio_listening',result:'pass',observations:'model claim',evidenceFiles:[evidence],observedSheets:[],rules:[],issues:[]}],limitations:['No listening']};
    const report=await registerIndependentReview({...f,result,job:{id:'review',threadId:'review-thread',directory:f.run},bridge:async(action,p)=>{
      if(action==='record-review'){if(p.review.result==='pass')throw Error('Sampled review evidence invalid: silent_audio');saved.push(p.review);return {};}
      return {completed:false,review_pending:['audio_listening'],artifact_sha256:f.probe.artifact_sha256};
    }});
    assert.equal(report.completed,false);assert.equal(saved[0].result,'fail');assert.equal(saved[0].reviewer,'review-thread');assert.match(saved[0].observations,/silent_audio/);
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('legacy method is supplied by the actual run context, not silently upgraded',async()=>{
  const f=await fixture();try{
    const saved=[];await registerIndependentReview({...f,result:{checks:[{check:'visuals',result:'pass',observations:'Sampled frames',evidenceFiles:[]},{check:'audio_listening',result:'pass',observations:'Objective metrics',evidenceFiles:[]}]},job:{id:'review',threadId:'review-thread',directory:f.run},methods:{visuals:'continuous_playback',audio_listening:'full_mix_listening'},bridge:async(action,p)=>{if(action==='record-review')saved.push(p.review);return {completed:false};}});
    assert.equal(saved[0].method,'continuous_playback');assert.equal(saved[1].method,'full_mix_listening');
    assert.ok(saved.every(r=>r.result==='unverified'&&r.observations.includes('未完成该方法')));
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('style approval needs real benchmark comparison, not a rule checklist alone',async()=>{
  const f=await fixture();try{
    const sheet=path.join(f.run,'reference.jpg'),reference=path.join(f.run,'reference.json');
    await writeFile(sheet,'fixture reference pixels');await writeFile(reference,'{"fixture":true}');
    const referenceProbe={manifest:reference,sha256:await fileHash(reference),frames:90,contact_sheets:[{id:'ref-sheet',path:sheet,sha256:await fileHash(sheet)}]};
    const saved=[];const check={check:'style_match',result:'pass',observations:'Rules claimed satisfied',evidenceFiles:[],observedSheets:[],rules:[]};
    const run=async value=>registerIndependentReview({...f,referenceProbe,result:{checks:[value]},job:{id:'review',threadId:'review-thread',directory:f.run},bridge:async(action,p)=>{if(action==='record-review')saved.push(p.review);return {completed:false};}});
    await run(check);assert.equal(saved.at(-1).result,'fail');assert.match(saved.at(-1).observations,/试片实际画面/);
    const complete={...check,evidenceFiles:[{path:reference,sha256:referenceProbe.sha256}],observedReferenceSheets:['ref-sheet'],referenceComparisons:['opening','development','ending'].map((section,i)=>({section,candidateFrame:i*30,referenceFrame:i*30,observations:'Specific frame comparison'}))};
    await run(complete);assert.equal(saved.at(-1).result,'pass');assert.equal(saved.at(-1).reference_probe_sha256,referenceProbe.sha256);
    await run({...complete,referenceComparisons:complete.referenceComparisons.map(c=>({...c,candidateFrame:99}))});assert.equal(saved.at(-1).result,'fail');
    await writeFile(sheet,'changed');await assert.rejects(()=>run(complete),/参考抽帧已变化/);
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('video bytes renamed as a cover never pass the static PNG gate',async()=>{
  const f=await fixture();try{
    const cover=path.join(f.run,'pretend.png');await writeFile(cover,'not png');f.candidate.files.push({role:'cover_portrait',path:cover,sha256:await fileHash(cover)});
    await assert.rejects(()=>validateDeliveryFiles(f.candidate,f.run,async()=>({width:300,height:400})),/静态 PNG/);
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('delivery validation gathers every missing artifact into a repairable failed report',async()=>{
  const f=await fixture();try{
    const report=await reviewDeliveryPackage({completed:true,checks:{visuals:{status:'pass'}},failures:[]},f.candidate,f.run,async()=>{throw Error('No cover should be probed');});
    assert.equal(report.completed,false);assert.deepEqual(report.failures,['invalid_delivery_package']);
    assert.equal(report.checks.visuals.status,'pass');assert.equal(report.checks.delivery_package.status,'fail');
    assert.equal(report.checks.delivery_package.issues.length,3);
    assert.match(report.checks.delivery_package.observations,/cover_portrait.*cover_landscape.*TXT/);
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('delivery validation reports invalid covers and copy without consuming technical errors',async()=>{
  const f=await fixture();try{
    for(const [name,role,contents] of [['portrait.png','cover_portrait',Buffer.from([137,80,78,71,13,10,26,10])],['landscape.png','cover_landscape','not a png'],['copy.txt','copy','正文：缺少标题和话题']]){
      const file=path.join(f.run,name);await writeFile(file,contents);f.candidate.files.push({path:file,role,sha256:await fileHash(file)});
    }
    const report=await reviewDeliveryPackage({completed:true},f.candidate,f.run,async()=>({width:100,height:100}));
    assert.equal(report.completed,false);assert.equal(report.checks.delivery_package.issues.length,3);
    assert.match(report.checks.delivery_package.observations,/比例错误.*静态 PNG.*标题/);
    await assert.rejects(()=>reviewDeliveryPackage({completed:true},f.candidate,f.run,async()=>{throw Error('probe temporarily unavailable');}),/temporarily unavailable/);
    await writeFile(f.file,'changed candidate');
    await assert.rejects(()=>reviewDeliveryPackage({completed:true},f.candidate,f.run,async()=>({})),/变化/);
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('omitted checks cannot inherit an older or producer-authored pass',async()=>{
  const f=await fixture();try{
    const provenance={independentJobId:'review-now',independentThreadId:'thread-now',producerJobId:'producer'};
    const report={...provenance,completed:true,checks:{visuals:{method:'sampled_composited_frames',status:'pass'},facts:{status:'not_applicable'}}};
    await writeFile(path.join(f.run,'run.json'),JSON.stringify({reviews:{visuals:{reviewer_job_id:'review-old',reviewer:'thread-old',producer_job_id:'producer'}}}));
    const rejected=await enforceIndependentReview(report,f.run);assert.equal(rejected.completed,false);assert.deepEqual(rejected.review_pending,['visuals']);
    await writeFile(path.join(f.run,'run.json'),JSON.stringify({reviews:{visuals:{reviewer_job_id:'review-now',reviewer:'thread-now',producer_job_id:'producer'}}}));
    assert.equal((await enforceIndependentReview(report,f.run)).completed,true);
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('completed repair cannot be repeated even if its new review is cancelled or fails technically',()=>{
  const cycle={candidate:{planHash:'plan',inputHash:'inputs'},repairCount:1,report:{completed:false}};
  assert.doesNotThrow(()=>assertCanProduce(cycle,'plan','inputs')); // First repair may start or resume.
  cycle.repairCompleted=true;cycle.report=null;
  assert.throws(()=>assertCanProduce(cycle,'plan','inputs'),/不能再次返工/);
  cycle.report={completed:false};assert.throws(()=>assertCanProduce(cycle,'plan','inputs'),/不能再次返工/);
  assert.doesNotThrow(()=>assertCanProduce(cycle,'new-plan','inputs'));
  assert.doesNotThrow(()=>assertCanProduce(cycle,'plan','new-inputs'));
});

test('compact report binds explicit shared coverage and issue IDs, rejecting dropped or unknown issues',async()=>{
  const f=await fixture();try{
    const saved=[],result={observedSheets:['sheet-1','sheet-2'],issues:[{id:'v1',check:'visuals',symptom:'Cropped action'}],checks:[{check:'visuals',result:'fail',observations:'Actual frame observation',issueIds:['v1'],evidencePaths:[f.manifest]}]};
    const args={...f,result,job:{id:'review',threadId:'review-thread',directory:f.run},bridge:async(action,p)=>{if(action==='record-review')saved.push(p.review);return {completed:false};}};
    await registerIndependentReview(args);assert.deepEqual(saved[0].observed_sheets,result.observedSheets);assert.equal(saved[0].issues.length,1);assert.equal(saved[0].evidence_files[0].sha256,await fileHash(f.manifest));
    await assert.rejects(()=>registerIndependentReview({...args,result:{...result,issues:[{id:'bad',check:'missing'}]}}),/所属检查/);
    await assert.rejects(()=>registerIndependentReview({...args,result:{...result,issues:[]}}),/不存在的问题/);
  }finally{await rm(f.run,{recursive:true,force:true});}
});
