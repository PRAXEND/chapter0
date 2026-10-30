import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runAgent,jobStopState} from '../agent.mjs';

test('connection checks and production both wait for MCP startup without replacing server configuration',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'agent-mcp-startup-'));
  try{
    const fake=path.join(folder,'fixture.mjs'),argsFile=path.join(folder,'args.json');
    await writeFile(fake,`#!/usr/bin/env node
import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));process.stdin.resume();
`);await chmod(fake,0o755);
    for(const action of ['connect','produce']){
      const jobDirectory=path.join(folder,action);await mkdir(jobDirectory);
      const job={action,events:[],toolCalls:[],execution:{model:'gpt-6.1-sol'}};
      const result=await new Promise(resolve=>runAgent({codex:fake,job,context:{run:folder,jobDirectory},event(){},onFinish:resolve,timeoutMs:5000}));
      assert.equal(result.code,0);
      const args=JSON.parse(await readFile(argsFile,'utf8'));
      const overrides=args.flatMap((arg,i)=>arg==='-c'?[args[i+1]]:[]);
      assert.ok(overrides.includes('mcp_optional_startup_grace_ms=0'));
      assert.ok(overrides.every(value=>!value.startsWith('mcp_servers.')&&!value.startsWith('plugins.')));
      assert.equal(args[args.indexOf('--sandbox')+1],action==='connect'?'read-only':'workspace-write');
      assert.equal(args[args.indexOf('--model')+1],'gpt-6.1-sol');
    }
  }finally{await rm(folder,{recursive:true,force:true});}
});

for(const reason of ['timeout','user'])test(`actual process ${reason} preserves a distinct stop reason`,{timeout:10000},async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'agent-stop-test-'));
  try{
    const fake=path.join(folder,'test-only-agent.mjs'),jobDirectory=path.join(folder,'job');await mkdir(jobDirectory);
    // Isolated idle process to exercise termination; never used as a production Agent.
    await writeFile(fake,'#!/usr/bin/env node\nprocess.stdin.resume();setInterval(()=>{},1000);\n');await chmod(fake,0o755);
    const job={action:'plan',events:[]};let controller;
    const finished=new Promise(resolve=>{controller=runAgent({codex:fake,job,context:{run:folder,jobDirectory},event(){},onFinish:resolve,timeoutMs:reason==='timeout'?80:5000});});
    if(reason==='user')setTimeout(()=>controller.cancel(),80);
    const result=await finished;assert.equal(job.cancelRequested,true);assert.equal(job.stopReason,reason);
    const stopped=jobStopState(job);assert.equal(stopped.status,reason==='timeout'?'failed':'cancelled');
    if(reason==='timeout'){assert.match(result.error,/任务超时/);assert.match(stopped.error,/运行时限/);}else assert.match(stopped.error,/本地会话已停止/);
  }finally{await rm(folder,{recursive:true,force:true});}
});

for(const [message,kind,count] of [["The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",'cli_incompatible',1],['yt-dlp is missing','dependency_missing',1],['Connection refused','connection_refused',3]])test(`fatal ${kind} stops the child without waiting for the full task timeout`,{timeout:10000},async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'agent-fast-failure-'));
  try{
    const fake=path.join(folder,'fixture.mjs'),jobDirectory=path.join(folder,'job');await mkdir(jobDirectory);
    const payload=Array.from({length:count},()=>JSON.stringify({type:'error',status:400,error:{type:'invalid_request_error',message}})).join('\n')+'\n';
    await writeFile(fake,`#!/usr/bin/env node
process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(payload)});});setInterval(()=>{},1000);
`);await chmod(fake,0o755);
    const job={action:'discover',events:[]};const started=Date.now();
    const result=await new Promise(resolve=>runAgent({codex:fake,job,context:{run:folder,jobDirectory},event(){},onFinish:resolve,timeoutMs:8000}));
    assert.equal(job.failureKind,kind);assert.ok(Date.now()-started<5000);assert.equal(job.cancelRequested,undefined);assert.ok(result.error);assert.equal(job.stopReason,undefined);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('a final checkpoint is saved before timeout completion, and the checked model is pinned in CLI arguments', {timeout:10000},async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'agent-source-checkpoint-'));
  try{
    const fake=path.join(folder,'fixture.mjs'),jobDirectory=path.join(folder,'job'),checkpoint=path.join(jobDirectory,'source-progress.json'),args=path.join(folder,'args.json');await mkdir(jobDirectory);
    await writeFile(fake,`#!/usr/bin/env node
import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv));process.stdin.resume();process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(checkpoint)},JSON.stringify({sources:[{title:'real fixture URL',url:'https://example.org'}]})));setInterval(()=>{},1000);
`);await chmod(fake,0o755);
    const job={action:'discover',events:[],execution:{model:'gpt-6-astra'}},saved=[];
    await new Promise(resolve=>runAgent({codex:fake,job,context:{run:folder,jobDirectory,sourceProgressPath:checkpoint},event(){},onSourceProgress:async value=>saved.push(value),onFinish:resolve,timeoutMs:1500,progressIntervalMs:5000}));
    assert.equal(job.stopReason,'timeout');assert.equal(saved.length,1);assert.equal(saved[0].sources.length,1);const values=JSON.parse(await readFile(args,'utf8'));assert.equal(values[values.indexOf('--model')+1],'gpt-6-astra');
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('CLI usage is retained and announced before finishing the job', {timeout:10000}, async () => {
  const folder=await mkdtemp(path.join(os.tmpdir(),'agent-usage-test-'));
  try {
    const fake=path.join(folder,'test-only-agent.mjs'),jobDirectory=path.join(folder,'job');await mkdir(jobDirectory);
    const usage={input_tokens:1000,cached_input_tokens:800,output_tokens:100,reasoning_output_tokens:40};
    // Isolated event fixture; it never runs a real Agent or any ChatCut operation.
    await writeFile(fake, '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>{process.stdout.write('+JSON.stringify(JSON.stringify({type:'turn.completed',usage})+'\n')+');});\n');await chmod(fake,0o755);
    const job={action:'plan',events:[]},events=[];
    const result=await new Promise(resolve=>runAgent({codex:fake,job,context:{run:folder,jobDirectory},event(type){events.push({type,usage:job.usage});},onFinish:resolve,timeoutMs:5000}));
    assert.equal(result.code,0);assert.deepEqual(job.usage,usage);
    assert.deepEqual(events.find(e=>e.type==='usage').usage,usage);
  } finally {await rm(folder,{recursive:true,force:true});}
});
