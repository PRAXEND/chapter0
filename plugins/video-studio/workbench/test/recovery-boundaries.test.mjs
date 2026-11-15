import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {initialStudio,inputHash} from '../studio-workflow.mjs';
import {requestHash,beginAutomatic,nextAutomatic,advanceAutomatic} from '../automatic.mjs';
import {pendingEvidence,currentCandidate,pendingRegistration} from '../evidence-resume.mjs';
import {revisionFeedback,saveWorkflowError,clearWorkflowError,currentWorkflowError} from '../revisions.mjs';

const source=await readFile(new URL('../studio-server.mjs',import.meta.url),'utf8');
const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const recovery=section('function transientFailure(','async function saveProvisional(');
const saveProvisional=section('async function saveProvisional(','async function resumeDelivery(');
const finish=section('async function finishJob(','async function continuePipeline(');
const pipeline=section('async function continuePipeline(','async function startAutomatic(');
const automatic=section('async function startAutomatic(','async function selectExistingVoice(');
function fixture(action='create',mode='automatic'){
  const p={...initialStudio(),mode,topic:'recovery test',styleSelector:'sample@1',run:'/test-run',narration:false,plan:{stale:false}};
  const hash=inputHash(p);p.approval={planHash:'plan',inputHash:hash};
  if(mode==='automatic')p.automatic={id:'cycle',status:'running',stage:action,requestHash:requestHash(p)};
  const job={id:action==='review'?'review':'producer',directory:'/test-job',action,inputHash:hash,planHash:'plan',requestHash:requestHash(p),status:'running',automaticId:p.automatic?.id||null,events:[],toolCalls:[]};
  p.jobs=[job];
  const candidate={projectId:'remote-project',timelineId:'timeline',producerJobId:'producer',producerThreadId:'producer-thread',planHash:'plan',inputHash:hash,files:[{role:'video',path:'/test-run/final.mp4',sha256:'original'}]};
  if(action==='review')p.qualityCycle={candidate,report:null};
  const saves=[],queued=[],started=[];
  const sandbox={project:p,job,context:{productionContext:{review_methods:{}}},outcome:{code:0,finalText:'{}'},active:{job},mutation:false,path,cleanEditor:()=>'',runtime:{},cancelGeneration:0,setTimeout:fn=>fn(),
    persist:async()=>{saves.push(structuredClone(p));},cleanError:String,saveWorkflowError,clearWorkflowError,
    pendingEvidence,currentCandidate,pendingRegistration,revisionFeedback,currentRevision:()=>null,inputHash,requestHash,beginAutomatic,nextAutomatic,advanceAutomatic,
    normalizeVoiceRequest:async()=>null,normalizeDownloadRequest:()=>null,bridge:async()=>({}),checkSelected:async()=>{},
    hasExportRecord:()=>true,verifyRegistrationArtifacts:async()=>{},saveRegistrationResult:async(p,j)=>{j.pendingRegistration??={resultSha256:"protocol-result",completed:false};},
    bindCandidate:async()=>structuredClone(candidate),provisionalPackage:async()=>{throw Error('archive unavailable');},
    reviewDeliveryPackage:async r=>r,registerIndependentReview:async()=>({completed:false,checks:{visuals:{status:'fail',observations:'actual defect'}}}),
    writeFile:async()=>{},addEvent:()=>{},refreshLibrary:async()=>{},library:{},
    setImmediate:fn=>queued.push(fn),queueMicrotask:fn=>queued.push(fn),exclusive:async fn=>fn(),startJob:async action=>started.push({action,projectId:sandbox.project.id})};
  vm.createContext(sandbox);vm.runInContext(recovery+saveProvisional+finish+pipeline,sandbox);
  return {p,job,candidate,saves,queued,started,sandbox,finish:()=>vm.runInContext('finishJob(job,context,outcome)',sandbox)};
}

