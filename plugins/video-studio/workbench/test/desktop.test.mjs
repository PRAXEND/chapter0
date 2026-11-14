import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {desktopSessions,inspectDesktop,atomicJson,desktopActivity} from '../desktop-session.mjs';
import {runDesktopAgent,recordedTool,dispatchWarning} from '../desktop-agent.mjs';
import {reconcileDesktopLock,findDesktopTurn} from '../desktop-recovery.mjs';
import {lockPath,updateTicket,releaseDesktopLock,withDesktopMutex,assertTicket} from '../desktop-lock.mjs';
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

async function abandoned(f,{status='completed',claimed=true,expired=false}={}){
  const oldId=randomUUID(),directory=path.join(f.base,'jobs',oldId,'desktop'),file=path.join(directory,'ticket.json');
  await mkdir(directory,{recursive:true});await mkdir(lockPath(f.base,f.job.execution.desktopThreadId));
  const ticket={schema:1,jobId:oldId,threadId:f.job.execution.desktopThreadId,requestId:randomUUID(),marker:'[old-task]',leaseUntil:expired?0:Date.now()+120000};
  await atomicJson(file,ticket);await atomicJson(path.join(lockPath(f.base,ticket.threadId),'owner.json'),{jobId:oldId});
  if(claimed)await atomicJson(path.join(directory,'desktop-ack.json'),{jobId:oldId,threadId:ticket.threadId,requestId:ticket.requestId});
  f.reader.turns=status?[{id:'old-turn',status,items:[{type:'userMessage',content:[{type:'text',text:ticket.marker}]}]}]:[];
  return {ticket,file};
}
test('completed old owner is recovered before new dispatch, without rewriting the historical project',async t=>{
 const f=await fixture(t),old=await abandoned(f);const history=path.join(f.base,'old-project.json');await writeFile(history,'unchanged historical bytes');
 const result=await new Promise(resolve=>runDesktopAgent({...f.opts,queue:async()=>{await f.accept();return {};},onFinish:resolve}));
 assert.equal(result.code,0,result.error);assert.equal((await readRegularJson(old.file)).revoked,true);assert.equal(await readFile(history,'utf8'),'unchanged historical bytes');
 assert.ok(f.events.some(e=>e.type==='recovery'));
});
test('unknown, live, and incomplete history keep their owner; only proven expired unclaimed work can release',async t=>{
 for(const variant of [{status:'inProgress'},{status:null},{status:null,claimed:false,expired:true}]){
  const f=await fixture(t),old=await abandoned(f,variant);
  const r=await reconcileDesktopLock({dataDir:f.base,threadId:old.ticket.threadId,reader:f.reader,release:true});
  assert.equal(r.status,variant.expired?'released':variant.status==='inProgress'?'active':'unknown');
  if(!variant.expired)assert.equal((await readRegularJson(old.file)).revoked,undefined);
 }
});
test('second page turn is found; repeated cursors cannot be treated as a completed search',async t=>{
 const f=await fixture(t),original=f.reader.call.bind(f.reader);let pages=0;
 const result=await new Promise(resolve=>runDesktopAgent({...f.opts,queue:async()=>{
  await f.accept();const current=f.reader.turns[0];
  f.reader.call=async(method,params)=>{if(method!=='thread/turns/list')return original(method,params);pages++;return params.cursor?{data:[current]}:{data:Array.from({length:100},(_,i)=>({id:'unrelated-'+i,items:[]})),nextCursor:'older'};};return {};
 },onFinish:resolve}));assert.equal(result.code,0,result.error);assert.ok(pages>=2);
 f.reader.call=async()=>({data:[],nextCursor:'same'});await assert.rejects(findDesktopTurn(f.reader,{threadId:f.job.threadId,marker:'not-found'}),/分页重复/);
});
test('late old finish and stale heartbeat cannot revoke or delete a replacement owner',async t=>{
 const f=await fixture(t),old=await abandoned(f),threadId=old.ticket.threadId;
 const acquired=await reconcileDesktopLock({dataDir:f.base,threadId,reader:f.reader,jobId:f.job.id});
 await updateTicket(old.file,{...old.ticket,revoked:false,leaseUntil:Date.now()+120000});
 await releaseDesktopLock(old.file,old.ticket);
 assert.equal((await readRegularJson(old.file)).revoked,true);
 assert.equal((await readRegularJson(path.join(lockPath(f.base,threadId),'owner.json'))).token,acquired.owner.token);
 await assert.rejects(workerCommand('claim',old.file),/已停止/);
});
test('two recovery contenders cannot both acquire the same desktop slot',async t=>{
 const f=await fixture(t),old=await abandoned(f);
 const results=await Promise.allSettled([1,2].map(()=>reconcileDesktopLock({dataDir:f.base,threadId:old.ticket.threadId,reader:f.reader,jobId:randomUUID()})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
});
test('claim and complete wait for revocation mutex; revoked work cannot publish',async t=>{
 const f=await fixture(t);let signal;const queued=new Promise(r=>signal=r),controller=runDesktopAgent({...f.opts,ackTimeoutMs:10000,queue:async()=>{signal();return {};},onFinish(){}});t.after(()=>controller.detach());await queued;
 let attempt;
 await withDesktopMutex(f.base,async()=>{const ticket=await readRegularJson(f.ticketFile);attempt=workerCommand('claim',f.ticketFile);await atomicJson(f.ticketFile,{...ticket,revoked:true});});
 await assert.rejects(attempt,/已停止/);
});
test('resume failure warning is visible but credentials and task prompt are redacted',()=>{
 const warning=dispatchWarning('resume failed token=secret authorization=Bearer secret4 Bearer secret2 https://local/?token=secret3 [VideoStudio request:x] private task body');
 assert.match(warning,/resume failed/);assert.doesNotMatch(warning,/secret|private task body/);
});

test('a claim that wins the mutex during timeout is retained until real turn termination',async t=>{
const base=await mkdtemp(path.join(os.tmpdir(),'vs-peer-race-')),threadId=randomUUID(),id=randomUUID();
const jobDirectory=path.join(base,'jobs',id),run=path.join(base,'run'),sessions=path.join(base,'sessions');
await Promise.all([mkdir(jobDirectory,{recursive:true}),mkdir(run),mkdir(sessions)]);
const rollout=path.join(sessions,'session.jsonl');
await writeFile(rollout,[{type:'session_meta',payload:{id:threadId}},{type:'turn_context',payload:{approval_policy:'never',sandbox_policy:{type:'danger-full-access'}}}].map(JSON.stringify).join('\n'));
await writeFile(path.join(run,'run.json'),'{}');
const ticketFile=path.join(jobDirectory,'desktop','ticket.json');let claiming,staged=false,controller;t.after(()=>controller?.detach());
const reader={codexHome:base,activity:async()=>({latest:null,turns:new Map()}),async call(method){
 if(method==='thread/read')return{thread:{id:threadId,path:rollout,source:'vscode',originator:'Codex Desktop'}};
 if(method==='thread/turns/list'){
  if(staged)return{data:[]};staged=true;
  let acquired;const held=new Promise(r=>acquired=r);
  // Model a valid claim already holding the common OS mutex, whose ack write
  // completes after poll's initial non-atomic ack read. It uses the same token
  // validation and serialized ack persistence as the actual claim command.
  claiming=withDesktopMutex(base,async()=>{
   const ticket=JSON.parse(await readFile(ticketFile));assertTicket(ticket);acquired();
   await new Promise(r=>setTimeout(r,150));
   await writeFile(path.join(path.dirname(ticketFile),'desktop-ack.json'),JSON.stringify({schema:1,jobId:id,requestId:ticket.requestId,threadId}));
  });await held;return{data:[]};
 }throw Error(method);
}};
const job={id,action:'connect',startedAt:new Date().toISOString(),toolCalls:[],execution:{backend:'desktop',desktopThreadId:threadId}};
let finished=null;
controller=runDesktopAgent({codex:'unused',reader,job,context:{jobId:id,jobDirectory,run,selectedSources:[],brief:{},pluginRoot:base},ackTimeoutMs:-1,pollMs:20,event(){},queue:async()=>({}),onFinish:result=>{finished=result;}});
await new Promise(r=>setTimeout(r,600));await claiming;controller.detach();
let exists=true;try{await access(lockPath(base,threadId));}catch{exists=false;}
assert.equal(finished,null);assert.equal(exists,true);await new Promise(r=>setTimeout(r,50));await rm(base,{recursive:true,force:true});
});
