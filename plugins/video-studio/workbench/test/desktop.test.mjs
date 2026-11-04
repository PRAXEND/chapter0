import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {desktopSessions,inspectDesktop,atomicJson,desktopActivity} from '../desktop-session.mjs';
import {runDesktopAgent,recordedTool} from '../desktop-agent.mjs';
import {workerCommand,readRegularJson,validateResult} from '../desktop-worker.mjs';
import {desktopSetupMarkup} from '../public/desktop-setup.js';

async function fixture(t){
  const base=await mkdtemp(path.join(os.tmpdir(),'vs-desktop-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const threadId=randomUUID(),id=randomUUID(),jobDirectory=path.join(base,'jobs',id),run=path.join(base,'run'),sessions=path.join(base,'sessions');
  await Promise.all([mkdir(jobDirectory,{recursive:true}),mkdir(run),mkdir(sessions)]);
  const rollout=path.join(sessions,'session.jsonl');
  await writeFile(rollout,[{type:'session_meta',payload:{id:threadId}},{type:'turn_context',payload:{approval_policy:'never',sandbox_policy:{type:'danger-full-access'},model:'fixture-model'}}].map(x=>JSON.stringify(x)).join('\n'));
  await writeFile(path.join(run,'run.json'),'{}');
  const reader={codexHome:base,turns:[],calls:[],async call(method,params){this.calls.push({method,params});if(method==='thread/read')return {thread:{id:threadId,path:rollout,source:'vscode',originator:'Codex Desktop',name:'Fixture'}};if(method==='thread/turns/list')return {data:this.turns};if(method==='thread/items/list')return {data:[{turnId:params.turnId,item:{id:'real-tool',type:'mcpToolCall',server:'chatcut',tool:'list_projects',status:'completed',result:{content:[]}}}]};if(method==='thread/list')return {data:[]};throw Error(method);}};
  reader.activity=async()=>({latest:reader.turns[0]?.id,turns:new Map(reader.turns.map(t=>[t.id,t.actualStatus||t.status]))});
  const job={id,action:'connect',startedAt:new Date().toISOString(),toolCalls:[],execution:{backend:'desktop',desktopThreadId:threadId}};
  const context={jobId:id,jobDirectory,run,selectedSources:[],brief:{},pluginRoot:base};
  const ticketFile=path.join(jobDirectory,'desktop','ticket.json'),events=[];
  const opts={codex:'unused',reader,job,context,pollMs:10,ackTimeoutMs:100,event:(type,message)=>events.push({type,message})};
  async function accept({complete=true}={}){const ticket=await readRegularJson(ticketFile);await workerCommand('claim',ticketFile);reader.turns=[{id:'turn-current',status:complete?'completed':'inProgress',items:[{type:'userMessage',content:[{type:'text',text:ticket.marker}]}]}];if(complete){const file=path.join(jobDirectory,'answer.json');await writeFile(file,JSON.stringify({connected:true,message:'fixture'}));await workerCommand('complete',ticketFile,file);}return ticket;}
  return {base,reader,job,context,ticketFile,events,opts,accept,rollout};
}

test('first launch defaults to desktop and setup uses only local reads',async t=>{
  const f=await fixture(t);class Reader{constructor(){return f.reader;}}
  const config=desktopSessions({dataDir:f.base,codex:()=>'',env:{},Reader});await config.load();assert.equal(config.state().configured,false);await assert.rejects(config.requireReady(),/首次使用/);
  await config.list();await config.configure(f.job.execution.desktopThreadId);assert.equal(config.state().configured,true);
  assert.ok(f.reader.calls.every(c=>['thread/list','thread/read','thread/turns/list'].includes(c.method)));
  const fresh=desktopSessions({dataDir:f.base,codex:()=>'',env:{},Reader});await fresh.load();assert.equal(fresh.state().threadId,f.job.execution.desktopThreadId);
});
test('permissions and a busy desktop session block dispatch',async t=>{
  const f=await fixture(t);f.reader.turns=[{status:'inProgress'}];await assert.rejects(inspectDesktop(f.reader,f.job.execution.desktopThreadId),/其他任务/);
  await writeFile(f.rollout,'\n'+JSON.stringify({type:'turn_context',payload:{approval_policy:'on-request',sandbox_policy:{type:'workspace-write'}}}),{flag:'a'});
  await assert.rejects(inspectDesktop(f.reader,f.job.execution.desktopThreadId),/完全访问/);
});
test('queued without acknowledgement is not success and late work is revoked',async t=>{
  const f=await fixture(t);let sent=0;
  const result=await new Promise(resolve=>runDesktopAgent({...f.opts,queue:async()=>{sent++;return {stdout:'queued',stderr:'no daemon'};},onFinish:resolve}));
  assert.equal(result.code,1);assert.equal(sent,1);assert.match(result.error,/未接收/);await assert.rejects(workerCommand('claim',f.ticketFile),/已停止/);
});
test('real current turn, worker claim and validated result complete the task',async t=>{
  const f=await fixture(t);const result=await new Promise(resolve=>runDesktopAgent({...f.opts,queue:async()=>{await f.accept();return {stderr:'daemon unavailable'};},onFinish:resolve}));
  assert.equal(result.code,0);assert.equal(result.error,'');assert.equal(JSON.parse(result.finalText).connected,true);assert.equal(f.job.threadId,f.job.execution.desktopThreadId);
  assert.ok(f.job.toolCalls.some(t=>t.tool==='list_projects'&&t.status==='completed'));
  assert.equal(recordedTool({type:'agentMessage',text:'list_projects completed'}),null);
});
test('forged result identity fails even when the real desktop turn completes',async t=>{
  const f=await fixture(t);const result=await new Promise(resolve=>runDesktopAgent({...f.opts,queue:async()=>{await f.accept();const file=path.join(f.context.jobDirectory,'desktop','desktop-result.json'),v=await readRegularJson(file);v.jobId='other';await atomicJson(file,v);return {};},onFinish:resolve}));assert.equal(result.code,1);assert.match(result.error,/不一致/);
});
test('cancellation waits for actual desktop turn completion',async t=>{
  const f=await fixture(t);let controller,finishCount=0,queuedResolve;const queued=new Promise(r=>queuedResolve=r);
  const done=new Promise(resolve=>{controller=runDesktopAgent({...f.opts,queue:async()=>{await f.accept({complete:false});queuedResolve();return {};},onFinish:v=>{finishCount++;resolve(v);}});});
  await queued;controller.cancel();await new Promise(r=>setTimeout(r,50));assert.equal(finishCount,0);await assert.rejects(workerCommand('check',f.ticketFile),/已停止/);
  f.reader.turns[0].status='interrupted';assert.equal((await done).code,1);assert.equal(finishCount,1);
});
test('inferred interrupted history cannot terminate a live desktop turn',async t=>{
  const f=await fixture(t);let queuedResolve,count=0;const queued=new Promise(r=>queuedResolve=r);
  const done=new Promise(resolve=>runDesktopAgent({...f.opts,queue:async()=>{await f.accept({complete:false});f.reader.turns[0].actualStatus='inProgress';f.reader.turns[0].status='interrupted';queuedResolve();return {};},onFinish:v=>{count++;resolve(v);}}));
  await queued;await new Promise(r=>setTimeout(r,40));assert.equal(count,0);assert.equal((await readRegularJson(f.ticketFile)).revoked,false);
  const file=path.join(f.context.jobDirectory,'answer.json');await atomicJson(file,{connected:true,message:'actual completion'});await workerCommand('complete',f.ticketFile,file);
  f.reader.turns[0].actualStatus='completed';assert.equal((await done).code,0);
});
test('service reattachment observes the same task without a second queue call',async t=>{
  const f=await fixture(t);let controller,queuedResolve,dispatches=0;const queued=new Promise(r=>queuedResolve=r);
  controller=runDesktopAgent({...f.opts,queue:async()=>{dispatches++;await f.accept({complete:false});queuedResolve();return {};},onFinish(){assert.fail('detached observer must not finish');}});
  await queued;await new Promise(r=>setTimeout(r,30));controller.detach();
  const file=path.join(f.context.jobDirectory,'answer.json');await writeFile(file,JSON.stringify({connected:true,message:'resumed'}));await workerCommand('complete',f.ticketFile,file);f.reader.turns[0].status='completed';
  const result=await new Promise(resolve=>runDesktopAgent({...f.opts,restore:true,queue:async()=>{dispatches++;throw Error('duplicate');},onFinish:resolve}));assert.equal(result.code,0);assert.equal(dispatches,1);
});
test('worker refuses duplicate claims, invalid schema, expired lease and symlink results',async t=>{
  const f=await fixture(t),directory=path.dirname(f.ticketFile);await mkdir(directory);
  const schemaFile=path.join(directory,'schema.json');await atomicJson(schemaFile,{type:'object',required:['ok'],properties:{ok:{type:'boolean'}},additionalProperties:false});
  const ticket={schema:1,jobId:f.job.id,requestId:randomUUID(),threadId:f.job.execution.desktopThreadId,leaseUntil:Date.now()+10000,schemaFile};await atomicJson(f.ticketFile,ticket);
  await workerCommand('claim',f.ticketFile);await assert.rejects(workerCommand('claim',f.ticketFile),{code:'EEXIST'});
  const result=path.join(directory,'answer.json');await atomicJson(result,{ok:'true'});await assert.rejects(workerCommand('complete',f.ticketFile,result),/类型/);
  await symlink(result,result+'.link');await assert.rejects(readRegularJson(result+'.link'),/普通文件/);
  await atomicJson(f.ticketFile,{...ticket,leaseUntil:0});await assert.rejects(workerCommand('check',f.ticketFile),/过期/);
  assert.throws(()=>validateResult({extra:1},{type:'object',additionalProperties:false}),/多余字段/);
});
test('setup is initially expanded, explains permission limits, and escapes thread labels',()=>{
  assert.match(desktopSetupMarkup({configured:false}),/<details open>/);assert.match(desktopSetupMarkup({}),/不会代替操作系统或网站授权/);
  assert.doesNotMatch(desktopSetupMarkup({configured:true,title:'<script>',threadId:'"'}),/<script>/);
});
test('lifecycle reader follows appended events and ignores an incomplete trailing record',async t=>{
  const f=await fixture(t);delete f.reader.activity;
  await writeFile(f.rollout,'\n'+JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'t1'}})+'\n',{flag:'a'});
  assert.equal((await desktopActivity(f.reader,f.job.execution.desktopThreadId)).turns.get('t1'),'inProgress');
  const line=JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'t1'}});
  await writeFile(f.rollout,line.slice(0,30),{flag:'a'});assert.equal((await desktopActivity(f.reader,f.job.execution.desktopThreadId)).turns.get('t1'),'inProgress');
  await writeFile(f.rollout,line.slice(30)+'\n',{flag:'a'});assert.equal((await desktopActivity(f.reader,f.job.execution.desktopThreadId)).turns.get('t1'),'completed');
});
