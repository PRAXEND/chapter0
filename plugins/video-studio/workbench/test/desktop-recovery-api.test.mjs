import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {initialStudio} from '../studio-workflow.mjs';

// Real server, persistence, Python bridge, OS mutex, and worker protocol. All
// desktop/ChatCut RPC replies are isolated fixtures; no model or paid generation.
test('upgrade keeps historical bytes while a new HTTP project recovers its old desktop lock',{timeout:60000},async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'desktop-upgrade-')),data=path.join(temp,'data'),home=path.join(temp,'codex'),root=fileURLToPath(new URL('../',import.meta.url));let child;
 const threadId=randomUUID(),oldId=randomUUID(),turnId=randomUUID(),old=initialStudio();delete old.productionRules;
 old.topic='Historical QA failure';old.jobs=[{id:oldId,action:'produce',status:'running',execution:{backend:'desktop',desktopThreadId:threadId}}];old.automatic={status:'quality_failed'};
 const oldBytes=JSON.stringify(old),rollout=path.join(home,'sessions','fixture.jsonl'),state=path.join(temp,'turns.json'),ticketFile=path.join(data,'jobs',oldId,'desktop','ticket.json');
 await Promise.all([mkdir(path.dirname(rollout),{recursive:true}),mkdir(path.join(data,'projects'),{recursive:true}),mkdir(path.dirname(ticketFile),{recursive:true}),mkdir(path.join(data,'desktop-lock-'+threadId),{recursive:true})]);
 const event=(type,payload)=>JSON.stringify({type,payload})+'\n';
 await writeFile(rollout,event('session_meta',{id:threadId})+event('turn_context',{approval_policy:'never',sandbox_policy:{type:'danger-full-access'},model:'fixture'})+event('event_msg',{type:'task_started',turn_id:turnId})+event('event_msg',{type:'task_complete',turn_id:turnId}));
 const ticket={schema:1,jobId:oldId,requestId:randomUUID(),threadId,marker:'[old-workbench-request]',leaseUntil:Date.now()+120000};
 await Promise.all([
  writeFile(ticketFile,JSON.stringify(ticket)),writeFile(path.join(path.dirname(ticketFile),'desktop-ack.json'),JSON.stringify({jobId:oldId,requestId:ticket.requestId,threadId})),
  writeFile(path.join(data,'desktop-lock-'+threadId,'owner.json'),JSON.stringify({jobId:oldId})),
  writeFile(path.join(data,'projects',old.id+'.json'),oldBytes),writeFile(path.join(data,'workbench-v2.json'),oldBytes),
  writeFile(path.join(data,'desktop-session.json'),JSON.stringify({schema:1,threadId,title:'Fixture'})),
  writeFile(state,JSON.stringify([{id:turnId,items:[{type:'userMessage',content:[{type:'text',text:ticket.marker}]}]}]))
 ]);
 const fake=path.join(temp,'codex.mjs');
 await writeFile(fake,`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
const state=${JSON.stringify(state)},rollout=${JSON.stringify(rollout)};
if(process.argv.includes('--version'))console.log('codex-cli 0.164.0');
else if(process.argv.includes('--help'))console.log('--ephemeral --json --output-schema --add-dir --approve-for-me');
else if(process.argv.includes('login'))console.log('Logged in using fixture');
else if(process.argv.includes('queue')){
 const {workerCommand}=await import(${JSON.stringify(path.join(root,'desktop-worker.mjs'))});
 const file=path.join(process.cwd(),'desktop/ticket.json'),ticket=JSON.parse(fs.readFileSync(file)),id=randomUUID();
 const event=type=>fs.appendFileSync(rollout,JSON.stringify({type:'event_msg',payload:{type,turn_id:id}})+'\\n');event('task_started');
 await workerCommand('claim',file);
 fs.writeFileSync(state,JSON.stringify([{id,items:[{type:'userMessage',content:[{type:'text',text:ticket.marker}]}]},...JSON.parse(fs.readFileSync(state))]));
 const answer=path.join(process.cwd(),'fixture-result.json');fs.writeFileSync(answer,JSON.stringify({connected:true,message:'isolated connection'}));await workerCommand('complete',file,answer);event('task_complete');console.log('queued');
}else if(process.argv.includes('app-server')){
 let b='';process.stdin.on('data',block=>{b+=block;let i;while((i=b.indexOf('\\n'))>=0){const q=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(!q.id)continue;let result={};
 if(q.method==='initialize')result={codexHome:${JSON.stringify(home)}};
 if(q.method==='config/read')result={config:{model:'gpt-6-astra'}};
 if(q.method==='model/list')result={data:[{id:'gpt-6-astra',model:'gpt-6-astra',isDefault:true}],nextCursor:null};
 if(q.method==='thread/read')result={thread:{id:${JSON.stringify(threadId)},path:rollout,source:'vscode',originator:'Codex Desktop'}};
 if(q.method==='thread/turns/list')result={data:JSON.parse(fs.readFileSync(state))};
 if(q.method==='thread/items/list')result={data:[{turnId:q.params.turnId,item:{id:'tool',type:'mcpToolCall',server:'chatcut',tool:'list_projects',status:'completed'}}]};
 console.log(JSON.stringify({id:q.id,result}));}});
}
`);await chmod(fake,0o755);
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const api=async(route,payload)=>{const r=await fetch('http://127.0.0.1:'+port+'/api/'+route,payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Video-Demo':'1'},body:JSON.stringify(payload)});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;};
 try{
  child=spawn(process.execPath,[path.join(root,'studio-server.mjs')],{env:{...process.env,PORT:String(port),VIDEO_STUDIO_AGENT_MODE:'desktop',VIDEO_STUDIO_WEB_DATA:data,VIDEO_STUDIO_HOME:path.join(temp,'user'),VIDEO_DEMO_CODEX_BIN:fake},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'startup timeout')),15000);child.stdout.on('data',b=>{if(b.toString().includes('Video Agent Demo:')){clearTimeout(timer);resolve();}});});
  assert.equal((await api('state')).readOnly,true);assert.equal((await api('desktop/status')).recovery.status,'recoverable');
  const fresh=await api('reset',{});await api('project',{...fresh.project,mode:'manual'});
  const {job}=await api('jobs',{action:'connect'});let current;
  for(let n=0;n<150;n++){current=await api('state');if(!current.activeJobId)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(current.project.jobs.find(j=>j.id===job.id).status,'completed',JSON.stringify(current.project.jobs));
  assert.equal((await api('desktop/status')).recovery.status,'idle');assert.equal(JSON.parse(await readFile(ticketFile,'utf8')).revoked,true);
  assert.equal(await readFile(path.join(data,'projects',old.id+'.json'),'utf8'),oldBytes);
  await api('projects/switch',{projectId:old.id});assert.equal((await api('state')).readOnly,true);assert.equal((await api('desktop/recover',{})).recovery.status,'idle');
 }finally{if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}await rm(temp,{recursive:true,force:true});}
});
