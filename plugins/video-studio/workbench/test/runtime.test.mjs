import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,rm,readFile,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {compareVersions,inspectCodex,readModelCompatibility,sourceCapabilities,dependencyFailures} from '../runtime.mjs';

test('CLI checks keep working when the installer removes the parent process working directory',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cli-deleted-cwd-'));
  try{
    const cache=path.join(root,'plugin-cache'),stable=path.join(root,'user-data'),fake=path.join(root,'codex.mjs'),log=path.join(root,'cwd.jsonl');await mkdir(cache);await mkdir(stable);
    await writeFile(fake,`#!/usr/bin/env node
import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.cwd())+'\\n');
console.log(process.argv.includes('--version')?'codex-cli 0.164.0':process.argv.includes('login')?'Logged in using fixture':'--ephemeral --json --output-schema --add-dir --approve-for-me');
`);await chmod(fake,0o755);
    const runner=path.join(root,'runner.mjs');await writeFile(runner,`
import {rename,rm} from 'node:fs/promises';import {inspectCodex} from ${JSON.stringify(new URL('../runtime.mjs',import.meta.url).href)};
process.chdir(${JSON.stringify(cache)});await rename(${JSON.stringify(cache)},${JSON.stringify(cache+'-backup')});await rm(${JSON.stringify(cache+'-backup')},{recursive:true});
const result=await inspectCodex({cwd:${JSON.stringify(stable)},env:{...process.env,VIDEO_DEMO_CODEX_BIN:${JSON.stringify(fake)}},modelProbe:async()=>({model:'gpt-6-astra'})});console.log(JSON.stringify(result));
`);
    const response=await promisify(execFile)(process.execPath,[runner],{cwd:root});assert.equal(JSON.parse(response.stdout).compatible,true);
    const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,3);for(const directory of calls)assert.equal(await realpath(directory),await realpath(stable));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('parameter-check failures preserve verified login and report a separate stage without leaking output',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cli-check-failure-'));
  try{
    const file=path.join(root,'codex');await writeFile(file,'fixture');await chmod(file,0o755);
    const env={...process.env,VIDEO_DEMO_CODEX_BIN:file};
    const run=async(binary,args)=>{
      if(args[0]==='exec')throw Object.assign(new Error('private subprocess output'),{cmd:'fixture exec --help',code:1,stderr:'sensitive output'});
      return {stdout:args[0]==='--version'?'codex-cli 0.164.0':'Logged in',stderr:''};
    };
    const result=await inspectCodex({env,cwd:root,run});assert.equal(result.authenticated,true);assert.equal(result.authenticationStatus,'logged_in');assert.equal(result.compatible,false);assert.equal(result.cliCheckFailure.stage,'parameters');assert.match(result.error,/执行参数/);assert.doesNotMatch(JSON.stringify(result),/private subprocess|sensitive output/);
    const timeout=await inspectCodex({env,cwd:root,run:async(binary,args)=>{if(args[0]==='login')throw Object.assign(new Error('timeout'),{killed:true});return {stdout:args[0]==='--version'?'codex-cli 0.164.0':'--ephemeral --json --output-schema --add-dir --approve-for-me',stderr:''};}});
    assert.equal(timeout.authenticationStatus,'unknown');assert.equal(timeout.cliCheckFailure.kind,'timeout');assert.match(timeout.error,/登录状态检查超时/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('version checks compare numeric and prerelease components without accepting unknown versions',()=>{
  assert.ok(compareVersions('codex-cli 0.164.0-alpha.11.1','0.153.0')>0);
  assert.ok(compareVersions('0.164.0-alpha.11','0.164.0-alpha.9')>0);
  assert.ok(compareVersions('0.164.0-alpha.11','0.164.0')<0);
  assert.throws(()=>compareVersions('codex-cli unknown','0.153.0'));
});

test('CLI without automatic review support is rejected before creating a model session',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cli-review-support-'));
  try{
    const fake=path.join(root,'codex');await writeFile(fake,'fixture');await chmod(fake,0o755);
    let modelProbes=0;
    const result=await inspectCodex({cwd:root,env:{...process.env,VIDEO_DEMO_CODEX_BIN:fake},run:async(binary,args)=>({stdout:args[0]==='--version'?'codex-cli 0.164.0':args[0]==='login'?'Logged in':'--ephemeral --json --output-schema --add-dir',stderr:''}),modelProbe:async()=>{modelProbes++;return {model:'gpt-6.1-sol'};}});
    assert.equal(result.authenticated,true);assert.equal(result.compatible,false);assert.equal(modelProbes,0);
    assert.deepEqual(result.cliCheckFailure,{stage:'parameters',kind:'missing_flags',missing:['--approve-for-me']});assert.match(result.error,/--approve-for-me/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the actual newer executable is selected, while an explicitly pinned old CLI is blocked',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cli-select-'));
  try{
    for(const folder of ['old','new']){await mkdir(path.join(root,folder));const file=path.join(root,folder,'codex');await writeFile(file,'fixture only');await chmod(file,0o755);}
    const env={PATH:[path.join(root,'old'),path.join(root,'new')].join(path.delimiter)};
    const run=async(file,args)=>({stdout:args[0]==='--version'?file.includes('/old/')?'codex-cli 0.100.0':'codex-cli 0.164.0':args[0]==='login'?'Logged in':'--ephemeral --json --output-schema --add-dir --approve-for-me',stderr:''});
    let probes=0;const modelProbe=async()=>{probes++;return {model:'gpt-6-astra'};};
    const current=await inspectCodex({env,platform:'linux',run,modelProbe});assert.equal(current.compatible,true);assert.equal(current.codexPath,await realpath(path.join(root,'new/codex')));assert.equal(current.model,'gpt-6-astra');assert.equal(probes,1);
    const pinned=await inspectCodex({env:{...env,VIDEO_DEMO_CODEX_BIN:path.join(root,'old/codex')},platform:'linux',run,modelProbe});assert.equal(pinned.compatible,false);assert.match(pinned.error,/版本不满足/);assert.equal(probes,1);
    const tooNew=await inspectCodex({env,platform:'linux',run,modelProbe:async()=>({model:'gpt-6-astra',minimumVersion:'0.170.0'})});assert.equal(tooNew.compatible,false);assert.match(tooNew.error,/0.170.0/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('model compatibility uses read-only protocol, respects configured model and rejects an unavailable one',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cli-model-probe-'));
  try{
    const file=path.join(root,'fixture.mjs'),log=path.join(root,'methods.jsonl');
    await writeFile(file,`#!/usr/bin/env node
import fs from 'node:fs';
let buffer='';process.stdin.on('data',block=>{buffer+=block;let i;while((i=buffer.indexOf('\\n'))>=0){const request=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(request.method)+'\\n');if(!request.id)continue;
const result=request.method==='config/read'?{config:{model:process.env.FIXTURE_MODEL||'gpt-6-astra'}}:request.method==='model/list'?{data:[{model:'gpt-6-astra',id:'gpt-6-astra',isDefault:false}],nextCursor:null}:{};console.log(JSON.stringify({id:request.id,result}));}});
`);await chmod(file,0o755);
    const result=await readModelCompatibility(file,{cwd:root});assert.equal(result.model,'gpt-6-astra');
    await assert.rejects(readModelCompatibility(file,{cwd:root,env:{...process.env,FIXTURE_MODEL:'unavailable-model'}}),/不会自动更换模型/);
    const methods=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(methods.every(method=>['initialize','initialized','config/read','model/list'].includes(method)));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('capabilities follow the actual source and missing optional tools do not block cached or repository media',()=>{
  assert.deepEqual(sourceCapabilities({sourceType:'x_repository'}),['python','media','repository']);
  assert.deepEqual(sourceCapabilities({sourceType:'x_repository'},{direct:true}),['python','media','repository_media']);
  assert.deepEqual(sourceCapabilities({sourceType:'official',url:'https://youtu.be/actual'}),['python','media','downloader']);
  const report={checks:[{id:'python',ok:true},{id:'media',ok:true},{id:'repository',ok:true},{id:'downloader',ok:false}]};
  assert.deepEqual(dependencyFailures(report,sourceCapabilities({sourceType:'x_repository'})),[]);
  assert.equal(dependencyFailures(report,['python','media','downloader'])[0].id,'downloader');
});
