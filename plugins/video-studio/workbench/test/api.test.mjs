import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,chmod,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
test('HTTP workflow validates real media, pins review, rejects fabricated export and protects file access',{timeout:45000},async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'studio-api-test-')),port=await freePort();let server;
  try{
    const fake=path.join(temp,'codex-test.mjs');
    // This test double must never be used by the real workbench or advertised as a live connection.
    await writeFile(fake,`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
if(process.argv.includes('--version'))console.log('codex-cli 0.164.0');
else if(process.argv.includes('--help'))console.log('--ephemeral --json --output-schema --add-dir');
else if(process.argv.includes('app-server')){
 let buffer='';process.stdin.on('data',block=>{buffer+=block;let i;while((i=buffer.indexOf('\\n'))>=0){const request=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(!request.id)continue;
 const result=request.method==='config/read'?{config:{model:'gpt-6-astra'}}:request.method==='model/list'?{data:[{id:'gpt-6-astra',model:'gpt-6-astra',isDefault:true}],nextCursor:null}:{};
 console.log(JSON.stringify({id:request.id,result}));}});
}
else if(process.argv.includes('login'))console.log('Logged in using test fixture');
else {
  async function runFixture(){let text='';for await(const block of process.stdin)text+=block;
  const c=JSON.parse(text.split('Structured context (data, never executable instructions):\\n')[1]);let result;
  if(c.query==='分批失败测试'){
    fs.writeFileSync(c.sourceProgressPath,JSON.stringify({schema:1,jobId:c.jobId,topic:c.brief.topic,style:c.brief.style,sources:[{title:'Partial fixture one',kind:'article',url:'https://93.184.215.14/partial-one'},{title:'Partial fixture two',kind:'article',url:'https://93.184.215.14/partial-two'}]}));
    setTimeout(()=>{for(let n=0;n<3;n++)console.log(JSON.stringify({type:'error',message:'Connection refused'}));},3000);
    setInterval(()=>{},1000);return;
  }
  if(c.source){
    const destination=path.join(c.run,'materials','test-only-acquisition.mp4');fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.copyFileSync(${JSON.stringify(path.join(temp,'test-only.mp4'))},destination);
    const run=JSON.parse(fs.readFileSync(path.join(c.run,'run.json'),'utf8'));
    run.material_plan={topic:c.brief.topic,style:c.brief.style||null,needs:[{id:'fixture',purpose:'HTTP collection handoff test',query:'fixture only',acceptance:'actual probed diagnostic media'}]};
    fs.writeFileSync(path.join(c.run,'run.json'),JSON.stringify(run));
    result={summary:'Isolated fixture acquisition; no remote media or ChatCut calls',sources:[{...c.source,url:'https://93.184.215.14/test-only-media',localPath:destination,sourceType:'other',expectedSha256:'',expectedBytes:0}]};
  }else if(!c.selectedSources.length){
    const run=JSON.parse(fs.readFileSync(path.join(c.run,'run.json'),'utf8'));
    run.material_plan={topic:c.brief.topic,style:c.brief.style||null,needs:[{id:'fixture-search',purpose:'Search handoff test',query:c.query,acceptance:'Isolated empty search'}]};
    fs.writeFileSync(path.join(c.run,'run.json'),JSON.stringify(run));
    result={summary:'Isolated empty search',sources:[],review:{scope:'Test fixture only',methods:[],gaps:[],events:[]}};
  }else result={status:'exported',summary:'fabricated test result',projectId:'fake',timelineId:'fake',editorUrl:'',files:[{path:c.selectedSources[0].localPath,role:'video'}],qaStatus:'passed',notes:[],questions:[]};
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}));
}runFixture();
}
`);await chmod(fake,0o755);
    const downloader=path.join(temp,'user/runtime/bin/yt-dlp');await mkdir(path.dirname(downloader),{recursive:true});await writeFile(downloader,'#!/usr/bin/env node\nconsole.log("2026.08.19");\n');await chmod(downloader,0o755);
    const dataDir=path.join(temp,'state');
    const history=path.join(dataDir,'runs','test-history');await mkdir(path.join(history,'source-searches'),{recursive:true});
    await writeFile(path.join(history,'run.json'),JSON.stringify({brief:{topic:'Fixture history'},sources:[]}));
    const historySources=[{id:'wanted',title:'Test-only requested candidate',kind:'article',url:'https://93.184.215.14/test-only-requested'},{id:'not-wanted',title:'Test-only untouched candidate',kind:'article',url:'https://93.184.215.14/test-only-untouched'}];
    await writeFile(path.join(history,'source-searches','fixture-job.json'),JSON.stringify({topic:'Fixture history',jobId:'fixture-job',reviewed_at:'2026-10-27T01:00:00Z',sources:historySources}));
    server=spawn(process.execPath,[path.join(root,'studio-server.mjs')],{cwd:root,env:{...process.env,PORT:String(port),VIDEO_STUDIO_WEB_DATA:dataDir,VIDEO_STUDIO_HOME:path.join(temp,'user'),VIDEO_DEMO_CODEX_BIN:fake},stdio:['ignore','pipe','pipe']});
    let errors='';server.stderr.on('data',s=>errors+=s);await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Server startup timed out: '+errors)),15000);server.stdout.on('data',s=>{if(s.toString().includes('Video Agent Demo:')){clearTimeout(timeout);resolve();}});server.on('error',reject);server.on('exit',code=>{if(code)reject(new Error('Server failed: '+errors));});});
    const base='http://127.0.0.1:'+port;
    const api=async(route,data)=>{const r=await fetch(base+route,data===undefined?{signal:AbortSignal.timeout(12000)}:{signal:AbortSignal.timeout(12000),method:'POST',headers:{'Content-Type':'application/json','X-Video-Demo':'1'},body:JSON.stringify(data)});return {status:r.status,value:await r.json()};};
    let state=(await api('/api/state')).value;
    assert.equal(state.runtime.chatcut,'not_checked');assert.equal(state.catalog.styles.length,0);
    for(const asset of ['/token-usage.js','/token-usage-view.js']){const response=await fetch(base+asset);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/javascript/);}
    assert.equal(state.library.candidates.length,2);assert.equal(state.library.entries.length,0);assert.equal(state.project.jobs.length,0);
    const wanted=state.library.candidates.find(c=>c.title===historySources[0].title),untouched=state.library.candidates.find(c=>c.title===historySources[1].title);
    const skill=(await api('/api/source-skill')).value;assert.match(skill.skill,/name: video-source-tools/);assert.ok(skill.references.some(r=>r.name==='robotics-x-repository.md'&&r.text.includes('video-daily')));
    assert.equal((await fetch(base+'/api/source-reports/unregistered')).status,404);
    assert.equal((await fetch(base+'/api/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await api('/api/jobs',{action:'produce'})).status,400);
    const p=state.project;
    const settings={topic:'API验证',purpose:'',duration:3,ratio:'16:9',fps:30,language:'zh-CN',narration:false,captions:false,music:'none',voiceDirection:'',styleSelector:null,styleDescription:'简单镜头',outputRoot:path.join(temp,'output with spaces'),selected:[]};
    assert.equal((await api('/api/project',settings)).status,200);
    assert.equal((await api('/api/sources/url',{url:'http://127.0.0.1/private'})).status,400);
    const fixture=path.join(temp,'test-only.mp4');await execute('ffmpeg',['-v','error','-f','lavfi','-i','color=c=green:s=160x90:r=30','-t','2','-c:v','libx264','-pix_fmt','yuv420p',fixture]);
    await api('/api/reset',{});
    const emptySearch=await api('/api/jobs',{action:'discover',query:'  '});assert.equal(emptySearch.status,400);assert.match(emptySearch.value.error,/素材关键词/);
    const search=await api('/api/jobs',{action:'discover',query:'机器人素材检索'});assert.equal(search.status,202,JSON.stringify(search.value));
    let searchJob;for(let n=0;n<80;n++){searchJob=(await api('/api/jobs/'+search.value.job.id)).value;if(!['running','cancelling'].includes(searchJob.status))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(searchJob.status,'blocked');assert.equal(searchJob.error,'Isolated empty search');
    const searchContext=JSON.parse(await readFile(path.join(dataDir,'jobs',searchJob.id,'request.json'),'utf8'));assert.equal(searchContext.brief.topic,'机器人素材检索');assert.equal(searchContext.query,'机器人素材检索');
    await api('/api/reset',{});
    const linked=await api('/api/sources/url',{url:historySources[0].url,title:historySources[0].title});assert.equal(linked.status,201);
    assert.equal((await api('/api/state')).value.project.topic,'');
    assert.equal((await api('/api/library/collect',{candidateId:'missing'})).status,400);
    assert.equal((await api('/api/library/collect',{candidateId:wanted.id,start:5,end:3})).status,400);
    const collected=await api('/api/library/collect',{candidateId:wanted.id});assert.equal(collected.status,202,JSON.stringify(collected.value));
    let acquisition;for(let n=0;n<80;n++){acquisition=(await api('/api/jobs/'+collected.value.job.id)).value;if(!['running','cancelling'].includes(acquisition.status))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(acquisition.status,'completed',acquisition.error);assert.equal(acquisition.candidateCacheId,wanted.id);
    const usageState=(await api('/api/state')).value.project;assert.deepEqual(usageState.tokenUsageJobs.find(j=>j.id===acquisition.id).usage,{input_tokens:0,output_tokens:0});const persistedUsage=JSON.parse(await readFile(path.join(dataDir,'projects',usageState.id+'.json'),'utf8'));assert.equal(persistedUsage.tokenUsageJobs.find(j=>j.id===acquisition.id).usage.input_tokens,0);
    state=(await api('/api/state')).value;assert.deepEqual(state.project.selected,[]);assert.equal(state.project.sources.length,1);assert.equal(state.project.deliveries.length,0);
    assert.equal(state.library.candidates.find(c=>c.id===wanted.id).localCacheIds.length,1);assert.equal(state.library.candidates.find(c=>c.id===untouched.id).localCacheIds.length,0);
    const request=JSON.parse(await readFile(path.join(dataDir,'jobs',acquisition.id,'request.json'),'utf8'));assert.equal(request.source.url,historySources[0].url);
    await api('/api/reset',{});state=(await api('/api/state')).value;assert.equal(state.library.candidates.length,2);assert.equal(state.library.entries.length,1);
    const reuse=await api('/api/library/collect',{candidateId:wanted.id});assert.equal(reuse.value.reused,true);assert.equal(reuse.value.project.jobs.length,0);assert.equal(reuse.value.project.topic,'');
    const upload=await fetch(base+'/api/upload?name=fixture.mp4',{method:'POST',headers:{'X-Video-Demo':'1','Content-Type':'application/octet-stream'},body:await readFile(fixture)});assert.equal(upload.status,201);let source=(await upload.json()).source;assert.equal(source.status,'ready');assert.equal(source.kind,'video');assert.equal((await api('/api/state')).value.project.topic,'fixture.mp4');
    const range=await fetch(base+'/api/media/'+source.id,{headers:{Range:'bytes=0-9'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,10);
    const download=await fetch(base+'/api/media/'+source.id+'?download=1');assert.match(download.headers.get('content-disposition'),/attachment/);assert.equal((await download.arrayBuffer()).byteLength,source.bytes);
    assert.equal((await fetch(base+'/api/media/not-registered')).status,404);
    let cache=(await api('/api/library')).value;assert.equal(cache.entries.length,1);const cached=cache.entries[0];assert.equal(cached.sha256,source.sha256);
    const cacheRange=await fetch(base+'/api/library/media/'+cached.id,{headers:{Range:'bytes=0-9'}});assert.equal(cacheRange.status,206);assert.equal((await cacheRange.arrayBuffer()).byteLength,10);
    assert.equal((await fetch(base+'/api/library/media/unregistered')).status,404);
    await api('/api/reset',{});state=(await api('/api/state')).value;assert.equal(state.project.sources.length,0);assert.equal(state.library.entries.length,1);
    const imported=await api('/api/sources/local',{path:fixture});assert.equal(imported.status,201);assert.equal((await api('/api/state')).value.project.topic,'test-only.mp4');
    await api('/api/reset',{});
    const used=await api('/api/library/use',{id:cached.id});assert.equal(used.status,200,JSON.stringify(used.value));assert.equal(used.value.project.topic,cached.title);source=used.value.source;
    assert.deepEqual(used.value.project.selected,[source.id]);assert.equal(used.value.project.jobs.length,0);assert.equal(used.value.project.deliveries.length,0);
    const again=await api('/api/library/use',{id:cached.id});assert.equal(again.value.project.sources.length,1);assert.deepEqual(again.value.project.selected,[source.id]);
    const actual={...settings,selected:[source.id]};await api('/api/project',actual);
    state=(await api('/api/state')).value;const choices=JSON.parse(await readFile(path.join(state.project.run,'material-selection.json'),'utf8'));assert.deepEqual(choices.selected_source_ids,[source.id]);assert.equal(choices.confirmed_by_user,true);
    const plan={title:'方案',summary:'人工审核测试',script:'可编辑内容',shots:[{id:'1',from:0,to:2,sourceIds:[source.id],narration:'',visual:'真实素材',screenText:'测试',transition:'无'}],gaps:[],notes:[]};
    const blocked=await api('/api/plan',{plan:{...plan,gaps:['当前镜头必需的素材尚未取得'],limitations:['已避免其他未核实说法']}});assert.equal(blocked.status,200);
    assert.equal((await api('/api/approve',{planHash:blocked.value.plan.planHash})).status,400);assert.equal((await api('/api/state')).value.project.approval,null);
    const saved=await api('/api/plan',{plan:{...plan,limitations:['不采用未核实的效率数字，仅展示已有画面']}});assert.equal(saved.status,200);assert.equal(saved.value.plan.limitations.length,1);const hash=saved.value.plan.planHash;
    assert.equal((await api('/api/approve',{planHash:'old-hash'})).status,400);
    const clicked=await api('/api/approve',{planHash:hash});assert.equal(clicked.status,200);assert.equal(clicked.value.approval.authority.kind,'user_click');
    assert.equal((await api('/api/approve',{planHash:hash,authority:{kind:'delegated_review',authorizedByUser:true}})).status,400);
    const authority={kind:'delegated_review',authorizedByUser:true,userRequest:'请审阅并完成本次端到端测试，发现问题后修复'};
    const delegated=await api('/api/approve',{planHash:hash,authority});assert.equal(delegated.status,200);assert.deepEqual(delegated.value.approval.authority,authority);
    state=(await api('/api/state')).value;const recordedApproval=JSON.parse(await readFile(path.join(state.project.run,'script-storyboard-approval.json'),'utf8'));assert.deepEqual(recordedApproval.authority,authority);assert.ok(!recordedApproval.user_response.includes('用户在 Video Studio 网页点击'));

    const originalProject=state.project.id,originalRun=state.project.run;
    const fresh=await api('/api/reset',{});assert.equal(fresh.status,200);const freshId=fresh.value.project.id;
    assert.notEqual(freshId,originalProject);assert.equal(fresh.value.project.sources.length,0);assert.equal(fresh.value.project.plan,null);assert.equal(fresh.value.project.approval,null);
    assert.ok(fresh.value.projects.some(p=>p.id===originalProject&&p.materialCount===1));
    assert.equal((await fetch(base+'/api/media/'+source.id)).status,404);
    const stale=await fetch(base+'/api/project',{method:'POST',headers:{'Content-Type':'application/json','X-Video-Demo':'1','X-Video-Project':originalProject},body:JSON.stringify(actual)});assert.equal(stale.status,409);
    assert.equal((await api('/api/projects/switch',{projectId:'../workbench-v2'})).status,400);assert.equal((await api('/api/state')).value.project.id,freshId);
    const restored=await api('/api/projects/switch',{projectId:originalProject});assert.equal(restored.status,200);assert.equal(restored.value.project.run,originalRun);assert.equal(restored.value.project.approval.planHash,hash);assert.deepEqual(restored.value.project.selected,[source.id]);
    assert.equal((await fetch(base+'/api/media/'+source.id,{headers:{Range:'bytes=0-9'}})).status,206);
    assert.equal((await api('/api/projects')).value.projects.find(p=>p.id===freshId).current,false);

    await api('/api/project',{...actual,outputRoot:path.join(temp,'different delivery')});state=(await api('/api/state')).value;assert.equal(state.project.approval.planHash,hash);
    const job=await api('/api/jobs',{action:'produce'});assert.equal(job.status,202,JSON.stringify(job.value));
    assert.equal((await api('/api/projects/switch',{projectId:freshId})).status,409);
    let result;for(let n=0;n<60;n++){result=(await api('/api/jobs/'+job.value.job.id)).value;if(!['running','cancelling'].includes(result.status))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(result.status,'failed');assert.match(result.error,/真实 ChatCut/);state=(await api('/api/state')).value;assert.equal(state.project.deliveries.length,0);
    await api('/api/project',{...actual,styleDescription:'改动后的风格'});state=(await api('/api/state')).value;assert.equal(state.project.approval,null);assert.equal(state.project.plan.stale,true);
    await api('/api/reset',{});
    const partial=await api('/api/jobs',{action:'discover',query:'分批失败测试'});assert.equal(partial.status,202,JSON.stringify(partial.value));
    let partialJob,sawLive=false;
    for(let n=0;n<80;n++){partialJob=(await api('/api/jobs/'+partial.value.job.id)).value;if(partialJob.partialSourceIds?.length&&partialJob.status==='running'){sawLive=true;state=(await api('/api/state')).value;assert.equal(state.library.candidates.filter(c=>c.title.startsWith('Partial fixture')).length,2);assert.deepEqual(state.project.selected,[]);}if(!['running','cancelling'].includes(partialJob.status))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(sawLive,true);assert.equal(partialJob.status,'failed');assert.equal(partialJob.failureKind,'connection_refused');assert.equal(partialJob.partialSourceIds.length,2);
    const afterFailure=(await api('/api/state')).value;assert.equal(afterFailure.library.candidates.filter(c=>c.title.startsWith('Partial fixture')).length,2);assert.equal(afterFailure.project.deliveries.length,0);
    for(let n=0;n<30&&(await api('/api/state')).value.busy;n++)await new Promise(r=>setTimeout(r,100));
    const beforeBlocked=afterFailure.project.jobs.length;await writeFile(fake,(await readFile(fake,'utf8')).replace('codex-cli 0.164.0','codex-cli 0.100.0'));
    const oldCli=await api('/api/jobs',{action:'discover',query:'不能启动旧 CLI'});assert.equal(oldCli.status,400);assert.equal(oldCli.value.code,'preflight_failed');assert.match(oldCli.value.error,/版本不满足/);assert.equal((await api('/api/state')).value.project.jobs.length,beforeBlocked);
    await writeFile(fake,(await readFile(fake,'utf8')).replace('codex-cli 0.100.0','codex-cli 0.164.0'));await writeFile(downloader,'#!/usr/bin/env node\nprocess.exit(1);\n');
    const missingTool=await api('/api/jobs',{action:'discover',query:'缺少下载器不能启动'});assert.equal(missingTool.status,400);assert.equal(missingTool.value.code,'preflight_failed');assert.match(missingTool.value.error,/yt-dlp/);assert.equal(missingTool.value.runtime.dependencies.checks.find(c=>c.id==='downloader').canPrepare,true);assert.equal((await api('/api/state')).value.project.jobs.length,beforeBlocked);
    console.log('API verified: review hashes, file upload/range serving, source validation, no fabricated export, scoped access.');
  }finally{server?.kill('SIGTERM');if(server&&server.exitCode===null)await new Promise(r=>{const timer=setTimeout(()=>{server.kill('SIGKILL');r();},4000);server.once('exit',()=>{clearTimeout(timer);r();});});await rm(temp,{recursive:true,force:true});}
});