test('a provisional archive failure preserves evidence-only recovery before packaging',async()=>{
  const f=fixture();f.sandbox.outcome.finalText=JSON.stringify({status:'needs_input',summary:'补齐音乐原件',projectId:'remote-project',timelineId:'timeline',files:f.candidate.files,questions:['补齐音乐原件']});
  await f.finish();
  assert.ok(f.saves.some(p=>p.jobs[0].pendingExport&&p.jobs[0].status==='needs_input'));
  assert.equal(f.job.status,'needs_input');assert.equal(pendingEvidence(f.p).id,f.job.id);
  assert.equal(revisionFeedback(f.p).suggested,'');assert.match(currentWorkflowError(f.p,'provisional').message,/archive/);
  assert.deepEqual(f.p.approval,{planHash:'plan',inputHash:f.job.inputHash});
});

test('archive failure cannot undo a failed quality decision or enable ordinary regeneration',async()=>{
  const f=fixture('review');await f.finish();
  assert.ok(f.saves.some(p=>p.qualityCycle.terminal==='quality_failed'));
  assert.equal(f.p.qualityCycle.report.completed,false);assert.equal(f.p.qualityCycle.terminal,'quality_failed');
  assert.equal(f.p.automatic.status,'quality_failed');assert.equal(f.job.status,'quality_failed');
  assert.throws(()=>beginAutomatic(f.p),/验收未通过/);assert.match(revisionFeedback(f.p).packageError.message,/archive/);
});

test('the active owner remains locked through final writes, and queued continuation cannot switch projects',async()=>{
  const f=fixture('produce','manual');
  f.sandbox.outcome.finalText=JSON.stringify({status:'exported',summary:'done',projectId:'remote-project',timelineId:'timeline',files:f.candidate.files});
  const ownership=[];f.sandbox.writeFile=async file=>{if(file.endsWith('quality-cycle.json'))ownership.push(f.sandbox.active?.job.id);};
  await f.finish();assert.ok(ownership.length);assert.ok(ownership.every(id=>id===f.job.id));assert.equal(f.sandbox.active,null);
  assert.equal(f.queued.length,1);f.sandbox.project={...initialStudio(),id:'another-project'};
  f.queued[0]();await new Promise(r=>setImmediate(r));assert.equal(f.started.length,0);
});

test('manual production cancelled during its last successful persistence never queues an independent review',async()=>{
  const f=fixture('produce','manual');let writes=0;
  f.sandbox.outcome.finalText=JSON.stringify({status:'exported',summary:'done',projectId:'remote-project',timelineId:'timeline',files:f.candidate.files});
  f.sandbox.persist=async()=>{if(++writes===3){f.sandbox.cancelGeneration++;f.job.cancelRequested=true;f.job.status='cancelling';}};
  await f.finish();assert.equal(f.sandbox.active,null);assert.equal(f.queued.length,0);assert.equal(f.started.length,0);assert.equal(f.job.status,'cancelled');
  assert.ok(f.p.qualityCycle.candidate);assert.equal(f.p.qualityCycle.report,null);
});

test('a continuation queued before cancellation cannot start after the cancellation generation changes',async()=>{
  const f=fixture('produce','manual');
  f.sandbox.outcome.finalText=JSON.stringify({status:'exported',summary:'done',projectId:'remote-project',timelineId:'timeline',files:f.candidate.files});
  await f.finish();assert.equal(f.queued.length,1);f.sandbox.cancelGeneration++;
  f.queued[0]();await new Promise(r=>setImmediate(r));assert.equal(f.started.length,0);
});

test('local registration completes inside the HTTP lock then starts review after releasing it',async()=>{
  const f=fixture();f.sandbox.outcome.finalText=JSON.stringify({status:'exported',summary:'saved',projectId:'remote-project',timelineId:'timeline',files:f.candidate.files});
  f.sandbox.setImmediate=setImmediate;f.sandbox.active=null;
  // Use the actual lock and finish/continue functions; finish must not queue a
  // microtask that silently observes the still-held HTTP lock and returns.
  const lock=source.match(/async function exclusive\(fn\)\{[^\n]+/)[0];vm.runInContext(lock,f.sandbox);
  await vm.runInContext('exclusive(()=>{active={job};return finishJob(job,context,outcome);})',f.sandbox);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.sandbox.mutation,false);assert.equal(f.started.length,1);assert.equal(f.started[0].action,'review');
});

