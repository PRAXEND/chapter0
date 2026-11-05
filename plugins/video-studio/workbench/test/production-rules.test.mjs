import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {initialStudio,brief} from '../studio-workflow.mjs';
import {narrationArguments} from '../narration.mjs';
import {requestHash} from '../automatic.mjs';
import {prepareAgentRequest} from '../agent.mjs';

test('horizontal review asks for only its audited checks and visible caption observations',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'wide-review-'));
  try{
    const requiredChecks=['visuals','occlusion','caption_flow','music_fit'];
    await prepareAgentRequest({action:'review'},{jobDirectory:dir,requiredChecks,brief:{workbench_rules:2,requirements:{captions:true}}});
    const schema=JSON.parse(await readFile(path.join(dir,'output.schema.json'),'utf8'));
    const row=schema.properties.checks.items;
    assert.deepEqual(row.properties.check.enum,requiredChecks);
    assert.ok(row.required.includes('captionObservations'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('the automatic cycle identity includes all actual media switches for new projects',()=>{
  const project=initialStudio();
  for(const change of [{music:'none'},{captions:false},{narration:false}]){
    assert.notEqual(requestHash(project),requestHash({...project,...change}));
  }
});

test('paid narration request pins the chosen available tuple; caller cannot replace it',()=>{
  const voice={selected_by_user:true,provider:'test',voiceId:'xiaotian'};
  const catalog={voices:['dayi','xiaotian'].map(voiceId=>({provider:'test',voiceId,available:true,supportedUses:['tts'],capabilities:{supportedControls:['speed']}}))};
  const project={projectId:'p',timelineId:'t'};
  assert.equal(narrationArguments(voice,catalog,{text:'试片',speed:1},project).voiceId,'xiaotian');
  for(const overrides of [{voiceId:'dayi'},{provider:'other'},{voiceRef:'other'},{projectId:'other'},{requestId:'retry'}])
    assert.throws(()=>narrationArguments(voice,catalog,{text:'试片',...overrides},project));
  assert.throws(()=>narrationArguments(voice,{voices:[catalog.voices[0]]},{text:'试片'},project));
});

test('archived projects remain byte-identical; a clean new project exposes nine styles and locks sound choices',{timeout:45000},async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'workbench-update-')),data=path.join(folder,'workbench');
  const workbench=fileURLToPath(new URL('../',import.meta.url));
  const old=initialStudio();delete old.productionRules;
  old.automatic={stage:'create',status:'running'};old.topic='历史';old.updatedAt='2026-01-01T00:00:00Z';
  const raw=JSON.stringify(old),file=path.join(data,'projects',old.id+'.json');
  await mkdir(path.dirname(file),{recursive:true});
  await Promise.all([writeFile(file,raw),writeFile(path.join(data,'workbench-v2.json'),raw)]);
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(r=>socket.close(r));
  const env={...process.env,PORT:String(port),VIDEO_STUDIO_WEB_DATA:data,VIDEO_STUDIO_HOME:path.join(folder,'user'),VIDEO_STUDIO_PLUGIN_ROOT:path.dirname(path.resolve(workbench)),VIDEO_DEMO_CODEX_BIN:'/unavailable/test-cli'};
  delete env.VIDEO_STUDIO_PACK_ROOT;
  const child=spawn(process.execPath,[path.join(workbench,'studio-server.mjs')],{env,stdio:'ignore'});
  const api=(name,payload)=>fetch('http://127.0.0.1:'+port+'/api/'+name,payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Video-Demo':'1'},body:JSON.stringify(payload)});
  try{
    let state;
    for(let i=0;i<150&&!state;i++){try{state=await(await api('state')).json();}catch{await new Promise(r=>setTimeout(r,100));}}
    assert.equal(state?.readOnly,true);
    for(const endpoint of ['project','feedback','jobs','cancel','revision/confirm','provisional','voice/start','upload','voice/recording'])
      assert.equal((await api(endpoint,{})).status,409,endpoint);
    assert.equal(await readFile(path.join(data,'workbench-v2.json'),'utf8'),raw);
    const fresh=await(await api('reset',{})).json();
    assert.equal(fresh.readOnly,false);assert.equal(fresh.project.captions,true);
    assert.equal(brief(fresh.project).generate_music,true);
    const entries=fresh.catalog.styleBrowser.entries.filter(e=>!e.historical);
    assert.equal(new Set(entries.map(e=>e.choice_group)).size,9);
    const style=entries.find(e=>e.name==='反差故事型');
    assert.equal((await api('styles/select',{key:style.key})).status,200);
    const chosen=await(await api('project',{...fresh.project,styleSelector:style.selector,music:'none',advancedOverrides:{music:true,captions:true}})).json();
    assert.equal(brief(chosen.project).generate_music,false);
    assert.equal((await(await api('projects/switch',{projectId:old.id})).json()).readOnly,true);
    assert.equal(await readFile(file,'utf8'),raw);
  }finally{const stopped=once(child,'exit');child.kill();if(child.exitCode===null)await stopped;await rm(folder,{recursive:true,force:true});}
});
