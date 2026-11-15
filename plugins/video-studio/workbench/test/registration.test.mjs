import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {initialStudio,inputHash} from '../studio-workflow.mjs';
import {requestHash} from '../automatic.mjs';
import {bindCandidate,bindReusedCandidate,equivalentReusePlan,registerIndependentReview,enforceIndependentReview,producerConcerns} from '../quality.mjs';
import {saveRegistrationResult,loadRegistrationResult,pendingRegistration,pendingEvidence,currentCandidate} from '../evidence-resume.mjs';
import {fileHash} from '../media.mjs';

async function fixture(){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'registration-'))),run=path.join(root,'run'),directory=path.join(root,'job');
  await mkdir(run);await mkdir(directory);
  const p={...initialStudio(),run,topic:'evidence regression',plan:{title:'unchanged production',notes:['narration before fade'],planHash:'old',stale:false}};
  const hash=inputHash(p);p.approval={planHash:'old',inputHash:hash};
  const producer={id:'original',threadId:'original-thread',planHash:'old',inputHash:hash,toolCalls:[{server:'chatcut',tool:'track_export',status:'completed'}]};
  const record={revision:1,project:{projectId:'project',timelineId:'timeline',planHash:'old',inputHash:hash}};
  const recordFile=path.join(run,'run.json');await writeFile(recordFile,JSON.stringify(record));
  const result={status:'exported',projectId:'project',timelineId:'timeline',files:[]};
  for(const role of ['video','subtitles','cover_portrait','cover_landscape','copy']){
    const file=path.join(run,role+(role==='video'?'.mp4':'.bin'));await writeFile(file,'synthetic '+role);result.files.push({role,path:file});
  }
  result.files.push({role:'project',path:recordFile});
  const prior=await bindCandidate(result,run,producer);
  const previousPlan=structuredClone(p.plan);p.plan={...p.plan,planHash:'new',version:2};p.approval.planHash='new';
  record.project.planHash='new';await writeFile(recordFile,JSON.stringify(record));
  const job={id:'registrar',threadId:'registrar-thread',directory,action:'create',status:'failed',planHash:'new',inputHash:hash,requestHash:requestHash(p),toolCalls:[]};
  p.jobs=[job,producer];
  const args={result,run,job,prior,producer,previousPlan,currentPlan:p.plan};
  return {root,run,p,job,args,result,recordFile,producer};
}

