import test from 'node:test';
import assert from 'node:assert/strict';
import {initialStudio,brief,validatePlan,validateSettings,inputHash,updateSettings,taskPrompt,schemas} from '../studio-workflow.mjs';
import {productionLayout,validateProductionPlan,renderProductionPlan,renderSourceUses,readSourceUses} from '../public/production-plan.js';

function fixture(ratio='9:16',captions=true){
  const project={...initialStudio(),topic:'Test',ratio,captions,selected:['a'],sources:[{id:'a',kind:'video',title:'Capture A',duration:10,sha256:'a'.repeat(64),url:'https://example.org/a',start:100,status:'ready'}]};
  const plan={title:'Test',script:'Test',stylePlan:null,gaps:[],productionPlan:{version:1,materialReview:'Synthetic observations',layout:productionLayout(brief(project).requirements)},shots:[{id:'s1',from:0,to:2,sourceIds:['a'],sourceUses:[{id:'u1',sourceId:'a',inSeconds:1,outSeconds:3,actionGroup:'capture-a-01',role:'primary',purpose:'Specific action',compatibility:'No conflicting claims'}],layout:{composition:'Full action and captions above reserved bottom',contentBottom:.78,captionBottom:captions ? .8 : null},narration:'Test',visual:'Test',screenText:'Test',transition:'Cut',design:[]}]};
  return {project,plan};
}

test('common contract is mandatory without a style and preserved in normalization',()=>{
  const {project,plan}=fixture();
  assert.deepEqual(validatePlan(plan,project).productionPlan,plan.productionPlan);
  assert.ok(schemas.plan.required.includes('productionPlan'));
  assert.ok(schemas.plan.properties.shots.items.required.includes('sourceUses'));
  const incomplete=structuredClone(plan);delete incomplete.productionPlan;
  assert.throws(()=>validatePlan(incomplete,project),/通用/);
  delete project.workflowVersion;delete incomplete.shots[0].sourceUses;delete incomplete.shots[0].layout;
  assert.doesNotThrow(()=>validatePlan(incomplete,project)); // old approved records can recover
});

test('portrait rules protect both key content and full caption bounds at any resolution',()=>{
  const {project,plan}=fixture();
  for(const [width,height] of [[1080,1920],[720,1280],[900,1200]]){
    const settings={...brief(project).requirements,width,height};
    validateProductionPlan(plan,settings,project.sources);
    for(const key of ['contentBottom','captionBottom']){
      const bad=structuredClone(plan);bad.shots[0].layout[key]=.9;
      assert.throws(()=>validateProductionPlan(bad,settings,project.sources),/避让/);
    }
  }
  for(const ratio of ['16:9','1:1']){
    const f=fixture(ratio);f.plan.shots[0].layout={composition:'Original layout',contentBottom:.98,captionBottom:.98};
    validatePlan(f.plan,f.project);assert.deepEqual(f.plan.productionPlan.layout,{mode:'unchanged',bottomInset:0});
  }
  const silent=fixture('9:16',false);validatePlan(silent.plan,silent.project);
});

test('layout settings invalidate confirmation while output destination does not',()=>{
  const {project,plan}=fixture();project.plan=plan;project.approval={status:'confirmed'};
  const old=inputHash(project),settings=validateSettings({...project,portraitBottomInset:.25});
  updateSettings(project,settings);assert.notEqual(inputHash(project),old);assert.equal(project.approval,null);
  assert.throws(()=>validatePlan(plan,project),/布局/);
  for(const value of [.5,null,'',true])assert.throws(()=>validateSettings({...project,portraitBottomInset:value}));
  assert.throws(()=>validateSettings({...project,replayAuthorization:''}));
  for(const value of [true,NaN,-.1,.41])assert.throws(()=>productionLayout({portrait_bottom_inset:value}));
});

