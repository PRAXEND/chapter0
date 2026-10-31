import {access,readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';

const directory=path.resolve(process.argv[2]||'');
if(!process.argv[2])throw new Error('Pass the extracted Frame Video Studio directory.');
const sums=await readFile(path.join(directory,'SHA256SUMS.txt'),'utf8');
for(const line of sums.trim().split('\n')){const [digest,...parts]=line.split('  '),relative=parts.join('  ');assert.equal(createHash('sha256').update(await readFile(path.join(directory,relative))).digest('hex'),digest,relative);}
let pluginDirectory=path.join(directory,'plugins/video-studio');try{await access(path.join(directory,'plugin.json'));pluginDirectory=directory;}catch{}
const workbenchDirectory=path.join(pluginDirectory,'workbench');
const plugin=JSON.parse(await readFile(path.join(pluginDirectory,'plugin.json'),'utf8'));
assert.equal(plugin.name,'video-studio');assert.match(plugin.version,/^0\.3\.0-web\./);
assert.ok(!(await readdir(workbenchDirectory)).includes('.data'),'Portable package must not contain user state');
const temp=await mkdtemp(path.join(os.tmpdir(),'frame-portable-check-'));
const portServer=net.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
let child;
try{
  child=spawn(process.execPath,[path.join(workbenchDirectory,'studio-server.mjs')],{env:{...process.env,PORT:String(port),VIDEO_STUDIO_WEB_DATA:path.join(temp,'data'),VIDEO_STUDIO_HOME:path.join(temp,'profile')},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',x=>stderr+=x);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup timed out: '+stderr)),20000);child.stdout.on('data',x=>{if(x.toString().includes('Video Agent Demo:')){clearTimeout(timer);resolve();}});child.on('error',reject);child.on('exit',code=>{if(code)reject(new Error(stderr));});});
  const base='http://127.0.0.1:'+port;
  const state=await (await fetch(base+'/api/state')).json();assert.equal(state.catalog.version,plugin.version);assert.equal(state.project.schema,2);assert.equal(state.project.topic,'');assert.equal(state.project.jobs.length,0);assert.equal(state.project.tokenUsageJobs.length,0);assert.equal(state.project.deliveries.length,0);assert.equal(state.runtime.chatcut,'not_checked');assert.equal(state.library.entries.length,0);assert.equal(state.library.candidates.length,0);assert.equal((await fetch(base+'/api/library/media/not-registered')).status,404);
  const checks=state.runtime.dependencies.checks;for(const id of ['git_lfs','style_media_hot_news','style_media_technical_explainer'])assert.ok(checks.some(c=>c.id===id));for(const c of checks.filter(c=>c.id.startsWith('style_media_'))){assert.equal(c.required,false);assert.equal(c.ok,false);assert.match(c.remedy,/link-pack/);}
  const projects=await (await fetch(base+'/api/projects')).json();assert.equal(projects.projects.length,1);assert.equal(projects.projects[0].id,state.project.id);assert.equal(projects.projects[0].current,true);
  const html=await (await fetch(base)).text();assert.equal(state.project.workflowVersion,1);assert.equal(state.project.portraitBottomInset,.18);assert.match(html,/id="portrait-bottom-inset"/);for(const asset of ['/theme.js','/themes.css','/production-plan.js','/dependency-view.js'])assert.equal((await fetch(base+asset)).status,200);assert.match(html,/data-appearance="light"/);assert.match(html,/data-appearance="dark"/);assert.match(html,/data-appearance="system"/);assert.match(html,/type="module"/);assert.equal((await fetch(base+'/material-dates.js')).status,200);assert.match(html,/stage-content/);assert.match(html,/id="token-usage"/);for(const asset of ['/token-usage.js','/token-usage-view.js'])assert.equal((await fetch(base+asset)).status,200);assert.match(html,/文案审阅/);assert.match(html,/成片与交付/);assert.match(html,/projects-toggle/);assert.match(html,/projects-dialog/);
  assert.equal((await fetch(base+'/api/reset',{method:'POST',body:'{}'})).status,403);
  console.log('Verified portable package: every SHA-256, bundled plugin discovery, blank private state, real HTTP startup, four-stage UI and request protection. No Agent or ChatCut mutation invoked.');
}finally{child?.kill('SIGTERM');if(child&&child.exitCode===null)await new Promise(r=>child.once('exit',r));await rm(temp,{recursive:true,force:true});}