test('direct automatic preparation errors survive reload and never become creative suggestions',async()=>{
  const f=fixture('review');f.p.automatic.status='blocked';
  Object.assign(f.sandbox,{getCatalog:async()=>({}),voiceScope:()=>'',pendingVoiceRequest:()=>null,startJob:async()=>{throw Error('reference unavailable');},options:{}});
  // Extract only the automatic entry; no remote runner or tools are used.
  assert.ok(automatic.includes('saveWorkflowError'));
  vm.runInContext(automatic,f.sandbox);
  await assert.rejects(vm.runInContext('startAutomatic(options)',f.sandbox),/reference unavailable/);
  const restored=JSON.parse(JSON.stringify(f.p)),view=revisionFeedback(restored);
  assert.equal(restored.automatic.status,'blocked');assert.match(view.technicalBlocker.message,/reference unavailable/);assert.equal(view.suggested,'');
  restored.qualityCycle.candidate.producerJobId='new-producer';assert.equal(currentWorkflowError(restored,'preparation'),null);
});

test('a final state-write failure releases the owner but blocks continuation instead of leaving a permanent spinner',async()=>{
  const f=fixture();
  f.sandbox.outcome.finalText=JSON.stringify({status:'exported',summary:'done',projectId:'remote-project',timelineId:'timeline',files:f.candidate.files});
  f.sandbox.writeFile=async file=>{if(file.endsWith('quality-cycle.json'))throw Error('disk unavailable');};
  await f.finish();assert.equal(f.sandbox.active,null);assert.equal(f.p.automatic.status,'blocked');assert.equal(f.queued.length,0);
  assert.ok(f.p.qualityCycle.candidate);assert.match(revisionFeedback(f.p).technicalBlocker.message,/保存任务状态失败/);
});

test('manual already-approved review entry restores delivery without preparing another reviewer',async()=>{
  const f=fixture('review','manual');f.p.qualityCycle.report={completed:true};let resumed=0;
  const wrapper=section('async function startJob(','async function prepareJob(');
  const prepare=section('async function prepareJob(','function runReviewAgent(');
  Object.assign(f.sandbox,{cancelGeneration:0,assertReady:()=>{},resumeDelivery:async()=>{resumed++;return null;}});
  vm.runInContext(wrapper+prepare,f.sandbox);
  assert.equal(await vm.runInContext("startJob('review')",f.sandbox),null);assert.equal(resumed,1);
  assert.equal(f.p.jobs.length,1);
});

test('a successful provisional retry clears only its packaging error',async()=>{
  const f=fixture('review');saveWorkflowError(f.p,'provisional','provisional','archive unavailable');saveWorkflowError(f.p,'preparation','review','connection unavailable');
  f.sandbox.candidate=f.candidate;f.sandbox.provisionalPackage=async()=>({id:'saved'});
  await vm.runInContext('saveProvisional(candidate,null)',f.sandbox);
  assert.equal(currentWorkflowError(f.p,'provisional'),null);assert.ok(currentWorkflowError(f.p,'preparation'));
});

test('provisional retry and its error bind to new pending evidence, never a retained old quality cycle',async()=>{
  const f=fixture();f.job.status='needs_input';f.job.pendingExport=f.candidate;
  f.p.qualityCycle={candidate:{...f.candidate,producerJobId:'old-producer',inputHash:'old-input'},report:{completed:false}};
  saveWorkflowError(f.p,'provisional','provisional','archive unavailable');
  assert.equal(f.p.workflowErrors.provisional.producerJobId,f.job.id);
  const calls=[];f.sandbox.provisionalPackage=async(p,candidate,report)=>{calls.push({candidate,report});return {id:'saved'};};
  await vm.runInContext('retryProvisional()',f.sandbox);
  assert.equal(calls[0].candidate,f.candidate);assert.equal(calls[0].report,null);
  f.p.topic='different topic';
  assert.equal(currentWorkflowError(f.p,'provisional'),null);
  await assert.rejects(vm.runInContext('retryProvisional()',f.sandbox),/当前方案/);assert.equal(calls.length,1);
});

