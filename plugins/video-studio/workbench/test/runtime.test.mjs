import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,rm,readFile,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {compareVersions,inspectCodex,readModelCompatibility,sourceCapabilities,dependencyFailures} from '../runtime.mjs';

test('version checks compare numeric and prerelease components without accepting unknown versions',()=>{
  assert.ok(compareVersions('codex-cli 0.164.0-alpha.11.1','0.153.0')>0);
  assert.ok(compareVersions('0.164.0-alpha.11','0.164.0-alpha.9')>0);
  assert.ok(compareVersions('0.164.0-alpha.11','0.164.0')<0);
  assert.throws(()=>compareVersions('codex-cli unknown','0.153.0'));
});

test('the actual newer executable is selected, while an explicitly pinned old CLI is blocked',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cli-select-'));
  try{
    for(const folder of ['old','new']){await mkdir(path.join(root,folder));const file=path.join(root,folder,'codex');await writeFile(file,'fixture only');await chmod(file,0o755);}
    const env={PATH:[path.join(root,'old'),path.join(root,'new')].join(path.delimiter)};
    const run=async(file,args)=>({stdout:args[0]==='--version'?file.includes('/old/')?'codex-cli 0.100.0':'codex-cli 0.164.0':args[0]==='login'?'Logged in':'--ephemeral --json --output-schema --add-dir',stderr:''});
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
  assert.deepEqual(sourceCapabilities({sourceType:'official',url:'https://youtu.be/actual'}),['python','media','downloader']);
  const report={checks:[{id:'python',ok:true},{id:'media',ok:true},{id:'repository',ok:true},{id:'downloader',ok:false}]};
  assert.deepEqual(dependencyFailures(report,sourceCapabilities({sourceType:'x_repository'})),[]);
  assert.equal(dependencyFailures(report,['python','media','downloader'])[0].id,'downloader');
});
