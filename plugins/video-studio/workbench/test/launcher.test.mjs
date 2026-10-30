import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {workbenchDataDirectory} from '../paths.mjs';
import {ensureWorkbench} from '../launcher.mjs';

test('default workbench data stays outside versioned plugin code',()=>{
  assert.equal(workbenchDataDirectory({},'/test-user','darwin'),'/test-user/Library/Application Support/Video Studio/workbench');
  assert.equal(workbenchDataDirectory({XDG_DATA_HOME:'/test-data'},'/test-user','linux'),'/test-data/Video Studio/workbench');
  assert.equal(workbenchDataDirectory({VIDEO_STUDIO_WEB_DATA:'/existing-projects'},'/test-user','darwin'),'/existing-projects');
});

test('plugin launcher starts the actual bundled server and reuses it without creating a task',{timeout:30000},async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'plugin-workbench-launch-'));
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const env={...process.env,PORT:String(port),VIDEO_STUDIO_WEB_DATA:path.join(directory,'data'),VIDEO_STUDIO_HOME:path.join(directory,'profile'),VIDEO_DEMO_CODEX_BIN:path.join(directory,'no-codex')};
  let launched;
  try {
    launched=await ensureWorkbench({env});assert.equal(launched.reused,false);assert.ok(launched.pid);
    const again=await ensureWorkbench({env});assert.equal(again.reused,true);assert.equal(again.url,launched.url);
    const state=await (await fetch(again.url+'/api/state')).json();assert.equal(state.project.jobs.length,0);assert.equal(state.project.topic,'');
    const health=await (await fetch(again.url+'/api/health')).json();assert.equal(await realpath(health.workingDirectory),await realpath(env.VIDEO_STUDIO_WEB_DATA));
    assert.equal((await fetch(again.url+'/token-usage-view.js')).status,200);
    await assert.rejects(ensureWorkbench({env:{...env,VIDEO_STUDIO_WEB_DATA:path.join(directory,'other')}}),/另一个数据目录/);
  } finally {if(launched?.pid)process.kill(launched.pid,'SIGTERM');await delay(150);await rm(directory,{recursive:true,force:true});}
});

test('launcher refuses an unrelated service on the requested port',async()=>{
  const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{"app":"something-else"}');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {await assert.rejects(ensureWorkbench({env:{PORT:String(server.address().port)}}),/其他服务占用/);}
  finally {await new Promise(r=>server.close(r));}
});
