import test from 'node:test';
import assert from 'node:assert/strict';
import {renderDependencyCheck} from '../public/dependency-view.js';
import {styleCapabilities,dependencyFailures,failedDependencyReport} from '../runtime.mjs';

test('only the selected optional style gates tasks, with stable IDs across versions',()=>{
  const checks=[{id:'style_media_hot_news',ok:false,required:false},{id:'style_media_technical_explainer',ok:true,required:true},{id:'git_lfs',ok:false,required:false}];
  for(const selector of [null,'another-style@1','henry-technical-explainer@8'])assert.deepEqual(dependencyFailures({checks},styleCapabilities(selector)),[]);
  for(const selector of ['henry-hot-news@7','henry-hot-news@8'])assert.equal(dependencyFailures({checks},styleCapabilities(selector)).length,1);
  assert.equal(dependencyFailures({checks:[]},styleCapabilities('henry-hot-news@8')).length,1);
});

test('missing tools and media expose bounded escaped repair details without a false pass',()=>{
  const check={id:'style_media_hot_news',label:'热点资讯风格素材',ok:false,required:true,message:'素材未下载',remedy:'git -C "path with spaces" lfs pull',packRoot:'/tmp/<pack>',issues:[{path:'media/<script>.mp4',status:'lfs_pointer'}]};
  const html=renderDependencyCheck(check);
  assert.match(html,/needs-fix/);assert.match(html,/LFS 指针/);assert.match(html,/git -C &quot;path with spaces&quot;/);
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  assert.match(renderDependencyCheck({...check,required:false}),/optional/);
  assert.match(renderDependencyCheck({id:'git_lfs',label:'Git LFS',ok:false,required:false}),/补齐素材时使用/);
  assert.match(renderDependencyCheck({...check,issues:Array.from({length:25},()=>check.issues[0])}),/另有 5 项/);
});

test('a failed fresh preflight replaces stale passing results for every required capability',()=>{
  const report=failedDependencyReport(['python','media'],'henry-hot-news@8','bridge failed');
  const prior=[{id:'python',ok:true},{id:'media',ok:true},{id:'style_media_hot_news',ok:true}];
  const merged={checks:[...prior.filter(old=>!report.checks.some(now=>now.id===old.id)),...report.checks]};
  assert.equal(dependencyFailures(merged,['python','media',...styleCapabilities('henry-hot-news@8')]).length,3);
  assert.equal(report.ready,false);assert.match(report.checks[2].remedy,/bridge failed/);
});