function queueFixture(){
  const f=fixture('produce','manual');f.p.jobs=[];f.sandbox.active=null;let starts=0,sequence=0;
  Object.assign(f.sandbox,{cancelGeneration:0,assertReady:()=>{},assertCanProduce:()=>{},runtime:{compatible:true},
    pendingVoiceRequest:()=>null,checkLocal:async()=>{},requireDependencies:()=>{},styleCapabilities:()=>[],desktopAction:()=>false,
    ensureRun:async()=>{},randomUUID:()=>`queued-${++sequence}`,taskNames:{produce:'produce'},dataDir:'/test-data',mkdir:async()=>{},
    plugin:{root:'/test-plugin'},brief:()=>({}),getCatalog:async()=>({}),readFile:async()=>'{}',voiceContext:()=>({answers:[]}),unlink:async()=>{},
    rememberUsage:()=>{},runAgent:()=>{starts++;return {cancel(){}};}});
  vm.runInContext(section('async function startJob(','function runReviewAgent('),f.sandbox);
  return {...f,starts:()=>starts,start:()=>vm.runInContext("startJob('produce')",f.sandbox)};
}

test('queue persistence failure releases the unsent job and permits a later retry without duplicate dispatch',async()=>{
  const f=queueFixture();let writes=0;
  f.sandbox.persist=async()=>{if(++writes===1)throw Error('queue disk failure');};
  await assert.rejects(f.start(),/queue disk failure/);
  assert.equal(f.sandbox.active,null);assert.equal(f.starts(),0);assert.equal(f.p.jobs[0].status,'failed');
  assert.match(revisionFeedback(f.p).technicalBlocker.message,/queue disk failure/);
  await f.start();assert.equal(f.starts(),1);assert.equal(f.sandbox.active.job.id,f.p.jobs[0].id);
  assert.equal(currentWorkflowError(f.p,'preparation'),null);
});

test('cancel during the last queue write stops dispatch and releases its owner',async()=>{
  const f=queueFixture();let writes=0;
  f.sandbox.persist=async()=>{if(++writes===1){f.sandbox.cancelGeneration++;f.sandbox.active.job.cancelRequested=true;f.sandbox.active.job.status='cancelling';}};
  await assert.rejects(f.start(),/已取消/);
  assert.equal(f.starts(),0);assert.equal(f.sandbox.active,null);assert.equal(f.p.jobs[0].status,'cancelled');
  assert.ok(f.p.jobs[0].completedAt);
});

test('temporary preflight and queue write errors recover within one click with exactly one runner',async()=>{
  const f=queueFixture();let checks=0,writes=0;
  f.sandbox.checkLocal=async()=>{if(++checks<3)throw Object.assign(Error('connection reset'),{code:'ECONNRESET'});};
  f.sandbox.persist=async()=>{if(++writes<3)throw Object.assign(Error('temporarily busy'),{code:'EBUSY'});};
  await f.start();assert.equal(checks,3);assert.equal(writes,3);assert.equal(f.starts(),1);assert.equal(f.p.jobs.length,1);
  assert.equal(f.sandbox.runtime.recovery,undefined);assert.equal(currentWorkflowError(f.p,'preparation'),null);
});

test('a runner that throws synchronously is never retried even for a temporary error code',async()=>{
  const f=queueFixture();let calls=0;f.sandbox.runAgent=()=>{calls++;throw Object.assign(Error('runner failed after dispatch'),{code:'ECONNRESET'});};
  await assert.rejects(f.start(),/after dispatch/);assert.equal(calls,1);assert.equal(f.sandbox.active,null);
});

test('temporary preflight exhaustion has one budget of three; permanent errors are not retried',async()=>{
  for(const code of ['ECONNRESET','ENOSPC','EACCES','candidate_changed']){
    const f=queueFixture();let calls=0;f.sandbox.checkLocal=async()=>{calls++;throw Object.assign(Error('preflight unavailable'),{code});};
    await assert.rejects(f.start(),/preflight unavailable/);assert.equal(calls,code==='ECONNRESET'?3:1);assert.equal(f.starts(),0);
  }
});

test('cancel or project switch during backoff stops all later operations and dispatch',async()=>{
  for(const mode of ['cancel','switch']){
    const f=queueFixture();let calls=0;
    f.sandbox.checkLocal=async()=>{calls++;throw Object.assign(Error('temporary'),{code:'ETIMEDOUT'});};
    f.sandbox.setTimeout=fn=>{if(mode==='cancel')f.sandbox.cancelGeneration++;else f.p.id='changed';fn();};
    await assert.rejects(f.start(),/已停止/);assert.equal(calls,1);assert.equal(f.starts(),0);
  }
});

