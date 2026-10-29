import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runAgent,jobStopState} from '../agent.mjs';

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