test('a failed-quality revision can reuse exact original export with no new export call',async()=>{
  const f=await fixture();try{
    const candidate=await bindReusedCandidate(f.args);
    assert.equal(candidate.producerJobId,'original');assert.equal(candidate.registeredByJobId,'registrar');
    assert.equal(candidate.planHash,'new');assert.equal(candidate.exportOrigin.planHash,'old');
    assert.deepEqual(candidate.files.slice(0,5).map(f=>f.sha256),f.args.prior.files.slice(0,5).map(f=>f.sha256));
    assert.notEqual(candidate.files[5].path,f.args.prior.files[5].path);
    f.job.status='needs_input';f.job.pendingExport=candidate;
    assert.equal(pendingEvidence(f.p).id,f.job.id);assert.equal(currentCandidate(f.p).producerJobId,'original');
    const resumed=await bindReusedCandidate({...f.args,prior:candidate,job:{...f.job,id:'next',threadId:'next-thread'},evidenceOnly:true});
    assert.equal(resumed.exportOrigin.planHash,'old');assert.equal(resumed.files[5].path,candidate.files[5].path);
    for(const threadId of ['original-thread','registrar-thread'])await assert.rejects(registerIndependentReview({candidate,job:{id:'review',threadId},run:f.run,result:{checks:[]}}),/独立/);
    await assert.rejects(enforceIndependentReview({completed:true,independentJobId:'review',independentThreadId:'registrar-thread'},f.run,candidate),/独立/);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('reuse cannot accept changed media, missing export provenance, identities, attachments or substantive plans',async()=>{
  const f=await fixture();try{
    for(const args of [
      {...f.args,producer:{...f.producer,toolCalls:[]}},
      {...f.args,job:{...f.job,inputHash:'changed'}},
      {...f.args,result:{...f.result,timelineId:'other'}},
      {...f.args,currentPlan:{...f.p.plan,title:'new script'}},
      {...f.args,currentPlan:{...f.p.plan,notes:['change ending']}},
      {...f.args,result:{...f.result,files:f.result.files.filter(f=>f.role!=='copy')}},
      {...f.args,result:{...f.result,files:[...f.result.files,f.result.files[0]]}},
    ])await assert.rejects(bindReusedCandidate(args));
    await writeFile(f.result.files[0].path,'changed video');await assert.rejects(bindReusedCandidate(f.args),/变化/);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('notes exception covers only the exact host-reviewed amendment, not new production instructions',()=>{
  const previous={planHash:'a',title:'t',notes:['render rule']},current={...previous,planHash:'b',notes:[...previous.notes,'diagnostic only']};
  const approval={kind:'evidence_notes_only',fromPlanHash:'a',toPlanHash:'b',before:previous.notes,after:current.notes};
  assert.equal(equivalentReusePlan(previous,current),false);assert.equal(equivalentReusePlan(previous,current,approval),true);
  for(const change of [{notes:[...current.notes,'speed up']},{title:'other'},{planHash:'c'}])assert.equal(equivalentReusePlan(previous,{...current,...change},approval),false);
});

test('registration checkpoint survives restart, omits tokens, validates all scopes and cannot be overwritten',async()=>{
  const f=await fixture();try{
    await saveRegistrationResult(f.p,f.job,{run:f.run,voice:{savedVoice:{voiceId:'same'},token:'do-not-store',answers:[]}},f.result);
    const restored=JSON.parse(JSON.stringify(f.p)),job=restored.jobs[0];
    assert.equal(pendingRegistration(restored,requestHash(restored)).id,job.id);
    assert.deepEqual((await loadRegistrationResult(restored,job,requestHash(restored))).result,f.result);
    assert.doesNotMatch(await readFile(job.pendingRegistration.contextFile,'utf8'),/do-not-store|token/);
    const sha=job.pendingRegistration.resultSha256;
    await saveRegistrationResult(restored,job,{}, {status:'forged'});assert.equal(job.pendingRegistration.resultSha256,sha);
    const original=await readFile(f.result.files[0].path);await writeFile(f.result.files[0].path,'changed during host outage');
    await assert.rejects(loadRegistrationResult(restored,job,requestHash(restored)),/成品文件已变化/);
    await writeFile(f.result.files[0].path,original);
    for(const edit of [p=>p.topic='new',p=>p.plan.stale=true,p=>p.approval.planHash='other',p=>p.jobs[0].threadId='other']){
      const changed=structuredClone(restored);edit(changed);assert.equal(pendingRegistration(changed,requestHash(changed)),null);
      await assert.rejects(loadRegistrationResult(changed,changed.jobs[0],requestHash(changed)),/不一致/);
    }
    await writeFile(job.pendingRegistration.resultFile,'{}');await assert.rejects(loadRegistrationResult(restored,job,requestHash(restored)),/变化/);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('automatic resume consumes a saved result locally before voice lookup or any model dispatch',async()=>{
  const f=await fixture();try{
    await saveRegistrationResult(f.p,f.job,{run:f.run},f.result);
    const source=await readFile(new URL('../studio-server.mjs',import.meta.url),'utf8');
    const automatic=source.slice(source.indexOf('async function startAutomatic('),source.indexOf('async function selectExistingVoice('));
    const resume=source.slice(source.indexOf('async function resumeRegistration('),source.indexOf('async function prepareJob('));
    let called=0;const sandbox={project:f.p,requestHash,pendingRegistration,loadRegistrationResult,cancelGeneration:0,assertReady:()=>{},addEvent:()=>{},active:null,
      finishJob:async(job,context,outcome)=>{called++;assert.equal(job.id,f.job.id);assert.equal(JSON.parse(outcome.finalText).status,'exported');job.pendingRegistration.completed=true;}};
    vm.createContext(sandbox);vm.runInContext(resume+automatic,sandbox);
    sandbox.startJob=()=>vm.runInContext('resumeRegistration(project.jobs[0])',sandbox);
    await vm.runInContext('startAutomatic()',sandbox);assert.equal(called,1);assert.equal(f.p.jobs.length,2);assert.equal(f.job.registrationAttempts,1);
    assert.equal(pendingRegistration(f.p,requestHash(f.p)),null);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('producer concerns need current independent dispositions with cited evidence, including audit recovery',async()=>{
  const f=await fixture();try{
    const candidate={...await bindReusedCandidate(f.args),qaStatus:'failed',summary:'old detector suspicion',unresolvedIssues:['possible missing word']};
    const job={id:'review',threadId:'independent',directory:f.root},manifest=path.join(f.run,'manifest.json');await writeFile(manifest,'{}');
    const probe={manifest,revision:1,frames:30,artifact_sha256:candidate.files[0].sha256};
    const bridge=async(command,p)=>{
      if(command==='record-review'){const record=JSON.parse(await readFile(f.recordFile));record.reviews={output_details:p.review};await writeFile(f.recordFile,JSON.stringify(record));return {};}
      const record=JSON.parse(await readFile(f.recordFile));return {completed:record.reviews.output_details.result==='pass',checks:{output_details:{status:record.reviews.output_details.result,method:'export_and_boundary_inspection'}}};
    };
    const result={checks:[{check:'output_details',result:'pass',observations:'actual observation',evidencePaths:[manifest]}]};
    assert.equal((await registerIndependentReview({result,job,candidate,probe,run:f.run,bridge})).completed,false);
    result.producerConcerns=producerConcerns(candidate).map(c=>({id:c.id,disposition:'resolved',observations:'verified against new metrics',evidencePaths:[manifest]}));
    const report=await registerIndependentReview({result,job,candidate,probe,run:f.run,bridge});assert.equal(report.completed,true);
    const record=JSON.parse(await readFile(f.recordFile));record.reviews.output_details.producer_concerns=[];await writeFile(f.recordFile,JSON.stringify(record));
    assert.equal((await enforceIndependentReview(report,f.run,candidate)).completed,false);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
