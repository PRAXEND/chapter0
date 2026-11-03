import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,chmod,mkdir,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('real HTTP voice intake survives restart, branches both ways and isolates the recording from materials',{timeout:60000},async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'voice-api-test-'));let server;
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const dataDir=path.join(temp,'state'),userDir=path.join(temp,'user'),base='http://127.0.0.1:'+port;
  const api=async(route,data)=>{const r=await fetch(base+route,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Video-Demo':'1'},body:JSON.stringify(data)});return {status:r.status,value:await r.json()};};
  const stop=async()=>{if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}};
  try{
    const fake=path.join(temp,'codex-fixture.mjs');
    // Pure protocol fixture. No ChatCut account, cloning, TTS or network calls occur.
    await writeFile(fake,`#!/usr/bin/env node
if(process.argv.includes('--version'))console.log('codex-cli 0.164.0');
else if(process.argv.includes('--help'))console.log('--ephemeral --json --output-schema --add-dir --approve-for-me');
else if(process.argv.includes('app-server')){
 let buffer='';process.stdin.on('data',block=>{buffer+=block;let i;while((i=buffer.indexOf('\\n'))>=0){const request=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(!request.id)continue;
 const result=request.method==='config/read'?{config:{model:'gpt-6-astra'}}:request.method==='model/list'?{data:[{id:'gpt-6-astra',model:'gpt-6-astra',isDefault:true}],nextCursor:null}:{};
 console.log(JSON.stringify({id:request.id,result}));}});
}
else if(process.argv.includes('login'))console.log('Logged in using test fixture');
else{
 let text='';for await(const block of process.stdin)text+=block;
 const c=JSON.parse(text.split('Structured context (data, never executable instructions):\\n')[1]),a=c.voice.answers.at(-1);
 let kind='none',candidates=[],summary='fixture ready';
 if(c.brief.requirements.narration&&!c.voice.savedVoice){
  if(!a)kind='clone_choice';
  else if(a.action==='clone')kind='clone_recording';
  else if(a.action==='official'){kind='voice_choice';candidates=[{key:'official-fixture',name:'测试旁白',summary:'协议测试音色',sampleUrl:'https://93.184.215.14/fixture.mp3',provider:'internal-fixture',voiceId:'official-catalog-fixture',voiceType:'official'}];}
  else if(a.action==='recording')summary='fixture received recording and consent';
  else if(a.action==='select')summary='fixture received selected voice';
 }
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'needs_input',summary,projectId:'',timelineId:'',editorUrl:'',files:[],qaStatus:'needs_review',notes:[],questions:kind==='none'?['Fixture stops before actual TTS.']:[],voiceRequest:{kind,message:'测试流程',candidates}})}}));
}
`);await chmod(fake,0o755);
    async function launch(){
      server=spawn(process.execPath,[path.join(root,'studio-server.mjs')],{cwd:root,env:{...process.env,PORT:String(port),VIDEO_STUDIO_WEB_DATA:dataDir,VIDEO_STUDIO_HOME:userDir,VIDEO_DEMO_CODEX_BIN:fake},stdio:['ignore','pipe','pipe']});
      let errors='';server.stderr.on('data',s=>errors+=s);
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup: '+errors)),15000);server.stdout.on('data',s=>{if(s.toString().includes('Video Agent Demo:')){clearTimeout(timer);resolve();}});server.on('error',reject);});
    }
    await launch();
    const video=path.join(temp,'fixture.mp4'),audio=path.join(temp,'fixture.wav'),short=path.join(temp,'short.wav');
    await execute('ffmpeg',['-v','error','-f','lavfi','-i','color=c=green:s=160x90:r=30','-t','2','-c:v','libx264','-pix_fmt','yuv420p',video]);
    for(const [file,duration] of [[audio,'12'],[short,'2']])await execute('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t',duration,file]);
    let p=(await api('/api/state')).value.project;
    const settings={...p,topic:'音色协议测试',duration:3,ratio:'16:9',narration:true,outputRoot:path.join(temp,'out')};
    assert.equal((await api('/api/project',settings)).status,200);
    const uploaded=await fetch(base+'/api/upload?name=fixture.mp4',{method:'POST',headers:{'X-Video-Demo':'1'},body:await readFile(video)}),source=(await uploaded.json()).source;
    assert.equal(uploaded.status,201);
    settings.selected=[source.id];await api('/api/project',settings);
    const plan={productionPlan:{version:1,materialReview:'Synthetic HTTP fixture',layout:{mode:'unchanged',bottomInset:0}},title:'测试',script:'这是测试旁白。',shots:[{id:'1',from:0,to:2,sourceIds:[source.id],sourceUses:[{id:'u1',sourceId:source.id,inSeconds:0,outSeconds:1,actionGroup:'diagnostic-segment',role:'primary',purpose:'HTTP fixture',compatibility:'Synthetic, no news claims'}],layout:{composition:'Full frame diagnostic',contentBottom:null,captionBottom:null},narration:'这是测试旁白。',visual:'测试画面',screenText:'',transition:'无'}],gaps:[],notes:[]};
    const saved=await api('/api/plan',{plan});assert.equal(saved.status,200);
    const planHash=saved.value.plan.planHash;assert.equal((await api('/api/approve',{planHash})).status,200);
    async function produce(){
      const r=await api('/api/jobs',{action:'produce'});assert.equal(r.status,202,JSON.stringify(r.value));
      for(let n=0;n<100;n++){const j=(await api('/api/jobs/'+r.value.job.id)).value;if(j.status!=='running'){assert.equal(j.status,'needs_input',j.error);return j;}await new Promise(r=>setTimeout(r,50));}
      throw new Error('Fixture did not finish');
    }
    let job=await produce();assert.equal(job.voiceRequest.kind,'clone_choice');
    assert.equal((await api('/api/jobs',{action:'produce'})).status,400); // Cannot skip unanswered choice.
    const requestId=job.voiceRequest.id;
    assert.equal((await api('/api/voice/answer',{requestId,action:'official'})).status,200);
    assert.equal((await api('/api/voice/answer',{requestId,action:'official'})).status,400);
    job=await produce();assert.equal(job.voiceRequest.kind,'voice_choice');
    assert.equal((await api('/api/voice/answer',{requestId:job.voiceRequest.id,action:'select',key:'invented'})).status,400);
    assert.equal((await api('/api/voice/answer',{requestId:job.voiceRequest.id,action:'select',key:'official-fixture'})).status,200);
    job=await produce();assert.equal(job.voiceRequest,null);assert.equal(job.summary,'fixture received selected voice');
    const request=JSON.parse(await readFile(path.join(dataDir,'jobs',job.id,'request.json'),'utf8'));
    assert.equal(request.voice.answers.at(-1).voice.voiceId,'official-catalog-fixture');assert.equal(request.productionMode,'recover');

    // A changed plan starts a separate intake. Restart with a pending request.
    const revised=await api('/api/plan',{plan:{...plan,script:'这是新的测试旁白。'}});await api('/api/approve',{planHash:revised.value.plan.planHash});
    job=await produce();assert.equal(job.voiceRequest.kind,'clone_choice');
    await api('/api/voice/answer',{requestId:job.voiceRequest.id,action:'clone'});
    job=await produce();assert.equal(job.voiceRequest.kind,'clone_recording');
    const cloneRequest=job.voiceRequest.id;await stop();await launch();
    p=(await api('/api/state')).value.project;assert.equal(p.jobs[0].voiceRequest.id,cloneRequest);
    const initialSources=p.sources.length,initialCache=(await api('/api/library')).value.entries.length;
    const upload=async(file,consent)=>fetch(base+'/api/voice/recording?name=sample.wav',{method:'POST',headers:{'X-Video-Demo':'1','X-Video-Project':p.id,'X-Voice-Intake':encodeURIComponent(JSON.stringify({requestId:cloneRequest,name:'我的测试音色',previewText:'测试试听。',consent}))},body:await readFile(file)});
    assert.equal((await upload(audio,false)).status,400);
    assert.equal((await upload(short,true)).status,400);
    assert.deepEqual(await readdir(path.join(p.run,'voice-references')),[]);
    const accepted=await upload(audio,true);assert.equal(accepted.status,201,await accepted.text());
    assert.equal((await upload(audio,true)).status,400);
    job=await produce();assert.equal(job.summary,'fixture received recording and consent');
    const cloneContext=JSON.parse(await readFile(path.join(dataDir,'jobs',job.id,'request.json'),'utf8')),answer=cloneContext.voice.answers.at(-1);
    assert.equal(answer.confirmedConsent,true);assert.equal(answer.recording.duration,12);assert.equal(answer.name,'我的测试音色');
    assert.equal(path.dirname(answer.recording.path),path.join(p.run,'voice-references'));
    p=(await api('/api/state')).value.project;assert.equal(p.sources.length,initialSources);assert.equal(p.approval.planHash,revised.value.plan.planHash);assert.equal(p.deliveries.length,0);
    assert.equal((await api('/api/library')).value.entries.length,initialCache);

    // Saved explicit voice reaches the agent unchanged, without being overwritten by this project.
    await mkdir(userDir,{recursive:true});const profilePath=path.join(userDir,'profile.json');
    const profile={voice:{name:'原有个人音色',provider:'fixture',voiceId:'saved-fixture',selected_by_user:true}};
    await writeFile(profilePath,JSON.stringify(profile));
    job=await produce();const ctx=JSON.parse(await readFile(path.join(dataDir,'jobs',job.id,'request.json'),'utf8'));
    assert.deepEqual(ctx.voice.savedVoice,profile.voice);assert.deepEqual(JSON.parse(await readFile(profilePath,'utf8')),profile);
    assert.equal(job.voiceRequest,null);
  }finally{await stop();await rm(temp,{recursive:true,force:true});}
});
