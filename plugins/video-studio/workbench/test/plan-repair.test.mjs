import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../studio-server.mjs',import.meta.url),'utf8');
const finish=source.slice(source.indexOf('async function finishJob('),source.indexOf('\nfunction adoptTopic'));
function harness(failures){
 const files=[],events=[];let saves=0,attempts=0;
 const job={id:'test',action:'plan'},context={jobDirectory:'/isolated-test'};
 const c=vm.createContext({job,context,files,events,JSON,Date,Promise,SyntaxError,path:{join:(...p)=>p.join('/')},writeFile:async(p,s)=>files.push([p,s]),checkSelected:async()=>{},savePlan:async()=>{if(saves++<failures)throw Error('referenceChecks[0].referenceId 无效');},cleanError:s=>s,addEvent:(_,t,m)=>events.push([t,m]),runtime:{codexPath:'test'},active:{job},library:{},refreshLibrary:async()=>{},persist:async()=>{},runAgent:({context,onFinish})=>{attempts++;assert.match(context.planRepair.validationError,/referenceId/);queueMicrotask(()=>onFinish({code:0,finalText:'{"summary":"draft"}'}));return {};}});
 vm.runInContext(finish,c);
 return {job,files,events,attempts:()=>attempts,run:()=>vm.runInContext('finishJob(job,context,{code:0,finalText:\'{"summary":"draft"}\'})',c)};
}
test('validation failure preserves draft and repairs before marking complete',async()=>{
 const h=harness(1);await h.run();assert.equal(h.job.status,'completed');assert.equal(h.attempts(),1);assert.ok(h.files.some(([p])=>p.endsWith('plan-draft-0.json')));assert.ok(h.files.some(([p])=>p.endsWith('plan-validation-1.json')));
});
test('persistent invalid output stops after two repairs and never bypasses validation',async()=>{
 const h=harness(9);await h.run();assert.equal(h.job.status,'failed');assert.equal(h.attempts(),2);assert.match(h.job.error,/referenceId/);
});
