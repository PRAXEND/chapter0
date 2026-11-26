// Uses the actual bundled App Server with a Responses fixture bound to loopback.
// Pass the copy of codex to test; no endpoints, accounts or chats from the machine are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CodexClient} from '../src/codex.mjs';

const binary=process.env.VIDEO_STUDIO_TEST_CODEX;
const optional={skip:binary?false:'set VIDEO_STUDIO_TEST_CODEX to the bundled Codex executable',timeout:90_000};
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');

function offlineLaunch(binary,desktopOrigin=false){
  return (args,cwd,env)=>{
    const unreachable='http://127.0.0.1:1';
    env={...env,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'};
    for(const name of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy'])env[name]=unreachable;
    for(const name of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','OPENAI_ORG_ID','OPENAI_PROJECT_ID'])delete env[name];
    if(desktopOrigin)env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE='Codex Desktop';
    return spawn(binary,args,{cwd,env,stdio:['pipe','pipe','pipe']});
  };
}

async function endpoint(t) {
  let calls=0;
  const server=http.createServer(async(req,res)=>{
    for await(const _part of req){} // Consume synthetic requests without recording their payloads.
    if(req.method!=='POST'||req.url!=='/v1/responses'){res.writeHead(404).end();return;}
    calls++;
    const item={type:'message',id:'msg_'+calls,role:'assistant',status:'completed',content:[{type:'output_text',text:'offline fixture',annotations:[]}]};
    const response={id:'resp_'+calls,object:'response',created_at:1,model:'gpt-5.4',status:'completed',output:[item],usage:{input_tokens:2,output_tokens:2,total_tokens:4}};
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const send=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
    send('response.created',{response:{...response,status:'in_progress',output:[]}});
    send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});
    send('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:'offline fixture'});
    send('response.output_item.done',{output_index:0,item});
    send('response.completed',{response});
    res.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  return {url:'http://127.0.0.1:'+server.address().port+'/v1',calls:()=>calls};
}

test('installed App Server keeps first-cut, review, restart and continued legacy turns out of the desktop thread list',optional,async t=>{
  const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'studio-offline-accounts-')));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const desk=path.join(dir,'desktop'),studio=path.join(dir,'studio'),empty=path.join(dir,'empty');
  const origin=await endpoint(t);
  const config='model="gpt-5.4"\nmodel_provider="test"\n[model_providers.test]\nname="offline"\nbase_url="'+origin.url+'"\nwire_api="responses"\nsupports_websockets=false\n';
  for(const folder of [desk,studio]){await mkdir(folder,{mode:0o700});await writeFile(path.join(folder,'config.toml'),config);}
  await writeFile(path.join(desk,'auth.json'),JSON.stringify({OPENAI_API_KEY:'synthetic-offline-test-identity'}),{mode:0o600});
  const clients=[];
  const make=(shared,folder,cwd,old=false)=>{
    const client=new CodexClient({home:folder,desktopHome:shared,directory:cwd,launch:offlineLaunch(binary,old)});
    clients.push(client);return client;
  };
  t.after(()=>{for(const c of clients)c.close();});
  const message=async(c,id)=>{
    let turnId;
    assert.equal(await c.runTurn({threadId:id,prompt:'Synthetic sidebar integration test.',tool:()=>assert.fail('no tools'),onStart:t=>{turnId=t;},signal:AbortSignal.timeout(10000)}),'offline fixture');
    assert.ok(turnId);
    return turnId;
  };
  const create=async(c)=>{
    const id=await c.thread(null,[],'Respond once in the local test.',{model:'gpt-5.4'});
    const turn=await message(c,id);
    const {thread}=await c.request('thread/read',{threadId:id,includeTurns:false});
    return {id,turn,thread};
  };
  const list=async c=>(await c.request('thread/list',{limit:100})).data.map(r=>r.id);
  const old=make(empty,desk,undefined,true), legacy=await create(old);old.close();
  assert.equal(legacy.thread.originator,'Codex Desktop');
  const desktopCwd=path.join(dir,'manual-project');
  const normal=make(empty,desk,desktopCwd,true), user=await create(normal);normal.close();
  const before=await hash(legacy.thread.path), userBefore=await hash(user.thread.path);
  const c=make(desk,studio), a=await create(c), b=await create(c);
  assert.equal(a.thread.originator,'video_studio');
  assert.notEqual(a.id,b.id);assert.equal(c.profile.accountSource,'desktop-file');
  c.close();
  const reopened=make(desk,studio);
  for(const {id,turn} of [a,b]){
    assert.equal(await reopened.thread(id,[],'Resume the isolated test.',{}),id);
    assert.equal((await reopened.findTurn(id,turn)).turn.status,'completed');
    assert.ok((await list(reopened)).includes(id));
  }
  const desktop=make(empty,desk,desktopCwd);
  await desktop.connect();
  const visible=await list(desktop);
  assert.ok(visible.includes(legacy.id)&&visible.includes(user.id));
  for(const {id} of [a,b]){
    assert.ok(!visible.includes(id));
    await assert.rejects(desktop.request('thread/read',{threadId:id,includeTurns:false}),/not loaded|no rollout|not found/);
  }
  const noCharge=origin.calls();
  await assert.rejects(reopened.thread(user.id,[],'',{}, {allowLegacy:true}),/工作台身份/);
  await assert.rejects(reopened.thread(legacy.id,[],'',{}, {allowLegacy:true,legacyTurnId:randomUUID()}),/核对旧任务/);
  await assert.rejects(reopened.thread(randomUUID(),[],'',{}, {allowLegacy:true}),/not loaded|no rollout|not found/);
  assert.equal(origin.calls(),noCharge);
  assert.equal(await reopened.thread(legacy.id,[],'Continue registered project.',{}, {allowLegacy:true,legacyTurnId:legacy.turn}),legacy.id);
  assert.equal((await reopened.findTurn(legacy.id,legacy.turn)).turn.status,'completed');
  const signed=await reopened.request('thread/read',{threadId:legacy.id,includeTurns:false});
  assert.ok((await realpath(signed.thread.path)).startsWith(studio+path.sep));
  const localTurn=await message(reopened,legacy.id);
  assert.equal((await reopened.findTurn(legacy.id,localTurn)).turn.status,'completed');
  assert.equal((await desktop.findTurn(legacy.id,localTurn)).turn,null);
  assert.equal(await hash(legacy.thread.path),before);
  assert.equal(await hash(user.thread.path),userBefore);
  assert.ok((await list(desktop)).includes(legacy.id));
  assert.equal(origin.calls(),5);
});

test('official account/read shares the signed-in file identity and the connect button cannot replace the desktop login',optional,async t=>{
  const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'studio-test-offline-auth-')));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const desk=path.join(dir,'desktop'), auth=path.join(desk,'auth.json');
  await mkdir(desk,{mode:0o700});await writeFile(auth,JSON.stringify({OPENAI_API_KEY:'synthetic-file-only-no-inference'}),{mode:0o600});
  const before=await hash(auth), c=new CodexClient({home:path.join(dir,'studio'),desktopHome:desk,launch:offlineLaunch(binary)});
  t.after(()=>c.close());
  assert.deepEqual(await c.account(),{available:true,connected:true,accountType:'apiKey',accountSource:'desktop-file'});
  const status=await c.login();assert.equal(status.connected,true);assert.equal(status.authUrl,undefined);
  assert.equal(await hash(auth),before);
  const {data}=await c.request('thread/list',{limit:10});assert.ok(!data.length);
});
