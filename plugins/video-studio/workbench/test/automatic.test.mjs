import {revisionFeedback} from '../revisions.mjs';
import {durationLabel} from '../public/duration.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {initialStudio,updateSettings,inputHash} from '../studio-workflow.mjs';
import {currentVoiceRequest} from '../public/voice-ui.js';
import {beginAutomatic,nextAutomatic,advanceAutomatic,requestHash,curateSelection} from '../automatic.mjs';
import {voiceScope,normalizeVoiceRequest,pendingVoiceRequest,recordVoiceAnswer,voiceContext,savedVoiceChoices} from '../voices.mjs';

function project(){return {...initialStudio(),topic:'最近一周机器人落地',styleSelector:'example@1'};}
test('five inputs initiate an automatic run; unsupported framing/missing style fail before work',()=>{
  const p=project();assert.equal(p.mode,'automatic');assert.equal(beginAutomatic(p).stage,'voice');assert.match(p.automatic.authorization,/验收失败即暂停/);
  assert.throws(()=>beginAutomatic({...p,styleSelector:null}),/风格/);assert.throws(()=>beginAutomatic({...p,ratio:'1:1'}),/横版/);
});
test('automatic source choice only accepts actual media and skips acquired files on restart',()=>{
  const p=project();beginAutomatic(p);p.sources=[{id:'a',kind:'video',status:'ready'},{id:'b',kind:'video',status:'candidate'},{id:'fact',kind:'article'}];
  const choice={title:'具体选题',sourceIds:['a','b'],music:'none',captions:true};assert.equal(curateSelection(choice,p).sourceIds.length,2);
  assert.throws(()=>curateSelection({...choice,sourceIds:['fact']},p),/媒体/);
  Object.assign(p.automatic,{stage:'collect',sourceIds:['a','b'],collected:['a']});p.selected=['a'];
  assert.equal(nextAutomatic(p).sourceId,'b');advanceAutomatic(p,{action:'collect',sourceId:'b',automaticId:p.automatic.id,status:'blocked'});
  assert.equal(nextAutomatic(p).action,'plan');assert.deepEqual(p.automatic.collectionFailures,['b']);
});
test('cancel and quality refusal survive persistence and cannot replenish a spent repair',()=>{
  const p=project();beginAutomatic(p);const id=p.automatic.id;p.automatic.repairCount=1;p.automatic.stage='review';
  advanceAutomatic(p,{automaticId:id,action:'review',status:'quality_failed'});
  const restored=JSON.parse(JSON.stringify(p));assert.throws(()=>beginAutomatic(restored),/验收|修订/);assert.equal(restored.automatic.repairCount,1);
  restored.topic='新的主题';beginAutomatic(restored);assert.notEqual(restored.automatic.id,id);
  advanceAutomatic(restored,{automaticId:restored.automatic.id,action:'discover',cancelRequested:true});assert.equal(nextAutomatic(restored),null);
});
test('terminal repair lock survives later review errors and saved candidates resume at review',()=>{
  const p=project();beginAutomatic(p);p.approval={planHash:'plan',inputHash:'inputs'};
  p.qualityCycle={candidate:{planHash:'plan',inputHash:'inputs'},report:null,repairCount:1};p.automatic.stage='produce';
  const restored=JSON.parse(JSON.stringify(p));assert.equal(nextAutomatic(restored).action,'review');
  restored.qualityCycle.terminal='quality_failed';restored.automatic.status='blocked';
  assert.throws(()=>beginAutomatic(restored),/验收|修订/);
  advanceAutomatic(restored,{action:'review',automaticId:restored.automatic.id,status:'failed'});assert.equal(restored.automatic.status,'quality_failed');
});
test('a failed old candidate cannot make a new topic or approved revision terminal',()=>{
  for(const approval of [null,{planHash:'new-plan',inputHash:'inputs'},{planHash:'plan',inputHash:'new-inputs'}]){
    const p=project();beginAutomatic(p);p.approval={planHash:'plan',inputHash:'inputs'};
    p.qualityCycle={candidate:{...p.approval},report:{completed:false},terminal:'quality_failed',repairCount:1};p.automatic.status='quality_failed';
    updateSettings(p,{topic:'另一个主题',selected:[]});p.automatic=null;p.approval=approval;
    const id=beginAutomatic(p).id;
    advanceAutomatic(p,{automaticId:id,action:'voice',status:'needs_input'});
    assert.equal(p.automatic.status,'needs_input');assert.equal(beginAutomatic(p).id,id);
    advanceAutomatic(p,{automaticId:id,action:'discover',status:'failed'});
    assert.equal(p.automatic.status,'blocked');assert.equal(beginAutomatic(p).id,id);
    assert.equal(p.qualityCycle.terminal,'quality_failed');assert.equal(p.qualityCycle.repairCount,1);
  }
});
test('content inputs invalidate resume but generated choices and destination do not',()=>{
  const p=project();p.advancedOverrides={};const first=requestHash(p);p.outputRoot='/different';p.selected=['generated'];p.captions=true;assert.equal(requestHash(p),first);
  p.advancedOverrides={captions:true};const second=requestHash(p);p.captions=false;assert.notEqual(requestHash(p),second);
  p.voiceChoice={provider:'actual',voiceId:'chosen'};assert.notEqual(requestHash(p),first);
});
test('a passed current candidate resumes local delivery instead of another paid review',()=>{
  const p=project();beginAutomatic(p);p.approval={planHash:'plan',inputHash:'inputs'};
  p.qualityCycle={candidate:{...p.approval},report:{completed:true}};p.automatic.stage='review';
  assert.equal(nextAutomatic(p).action,'delivery');
  p.qualityCycle.candidate.planHash='old';assert.equal(nextAutomatic(p).action,'review');
});
test('preparation problems never trigger an unproductive full search loop',()=>{
  const p=project();p.narration=false;beginAutomatic(p);p.automatic.stage='plan';p.plan={gaps:['音色尚未同步','无法听审']};
  advanceAutomatic(p,{action:'plan',automaticId:p.automatic.id,status:'completed'});
  assert.equal(p.automatic.status,'blocked');assert.equal(nextAutomatic(p),null);
  beginAutomatic(p);assert.equal(nextAutomatic(p).action,'create');assert.deepEqual(p.automatic.gaps,[]);
});
test('legacy unfinished preparation migrates policy, reuses media, and keeps old deliveries',()=>{
  const p=project();p.narration=false;delete p.reviewPolicy;p.sources=[{id:'local',status:'ready'}];p.selected=['local'];
  p.deliveries=[{id:'old',qaStatus:'needs_review'}];p.plan={stale:false};p.approval={status:'confirmed'};
  p.automatic={id:'old-cycle',requestHash:requestHash(p),stage:'plan',status:'blocked',repairCount:0};
  beginAutomatic(p);assert.equal(p.reviewPolicy,'sampled-objective-v1');assert.equal(p.automatic.stage,'create');
  assert.equal(p.approval,null);assert.equal(p.plan.stale,true);assert.deepEqual(p.selected,['local']);assert.equal(p.deliveries[0].qaStatus,'needs_review');
});
test('resuming an existing candidate does not migrate or reset its policy and repair',()=>{
  const p=project();delete p.reviewPolicy;p.automatic={id:'pending',requestHash:requestHash(p),stage:'review',status:'blocked',repairCount:1};
  beginAutomatic(p);assert.equal(p.reviewPolicy,undefined);assert.equal(p.automatic.stage,'review');assert.equal(p.automatic.repairCount,1);
});
test('a new cycle retains historical artifacts without inheriting their approved plan',()=>{
  const p=project();p.narration=false;p.plan={stale:false};p.approval={status:'confirmed',planHash:'old',inputHash:'old'};
  p.qualityCycle={candidate:{...p.approval},report:{completed:true}};p.deliveries=[{id:'history'}];
  beginAutomatic(p);assert.equal(p.approval,null);assert.equal(p.plan.stale,true);
  assert.equal(nextAutomatic(p).action,'create');assert.equal(p.deliveries[0].id,'history');assert.equal(p.qualityCycle.report.completed,true);
});
test('preproduction intake needs no approved plan and survives sources/plan changes',async()=>{
  const p=project();p.voiceIntent='custom';const job={id:'voice',action:'voice',inputHash:'before-media',planHash:null,voiceScope:voiceScope(p),status:'needs_input'};
  job.voiceRequest=await normalizeVoiceRequest({kind:'clone_recording',message:'上传已授权录音',candidates:[]},job);p.jobs=[job];
  const request=pendingVoiceRequest(p,'after-media');assert.ok(request);
  recordVoiceAnswer(p,request,{action:'recording',confirmedConsent:true});
  p.approval={planHash:'new-plan'};assert.equal(voiceContext(p,'new-input').answers.length,1);
  p.voiceIntent='official';assert.equal(voiceContext(p,'new-input').answers.length,0);
});
test('host preflight failure preserves a resumable blocked stage instead of a running ghost task',async()=>{
  const source=await readFile(new URL('../studio-server.mjs',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function startAutomatic('),source.indexOf('\nfunction adoptTopic'));
  const p=project(),context=vm.createContext({revisionFeedback,project:p,beginAutomatic,nextAutomatic,persist:async()=>{},pendingVoiceRequest:()=>null,inputHash:()=>'',voiceScope:()=>'',getCatalog:async()=>({}),savedVoiceChoices:()=>[],startJob:async()=>{throw Error('actual preflight unavailable');}});
  vm.runInContext(fn,context);
  await assert.rejects(()=>vm.runInContext('startAutomatic()',context),/preflight unavailable/);
  assert.equal(p.automatic.status,'blocked');assert.equal(p.automatic.stage,'voice');
  const id=p.automatic.id;beginAutomatic(p);assert.equal(p.automatic.id,id);
});

const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
test('compact style choices group distribution copies and preserve the exact current selector',()=>{
  const render=app.slice(app.indexOf('function automaticStyleSelect('),app.indexOf('\nfunction renderAutomaticControls('));
  const entries=[{key:'original',selector:'news@8',name:'News',version:8,choice_group:'news@8'},
    {key:'distributed',selector:'pack-news@8',name:'News',version:8,choice_group:'news@8'},
    {key:'distinct',selector:'different@8',name:'News',version:8,choice_group:'different@8'}];
  for(const current of [null,'news@8','pack-news@8']){
    const state={project:{styleSelector:current}},context=vm.createContext({state,styleEntries:()=>entries,busy:false,esc:String});
    vm.runInContext(render,context);const html=vm.runInContext('automaticStyleSelect()',context);
    assert.equal((html.match(/<option /g)||[]).length,3);assert.match(html,/value="distinct"/);
    assert.match(html,current==='news@8'?/value="original" selected/:/value="distributed"/);
    if(current==='pack-news@8')assert.match(html,/value="distributed" selected/);
    assert.equal(state.project.styleSelector,current);
  }
});
test('one-click reuses a saved explicit voice without a separate model lookup',async()=>{
  const source=await readFile(new URL('../studio-server.mjs',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function startAutomatic('),source.indexOf('\nfunction adoptTopic'));
  const p=project(),calls=[],voice={provider:'fixture',voiceId:'saved',name:'Saved',voiceType:'custom',selected_by_user:true};
  const context=vm.createContext({revisionFeedback,project:p,beginAutomatic,nextAutomatic,requestHash,voiceScope,savedVoiceChoices,updateSettings,inputHash,pendingVoiceRequest,
    getCatalog:async()=>({profile:{voice}}),persist:async()=>{},bridge:async(action,value)=>{assert.equal(action,'save-voice');return {voice:value.voice};},startJob:async action=>{calls.push(action);return {id:'fixture'};}});
  vm.runInContext(fn,context);await vm.runInContext('startAutomatic()',context);
  assert.deepEqual(calls,['create']);assert.equal(p.voiceChoice.voiceId,'saved');assert.equal(p.voiceReady.scope,voiceScope(p));
});
function productionMarkup(p,busy=false){
  const context=vm.createContext({state:{project:p},busy,durationLabel,currentVoiceRequest,esc:s=>String(s??'').replace(/</g,'&lt;'),audioSummary:()=>''});
  vm.runInContext(app.slice(app.indexOf('function renderProduction()'),app.indexOf('\nfunction renderDelivery()')),context);
  return vm.runInContext('renderProduction()',context);
}
function manualCandidate(){
  const p={...project(),mode:'manual',approval:{status:'confirmed',planHash:'plan',inputHash:'inputs'},plan:{stale:false}};
  p.jobs=[{id:'producer',action:'produce',status:'completed'}];
  p.qualityCycle={candidate:{producerJobId:'producer',planHash:'plan',inputHash:'inputs'},report:null,repairCount:0};
  return p;
}
test('manual production resumes review after interruption, cancellation or technical failure',()=>{
  for(const status of ['interrupted','cancelled','failed']){
    const p=manualCandidate();p.jobs.unshift({action:'review',status,planHash:'plan',inputHash:'inputs',error:'验收待恢复 <detail>'});
    const html=productionMarkup(p);
    assert.match(html,/data-action="review" >✳ 继续独立验收与交付/);
    assert.doesNotMatch(html,/data-action="produce"/);assert.match(html,/等待继续验收/);assert.match(html,/验收待恢复 &lt;detail>/);
    assert.match(productionMarkup(p,true),/data-action="review" disabled/);
  }
});
test('manual recovery chooses review for undelivered passes and produce for unfinished repairs',()=>{
  const p=manualCandidate();p.qualityCycle.report={completed:true};
  assert.match(productionMarkup(p),/data-action="review"/);
  p.qualityCycle.report={completed:false};p.qualityCycle.repairCount=1;
  assert.match(productionMarkup(p),/data-action="produce"/);
  p.qualityCycle.repairCompleted=true;p.qualityCycle.report=null;
  assert.match(productionMarkup(p),/data-action="review"/);
  p.qualityCycle.terminal='quality_failed';
  assert.match(productionMarkup(p),/data-action="produce" disabled>✳ 验收未通过/);
});
test('manual recovery does not offer review for stale or already delivered candidates',()=>{
  const p=manualCandidate();p.approval.inputHash='new-inputs';
  assert.doesNotMatch(productionMarkup(p),/data-action="review"/);
  p.approval.inputHash='inputs';p.plan.stale=true;
  assert.doesNotMatch(productionMarkup(p),/data-action="review"/);
  p.plan.stale=false;p.deliveries.push({jobId:'producer'});
  assert.doesNotMatch(productionMarkup(p),/data-action="review"/);
});
