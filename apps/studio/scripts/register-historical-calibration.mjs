import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {constants} from 'node:fs';
import {access,copyFile,mkdir,readFile,readdir,writeFile,rename} from 'node:fs/promises';
import {createBlindReview} from '../src/blind-review.mjs';
import {classifyLegacyReview} from '../src/review.mjs';
import {fileSha256} from '../src/style.mjs';
const [rootArg,legacyRoot,...reports]=process.argv.slice(2);
if(!rootArg||!legacyRoot||!reports.length) throw Error('使用 node register-historical-calibration.mjs <独立评测库> <旧工作台目录> <独立报告.json> ...');
const root=path.resolve(rootArg),src=process.env.STUDIO_EVALUATION_SRC||fileURLToPath(new URL('../src/',import.meta.url));
const {legacyLibrary}=await import(pathToFileURL(path.join(src,'library.mjs')).href),archive=legacyLibrary(path.resolve(legacyRoot));
const {probeMedia}=await import(pathToFileURL(path.join(src,'media.mjs')).href);
const library=createBlindReview(root),dir=path.join(root,'research-archive'),record=path.join(root,'research-plan','history-calibration.json');
await mkdir(dir,{recursive:true});await mkdir(path.dirname(record),{recursive:true});
const projects=[],samples=[];
for(const name of await readdir(path.join(legacyRoot,'projects'))) {
  if(!name.endsWith('.json')) continue;
  const p=JSON.parse(await readFile(path.join(legacyRoot,'projects',name),'utf8'));
  if(name!==p.id+'.json') continue;
  projects.push({id:p.id,media:[...(p.deliveries||[]),...(p.provisionalDeliveries||[])].flatMap(d=>d.files||[])});
}
for(const file of reports) {
  const report=JSON.parse(await readFile(file,'utf8')),hash=report.artifact_sha256;
  if(!/^[a-f0-9]{64}$/.test(hash)) throw Error('历史报告未绑定成片指纹');
  if(samples.some(s=>s.hash===hash)) continue;
  let resolved;
  for(const p of projects) {
    const rows=p.media.filter(m=>m.role==='video'&&m.sha256===hash);
    for(const a of rows) {
      let selected;
      try {selected=await archive.item(p.id,a.id);} catch {continue;}
      if(selected.sha256===hash) {resolved=selected;break;}
    }
    if(resolved) break;
  }
  if(!resolved) throw Error('旧工程没有有效的同指纹候选：'+path.basename(path.dirname(file)));
  const target=path.join(dir,hash+path.extname(resolved.path));
  try{await access(target);}catch{await copyFile(resolved.path,target,constants.COPYFILE_FICLONE);}
  if(await fileSha256(target)!==hash) throw Error('历史候选在准备校准时发生变化');
  const grade=classifyLegacyReview(report),meta=await probeMedia(target);
  if(meta.kind!=='video') throw Error('旧候选没有可播放画面');
  samples.push({videoPath:target,hash,mode:'topic',fps:meta.frames&&meta.duration?meta.frames/meta.duration:null,originalCompleted:grade.originalCompleted,systemStatus:grade.originalCompleted?'deliverable':'repair',proposedStatus:grade.status,systemIssues:grade.issues});
}
const existing=await readFile(record,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
if(existing?.samples.map(s=>s.hash).sort().join('/')===samples.map(s=>s.hash).sort().join('/')) console.log('已冻结历史校准研究',existing.study.id);
else {
  const study=await library.create({kind:'gate',purpose:'calibration',title:'旧片回看 · 历史校准',samples});
  await writeFile(record+'.tmp',JSON.stringify({study,samples:samples.map(({videoPath,...rest})=>rest)},null,2));await rename(record+'.tmp',record);
  console.log('历史校准已就绪',study.id,samples.length);
}
