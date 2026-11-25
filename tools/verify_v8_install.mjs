// Run using the installed bundle's bin/node. This check creates empty disposable projects only.
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const resources=path.resolve(process.argv[2]||''),root=await mkdtemp(path.join(tmpdir(),'vstudio-installed-'));
process.env.VIDEO_STUDIO_RESOURCE_DIR=resources;
process.env.VIDEO_STUDIO_BUILTIN_PACKS=path.join(resources,'user-packs');
const moduleAt=name=>import(pathToFileURL(path.join(resources,'apps/studio/src',name)).href);
let app;
try{
  const {startStudio}=await moduleAt('server.mjs');
  const {styleAudioPolicy}=await moduleAt('style-audio.mjs');
  const {createStyleLibrary}=await moduleAt('style.mjs');
  const {audioCapabilities}=await moduleAt('audio.mjs');
  const {soundResources,supportsSound,archiveSound}=await moduleAt('style-sounds.mjs');
  const {createHash}=await import('node:crypto');
  const styles=createStyleLibrary(root,{legacyHome:false});
  app=await startStudio({root,dependencies:{styles},owner:false});
  const response=await fetch(app.url,{redirect:'manual'});
  const cookie=response.headers.get('set-cookie').split(';')[0],origin=new URL(app.url).origin;
  async function api(endpoint,body) {
    const response=await fetch(origin+endpoint,{method:body?'POST':'GET',headers:{cookie,origin,'Content-Type':'application/json'},...(body&&{body:JSON.stringify(body)})});
    const out=await response.json();assert.ok(response.ok,JSON.stringify(out));return out;
  }
  const caps=await audioCapabilities();
  const rows=[];
  for(const [styleId,count] of [['henry-hot-news',7],['henry-technical-explainer',6]]){
    const style=await api('/api/styles/'+styleId+'/8'), p=await api('/api/projects',{mode:'topic',profile:{width:1080,height:1920,fps:30},brief:'片长 50–60 秒',style:{id:styleId,version:8}});
    const readiness=await api('/api/projects/'+p.id+'/v8-readiness');
    assert.ok(readiness.ready,JSON.stringify(readiness));assert.equal(readiness.executable,count);assert.equal(p.settings.presetVoice,'dylan');
    assert.equal(p.settings.durationMinSeconds,50);assert.equal(p.settings.durationMaxSeconds,60);
    assert.deepEqual(p.timeline.clips,[]);assert.deepEqual(await api('/api/projects/'+p.id+'/jobs'),[]);
    const policy=styleAudioPolicy(style),music=await styles.getMusicResource(style.id,8,policy.music);
    assert.ok(music?.verified,policy.music.title);
    const sounds=soundResources.filter(s=>supportsSound(style,s.id));
    for(const sound of sounds)assert.equal(createHash('sha256').update(archiveSound(style,sound.id).data).digest('hex'),sound.sha256);
    rows.push({style:styleId,components:count,originalSounds:sounds.length,baseline:readiness.baselineSha256,music:policy.music.title,musicSha256:music.sha256,voice:p.settings.presetVoice});
  }
  assert.ok(caps.preset,'本机 Dylan 模型或 MLX 运行环境尚未就绪');assert.ok(caps.transcription,'本机转录未就绪');
  const front=await readFile(path.join(resources,'apps/studio/www/app.js'),'utf8');assert.ok(front.includes('approve-plan'));
  console.log(JSON.stringify({projectJobs:0,presetReady:caps.preset,transcriptionReady:caps.transcription,styles:rows},null,2));
} finally {
  await app?.close();await rm(root,{recursive:true,force:true});
}
