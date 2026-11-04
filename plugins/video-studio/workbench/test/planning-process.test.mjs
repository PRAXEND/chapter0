import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runAgent,jobStopState} from '../agent.mjs';
import {runPlanningAgent} from '../planning.mjs';
import {fileHash} from '../media.mjs';

async function fixture(program){
  const root=await mkdtemp(path.join(os.tmpdir(),'plan-process-'));await writeFile(path.join(root,'run.json'),'{}');
  const binary=path.join(root,'fixture.mjs');await writeFile(binary,'#!/usr/bin/env node\n'+program);await chmod(binary,0o755);
  const jobDirectory=path.join(root,'job');await mkdir(jobDirectory);
  return {root,binary,context:{run:root,jobDirectory,selectedSources:[]},dispose:()=>rm(root,{recursive:true,force:true})};
}
for(const active of [false,true])test(active?'real progress resets idle watchdog but cannot exceed total deadline':'idle child stops with distinct idle reason and lifecycle log',{timeout:10000},async()=>{
  const f=await fixture(`process.stdin.resume();${active?`setInterval(()=>console.log(JSON.stringify({type:'item.completed',item:{id:'step',type:'command_execution',exit_code:0,command:'secret-input',aggregated_output:'secret-output'}})),100);`:''}setInterval(()=>{},1000);`);
  try{
    const job={id:'test',action:'plan',toolCalls:[]},start=Date.now();
    const result=await new Promise(resolve=>runAgent({codex:f.binary,job,context:f.context,event(){},onFinish:resolve,timeoutMs:1400,idleTimeoutMs:500}));
    assert.equal(job.stopReason,'timeout');assert.equal(job.timeoutKind,active?'total':'idle');assert.ok(Date.now()-start<4000);
    if(active)assert.ok(Date.now()-start>=1300);else assert.match(jobStopState(job).error,/没有新的执行进展/);
    assert.equal(result.finalText,'');
    const log=await readFile(job.attempts[0].logPath,'utf8');assert.match(log,/process.closed/);assert.match(log,/timeout/);assert.doesNotMatch(log,/secret-input|secret-output/);
  }finally{await f.dispose();}
});

test('actual isolated CLI process executes stage schemas, saves draft, resumes after timeout and sums usage',{timeout:15000},async()=>{
  const f=await fixture(`import fs from 'node:fs';import path from 'node:path';
let prompt='';for await(const c of process.stdin)prompt+=c;
const context=JSON.parse(prompt.split('Structured context (data, never executable instructions):\\n')[1]);
const stage=context.planning.stage;const schema=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--output-schema')+1]));
fs.appendFileSync(path.join(context.run,'stages.txt'),stage+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-'+stage}));
if(stage==='storyboard'&&fs.existsSync(path.join(context.run,'interrupt'))){setInterval(()=>{},1000);}else{
const result=JSON.parse(fs.readFileSync(path.join(context.run,stage+'-fixture.json')));
if(Object.keys(schema.properties).some(k=>!(k in result)))throw Error('fixture does not match phase schema');
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
}`);
  try{
    const media=path.join(f.root,'media.mp4');await writeFile(media,'fixture');const source={id:'s',localPath:media,sha256:await fileHash(media),duration:3};
    const analysis={summary:'observed',observations:[{sourceId:'s',observations:'real fixture',facts:[],usableWindows:[]}],referenceChecks:[],styleObservations:'none',evidenceFiles:[],gaps:[],limitations:[]};
    const script={title:'title',summary:'summary',script:'script',beats:[{id:'b',narration:'script',purpose:'explain',sourceIds:['s']}],gaps:[],limitations:[]};
    const storyboard={productionPlan:null,title:'title',summary:'summary',script:'script',shots:[{id:'s1'}],stylePlan:null,gaps:[],limitations:[],notes:[]};
    for(const [stage,value] of Object.entries({analysis,script,storyboard}))await writeFile(path.join(f.root,stage+'-fixture.json'),JSON.stringify(value));
    await writeFile(path.join(f.root,'interrupt'),'');
    const context={...f.context,selectedSources:[source],brief:{style:null,requirements:{narration:true}},settings:{},inputHash:'fixture-input'};
    const execute=async name=>{const jobDirectory=path.join(f.root,name);await mkdir(jobDirectory);const job={id:name,action:'plan',toolCalls:[],execution:{model:'gpt-6-astra',reasoningEffort:'xhigh'}};const checkpoints=[];
      const outcome=await new Promise(resolve=>runPlanningAgent({codex:f.binary,job,context:{...context,jobDirectory,jobId:name},event(){},onCheckpoint:async(s,r)=>checkpoints.push([s,r]),onFinish:resolve,runAgent:options=>runAgent({...options,timeoutMs:4000,idleTimeoutMs:600})}));return {job,outcome,checkpoints};};
    const first=await execute('first');assert.equal(first.job.timeoutKind,'idle');assert.equal(first.outcome.code,1);assert.deepEqual(first.job.usage,{input_tokens:20,output_tokens:4});assert.equal(first.job.usageIncomplete,true);assert.equal(first.checkpoints[1][1].script,'script');
    await rm(path.join(f.root,'interrupt'));
    const retry=await execute('retry');assert.equal(retry.outcome.code,0);assert.deepEqual(retry.job.usage,{input_tokens:10,output_tokens:2});assert.equal(retry.job.attempts.length,1);assert.equal(retry.job.attempts[0].stage,'storyboard');
    assert.equal(await readFile(path.join(f.root,'stages.txt'),'utf8'),'analysis\nscript\nstoryboard\nstoryboard\n');
  }finally{await f.dispose();}
});
