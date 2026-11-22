import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startStudio} from '../src/server.mjs';

// Re-run the original topic brief from an empty project via the same HTTP entry as the UI.
// Neither the old cut nor the old asset selections are inputs to the new director.
const [snapshot,destination]=process.argv.slice(2);
if(!snapshot||!destination)throw Error('用法：node replay-topic.mjs <原工程 JSON> <新的验证目录>');
const original=JSON.parse(await readFile(snapshot,'utf8'));
const resources=process.env.VIDEO_STUDIO_RESOURCE_DIR;
if(resources && !process.env.VIDEO_STUDIO_CODEX){
  const relative=(await readFile(path.join(resources,'codex-executable.txt'),'utf8')).trim();
  process.env.VIDEO_STUDIO_CODEX=path.resolve(resources,'codex-runtime',relative);
}
let cliVersion;
if(process.env.VIDEO_STUDIO_CODEX){
  await access(process.env.VIDEO_STUDIO_CODEX,constants.X_OK);
  const version=await promisify(execFile)(process.env.VIDEO_STUDIO_CODEX,['--version']);
  cliVersion=version.stdout.trim();
}
if(original.mode!=='topic')throw Error('此验证从空素材库重做选题工程。');
if(!['system',undefined].includes(original.settings?.voiceMode)||original.settings?.musicMode==='asset')
  throw Error('请用无需预先导入声音文件的选题工程执行此对照。');
const root=path.resolve(destination);
await mkdir(root,{mode:0o700}); // EEXIST protects the previous run and the original project.
const service=await startStudio({root});
try {
  const login=await fetch(service.url,{redirect:'manual'});
  const origin=new URL(service.url).origin;
  const cookie=login.headers.get('set-cookie')?.split(';')[0];
  async function api(route,body) {
    const response=await fetch(origin+route,{method:body?'POST':'GET',headers:{cookie,origin,'content-type':'application/json'},...(body&&{body:JSON.stringify(body)})});
    const value=await response.json();
    if(!response.ok)throw Error(value.error||String(response.status));
    return value;
  }
  const {mode,title,brief,script,profile,style}=original;
  const {voiceMode,shareFrames,shareTranscript,publishPackage,musicEnabled,musicMode,targetDuration,reasoningEffort,factUrls,sourceUrls,model}=original.settings||{};
  const p=await api('/api/projects',{mode,title,brief,script,profile,style:{id:style.id,version:style.version},
    settings:{voiceMode,shareFrames,shareTranscript,publishPackage,musicEnabled,musicMode,targetDuration,reasoningEffort,
      factUrls,sourceUrls,model:process.env.VIDEO_STUDIO_REPLAY_MODEL||model,cloudEnabled:false,cloudBudget:0}});
  const queued=await api('/api/projects/'+p.id+'/jobs',{kind:'produce',engine:'codex',baseRevision:p.revision});
  let last='';
  for(;;) {
    const j=await api('/api/jobs/'+queued.id);
    const event=j.events?.at(-1);
    if(event?.at!==last){last=event?.at;if(event)console.log(event.at,event.message);}
    if(['done','failed','paused'].includes(j.status)) {
      const final=service.store.getJob(j.id);
      const summary={projectId:p.id,jobId:j.id,threadId:service.store.get(p.id).threadId,cliVersion,status:j.status,error:j.error,
        revision:j.revision,creativeEngine:j.creativeEngine,qa:j.qa?.status,issues:j.qa?.issues?.map(q=>q.message||q.reason),
        published:final.published,files:final.files};
      await writeFile(path.join(root,'outcome.json'),JSON.stringify(summary,null,2)+'\n');
      console.log(j.status,j.qa?.label||j.error||'',path.join(root,'outcome.json'));
      if(j.status!=='done')process.exitCode=1;
      break;
    }
    await delay(2000);
  }
} finally {await service.close();}
