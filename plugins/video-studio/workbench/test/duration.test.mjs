import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initialStudio,brief,validateSettings,updateSettings,validatePlan,inputHash,taskPrompt} from '../studio-workflow.mjs';
import {requestHash,beginAutomatic} from '../automatic.mjs';
import {durationLabel,validateDurationRange} from '../public/duration.js';

function fixture(){
  const project={...initialStudio(),topic:'事件',ratio:'16:9',selected:['a'],sources:[{id:'a',kind:'video',status:'ready',sha256:'a'.repeat(64),duration:70}]};
  const plan=to=>({title:'事件',script:'真实内容',productionPlan:{version:1,materialReview:'Synthetic test',layout:{mode:'unchanged',bottomInset:0}},shots:[{id:'s1',from:0,to,sourceIds:['a'],sourceUses:[{id:'u1',sourceId:'a',inSeconds:0,outSeconds:to,actionGroup:'first',role:'primary',purpose:'test',compatibility:'test'}],layout:{composition:'test',contentBottom:null,captionBottom:null},narration:'内容',visual:'画面',screenText:'',transition:'cut'}]});
  return {project,plan};
}
test('new videos default to 60–70 seconds and export both bounds to the production brief',()=>{
  const p=initialStudio();assert.equal(p.durationMin,60);assert.equal(p.duration,70);assert.equal(p.captions,true);assert.equal(p.advancedOverrides.captions,true);assert.equal(brief(p).requirements.captions,true);
  assert.equal(brief(p).requirements.min_seconds,60);assert.equal(brief(p).requirements.max_seconds,70);assert.equal(durationLabel(p),'60–70 秒');
});
test('range input rejects inverted and invalid values; empty lower bound is explicit',()=>{
  const p=initialStudio();for(const durationMin of [-1,0,2,71,Infinity,NaN,'bad'])assert.throws(()=>validateSettings({...p,durationMin}));
  assert.throws(()=>validateDurationRange(70,71),/不能超过/);assert.throws(()=>validateSettings({...p,duration:50}),/不能超过/);
  assert.equal(validateSettings({...p,durationMin:''}).durationMin,null);assert.equal(validateSettings({...p,durationMin:70}).durationMin,70);
});
test('too-short storyboard is blocked before formal narration while both boundaries pass',()=>{
  const {project,plan}=fixture();assert.throws(()=>validatePlan(plan(22.2),project),/下限/);
  assert.doesNotThrow(()=>validatePlan(plan(60),project));assert.doesNotThrow(()=>validatePlan(plan(70),project));
});
test('changing the lower bound invalidates approval and starts a distinct automatic cycle',()=>{
  const {project:p,plan}=fixture();p.styleSelector='fixture@1';beginAutomatic(p);
  const oldId=p.automatic.id,oldRequest=p.automatic.requestHash;p.plan=plan(60);p.approval={status:'confirmed',inputHash:inputHash(p)};
  updateSettings(p,{durationMin:65,selected:p.selected});assert.equal(p.approval,null);assert.equal(p.plan.stale,true);assert.notEqual(requestHash(p),oldRequest);
  beginAutomatic(p);assert.notEqual(p.automatic.id,oldId);
});
test('omitted fields preserve existing minima and legacy upper-only requests retain their hashes',()=>{
  const p=initialStudio();const payload={...p};delete payload.durationMin;updateSettings(p,validateSettings(payload));assert.equal(p.durationMin,60);
  assert.throws(()=>updateSettings(p,{selected:[],duration:30}),/不能超过/);assert.equal(p.duration,70);
  delete p.durationMin;const oldInput=inputHash(p),oldRequest=requestHash(p);p.durationMin=null;
  assert.equal(inputHash(p),oldInput);assert.equal(requestHash(p),oldRequest);assert.equal(brief(p).requirements.min_seconds,null);assert.equal(durationLabel(p),'70 秒上限');
});
test('production instructions and UI expose the range without encouraging filler',async()=>{
  const prompt=taskPrompt('create',{advancedOverrides:{}});assert.match(prompt,/min_seconds\/max_seconds range/);assert.match(prompt,/never silently shorten below the minimum/);
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');assert.match(html,/id="duration-min"/);
});
