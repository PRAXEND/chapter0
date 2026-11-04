import test from 'node:test';
import assert from 'node:assert/strict';
import {initialProject,validateRequest,applyInput,makePrompt,parseResult} from '../workflow.mjs';
const input=()=>{const {topic,duration,selected,styleId,scriptDraft}=initialProject();return {topic,duration,selected,styleId,scriptDraft};};
test('rejects arbitrary actions, unknown material IDs, empty selection and missing script',()=>{
  assert.throws(()=>validateRequest(initialProject(),'shell',input()));
  assert.throws(()=>validateRequest(initialProject(),'script',{...input(),selected:['injected']}));
  assert.throws(()=>validateRequest(initialProject(),'script',{...input(),selected:[]}));
  assert.throws(()=>validateRequest(initialProject(),'storyboard',input()));
  assert.equal(validateRequest(initialProject(),'materials',{...input(),selected:['city','city']}).selected.length,1);
});
test('material changes invalidate only dependent results',()=>{
  const p=initialProject();p.scriptDraft='旧文案';p.outputs={materials:{},script:{},style:{},storyboard:{}};
  applyInput(p,{...input(),selected:['desk'],scriptDraft:'旧文案'},'script');
  assert.deepEqual(Object.keys(p.outputs),['materials']);
  assert.equal(p.scriptDraft,'');
});
test('edited script invalidates visual outputs while preserving generated script version',()=>{
  const p=initialProject();p.outputs={materials:{},script:{},style:{},storyboard:{}};
  applyInput(p,{...input(),scriptDraft:'用户改过的开场'},'style');
  assert.deepEqual(Object.keys(p.outputs),['materials','script']);
  assert.equal(p.scriptDraft,'用户改过的开场');
  const prompt=makePrompt('storyboard',{...input(),scriptDraft:p.scriptDraft});
  assert.match(prompt,/用户改过的开场/);assert.match(prompt,/虚构示例/);
});
test('topic changes invalidate every generated result',()=>{
  const p=initialProject();p.outputs={materials:{},script:{},style:{},storyboard:{}};
  applyInput(p,{...input(),topic:'新的故事'},'materials');assert.deepEqual(p.outputs,{});
});
test('fails visibly on invalid agent output',()=>{
  assert.throws(()=>parseResult('not json'));
  assert.throws(()=>parseResult(JSON.stringify({title:'x',items:[]})));
  assert.equal(parseResult(JSON.stringify({title:'标题',summary:'摘要',items:[{id:'1',title:'镜头',detail:'画面',tag:'00:00–00:05'}],script:'口播',nextAction:'审阅'})).title,'标题');
});