test('temporary archive errors recover automatically, while cancellation cannot be swallowed as a warning',async()=>{
  const f=fixture('review');let calls=0;f.sandbox.candidate=f.candidate;
  f.sandbox.provisionalPackage=async()=>{if(++calls<3)throw Object.assign(Error('busy'),{code:'EBUSY'});return {id:'saved'};};
  assert.equal((await vm.runInContext('saveProvisional(candidate,null)',f.sandbox)).id,'saved');assert.equal(calls,3);
  f.sandbox.provisionalPackage=async()=>{throw Object.assign(Error('busy'),{code:'EBUSY'});};
  f.sandbox.setTimeout=fn=>{f.sandbox.cancelGeneration++;fn();};
  await assert.rejects(vm.runInContext('saveProvisional(candidate,null)',f.sandbox),/已停止/);
});

test('delivery and its state persistence have separate budgets and never recopy a successful delivery',async()=>{
  for(const fails of [false,true]){
    const f=fixture('review','manual');f.p.qualityCycle.report={completed:true};f.sandbox.active=null;
    f.p.jobs.push({id:'producer',action:'produce',cancelRequested:true}); // Historical cancellation must not block local recovery.
    let deliveries=0,writes=0;
    Object.assign(f.sandbox,{checkMedia:async()=>{},verifyCandidate:async()=>{},deliver:async()=>{deliveries++;return {id:'delivery'};},
      persist:async()=>{writes++;if(fails||writes<3)throw Object.assign(Error('state busy'),{code:'EBUSY'});}});
    vm.runInContext(section('async function resumeDelivery(','async function deliver('),f.sandbox);
    if(fails)await assert.rejects(vm.runInContext('resumeDelivery()',f.sandbox),/state busy/);
    else await vm.runInContext('resumeDelivery()',f.sandbox);
    assert.equal(deliveries,1);assert.equal(writes,3);
  }
});

test('a recovered completed independent audit reaches normal finalization without a new reviewer or probe',async()=>{
  const f=fixture('review');let finish;const finished=new Promise(resolve=>{finish=resolve;});const calls=[];
  f.sandbox.context={candidate:f.candidate,run:'/test-run',interruptedReview:{id:'prior-review',threadId:'independent',summary:'completed'}};
  Object.assign(f.sandbox,{options:{job:f.job,context:f.sandbox.context,onFinish:async outcome=>finish(outcome)},
    bridge:async command=>{calls.push(command);return {completed:true};},recoverRecordedReview:async audit=>({...audit,limitations:[]}),
    runAgent:()=>{throw Error('must not start another reviewer');}});
  vm.runInContext(section('function runReviewAgent(','function runRepositoryCollection('),f.sandbox);
  vm.runInContext('runReviewAgent(options)',f.sandbox);
  assert.equal((await finished).code,0);assert.equal(f.sandbox.context.preflightReport.completed,true);
  assert.deepEqual(calls,['review-audit']);
});

const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
for(const fails of [false,true])test(`provisional retry UI releases busy controls after ${fails?'failure':'success'}`,async()=>{
  const calls=[],errors=[],button={hasAttribute:name=>name==='data-provisional-retry',disabled:false};
  const sandbox={state:{project:{id:'project'}},submitting:false,busy:false,event:{target:{closest:()=>button}},
    api:async endpoint=>{calls.push(endpoint);if(fails)throw Error('archive unavailable');},toast:()=>{},error:message=>errors.push(message)};
  sandbox.render=()=>{sandbox.busy=!!sandbox.submitting;button.disabled=sandbox.busy;};sandbox.refresh=async()=>sandbox.render();
  vm.createContext(sandbox);
  const handler=app.slice(app.indexOf('  const feedbackAction=e.target.closest'),app.indexOf('const dateFilter='));
  vm.runInContext('async function handle(e){'+handler+'}',sandbox);await vm.runInContext('handle(event)',sandbox);
  assert.deepEqual(calls,['/api/provisional']);assert.equal(sandbox.submitting,false);assert.equal(sandbox.busy,false);assert.equal(button.disabled,false);
  assert.equal(errors.length,fails?1:0);
});