test('replay detection covers source loops, repost groups, hashes and original URL offsets',()=>{
  for(const mode of ['overlap','loop','hash','file','url','repost']){
    const {project,plan}=fixture(),original=plan.shots[0].sourceUses[0],second={...original,id:'u2',actionGroup:'distinct'};
    if(['hash','file','url','repost'].includes(mode)){
      const source={...project.sources[0],id:'b',sha256:'b'.repeat(64),url:'https://example.org/b'};
      if(mode==='hash')source.sha256=project.sources[0].sha256;
      if(mode==='file'){source.localPath='/tmp/same.mp4';project.sources[0].localPath=source.localPath;}
      if(mode==='url'){source.url=project.sources[0].url;source.start=101;second.inSeconds=0;second.outSeconds=2;}
      if(mode==='repost')second.actionGroup=original.actionGroup;
      project.sources.push(source);project.selected.push('b');plan.shots[0].sourceIds.push('b');second.sourceId='b';
    }
    if(mode==='loop')Object.assign(second,{inSeconds:6,outSeconds:8,actionGroup:original.actionGroup});
    plan.shots[0].sourceUses.push(second);
    assert.throws(()=>validatePlan(plan,project),/重复动作/,mode);
  }
});

test('distinct robots, sequential action segments and approved replay remain possible',()=>{
  const {project,plan}=fixture(),shot=plan.shots[0],first=shot.sourceUses[0];
  shot.sourceUses.push({...first,id:'u2',inSeconds:3,outSeconds:5,actionGroup:'next-subsegment'});
  project.sources.push({...project.sources[0],id:'b',url:'https://example.org/b',sha256:'b'.repeat(64)});project.selected.push('b');shot.sourceIds.push('b');
  shot.sourceUses.push({...first,id:'u3',sourceId:'b',actionGroup:'different-robot',role:'supplemental'});
  validatePlan(plan,project);
  shot.sourceUses.push({...first,id:'u4'});assert.throws(()=>validatePlan(plan,project));
  project.replayAuthorization='请重放一次作对照';validatePlan(plan,project);
  shot.sourceUses.at(-1).outSeconds=11;assert.throws(()=>validatePlan(plan,project),/时长/);
});

test('images, missing sources and malformed data are checked',()=>{
  const {project,plan}=fixture();project.sources[0].kind='image';
  assert.throws(()=>validatePlan(plan,project));
  Object.assign(plan.shots[0].sourceUses[0],{inSeconds:null,outSeconds:null,actionGroup:''});validatePlan(plan,project);
  for(const change of [{sourceIds:['missing']},{sourceUses:[null]},{sourceUses:[]},{layout:null}]){
    const p=structuredClone(plan);Object.assign(p.shots[0],change);assert.throws(()=>validatePlan(p,project));
  }
});

test('review UI escapes notes, presents bounds and retains identity when editing windows',()=>{
  const {project,plan}=fixture();plan.productionPlan.materialReview='<script>bad()</script>';
  const html=renderProductionPlan(plan);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|style=/);
  assert.match(html,/18%/);assert.match(html,/viewBox=/);
  const shot=plan.shots[0],fields=[{dataset:{useField:'inSeconds'},value:'1.5'},{dataset:{useField:'purpose'},value:'Natural bridge'}];
  const node={dataset:{useId:'u1'},querySelectorAll:()=>fields};
  const read=readSourceUses({querySelectorAll:s=>s==='[data-use-id]'?[node]:[{dataset:{layoutField:'captionBottom'},value:'0.79'}]},shot);
  assert.equal(read.sourceUses[0].id,'u1');assert.equal(read.sourceUses[0].inSeconds,1.5);assert.equal(read.layout.captionBottom,.79);
  assert.equal(shot.sourceUses[0].inSeconds,1);
  const sourceHtml=renderSourceUses(shot,project.sources);assert.match(sourceHtml,/data-add-use/);assert.match(sourceHtml,/data-remove-use/);
});

test('all three workflow stages include common source and layout instructions',()=>{
  assert.match(taskPrompt('discover',{}),/beyond the same news/);
  assert.match(taskPrompt('plan',{}),/LOCAL-file seconds/);
  assert.match(taskPrompt('produce',{}),/material_continuity/);
  assert.match(taskPrompt('produce',{}),/Actual playback is required/);
});
