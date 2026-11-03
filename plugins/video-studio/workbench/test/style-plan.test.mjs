import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan,initialStudio,schemas} from '../studio-workflow.mjs';
import {renderShotDesign,readShotDesign,renderStylePlan} from '../public/style-plan-view.js';

const design=()=>({id:'motion-1',ruleIds:['mechanism'],purpose:'解释状态变化',trigger:'说到转向时',phases:'进入、切换指示、退出',durationSeconds:2,placement:'手部旁空白',sound:'轻提示',implementation:'可编辑指示线',fallback:'侧边分步标签'});
const plan=()=>({productionPlan:{version:1,materialReview:'Synthetic observations',layout:{mode:'portrait-safe',bottomInset:.18}},title:'测试',script:'测试',shots:[{id:'s1',from:0,to:5,sourceIds:[],sourceUses:[],layout:{composition:'Graphics above reserved area',contentBottom:.8,captionBottom:null},narration:'测试',visual:'动作',screenText:'转向',transition:'硬切',design:[design()]}],stylePlan:{selector:'sample@8',rules:[{ruleId:'mechanism',disposition:'planned',shotIds:['s1'],treatment:'随台词变化'}],referenceChecks:[{referenceId:'ref',location:'测试',observation:'仅为测试',adaptation:'解释本题'}],contrastReview:'机制推进与动作间留阅读时间'}});

test('style plan and editable motion survive normalization; missing planning and invalid timing are rejected',()=>{
  const project={...initialStudio(),styleSelector:'sample@8'};
  const proposed=plan(),saved=validatePlan(proposed,project);
  assert.deepEqual(saved.stylePlan,proposed.stylePlan);
  assert.deepEqual(saved.shots[0].design,proposed.shots[0].design);
  assert.throws(()=>validatePlan({...proposed,stylePlan:null},project),/风格/);
  proposed.shots[0].design[0].durationSeconds=6;
  assert.throws(()=>validatePlan(proposed,project),/时长/);
  proposed.shots[0].design[0].durationSeconds=2;
  proposed.shots[0].design.push(design());
  assert.throws(()=>validatePlan(proposed,project),/唯一/);
  assert.ok(schemas.plan.properties.shots.items.required.includes('design'));
  assert.ok(schemas.plan.required.includes('stylePlan'));
});

test('design and reference content are visible and escaped',()=>{
  const p=plan();p.shots[0].design[0].phases='</textarea><script>bad()</script>';
  p.stylePlan.referenceChecks[0].observation='<img src=x onerror=bad()>';
  const designHtml=renderShotDesign(p.shots[0]),styleHtml=renderStylePlan(p);
  assert.match(designHtml,/触发台词/);assert.match(designHtml,/声音与落点/);
  assert.match(designHtml,/&lt;script&gt;/);assert.doesNotMatch(designHtml,/<script>/);
  assert.match(styleHtml,/&lt;img/);assert.doesNotMatch(styleHtml,/<img/);
  assert.match(styleHtml,/参考对照与逐条落实/);
});

test('editing design retains its identity and rule mapping',()=>{
  const original=design();
  const node={dataset:{designId:original.id},querySelectorAll:()=>[
    {dataset:{designField:'durationSeconds'},value:'1.5'},
    {dataset:{designField:'trigger'},value:'接触落定时'}]};
  const updated=readShotDesign({querySelectorAll:()=>[node]},[original])[0];
  assert.equal(updated.durationSeconds,1.5);assert.equal(updated.trigger,'接触落定时');
  assert.deepEqual(updated.ruleIds,original.ruleIds);assert.equal(updated.id,original.id);
  assert.equal(original.durationSeconds,2);
});
