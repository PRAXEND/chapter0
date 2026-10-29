import {readFile,writeFile,mkdir,rename,stat,copyFile,unlink,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fileHash,contained,mediaExtensions,mimeTypes,privateAddress} from './media.mjs';
import {sourceDetails,verifySourceIdentity} from './sources.mjs';

const execute=promisify(execFile);
function metadata(source){
  const raw={...source,sourceType:source.sourceType||source.source_type,
    needIds:source.needIds||source.need_ids,topicFit:source.topicFit||source.topic_fit,styleFit:source.styleFit||source.style_fit,
    repositoryCommit:source.repositoryCommit||source.repository_commit||source.repository?.commit,
    repositoryPath:source.repositoryPath||source.repository_path||source.repository?.path,
    expectedSha256:source.expectedSha256||source.expected_sha256,expectedBytes:source.expectedBytes||source.expected_bytes,
    batchDate:source.batchDate||source.batch_date,collectedAt:source.collectedAt||source.collected_at,
    eventDate:source.eventDate||source.event_date,dateEvidence:source.dateEvidence||source.date_evidence};
  return {...sourceDetails(raw),title:String(source.title||'本地素材').slice(0,300),
    description:String(source.description||'').slice(0,4000),author:String(source.author||'').slice(0,200),
    rights:String(source.rights||'unknown').slice(0,1000),publishedAt:String(source.publishedAt||source.published_at||''),
    url:cleanUrl(source.url),mediaUrl:cleanUrl(source.mediaUrl),start:Number(source.start??source.source_start_seconds)||0,
    end:Number(source.end??source.source_end_seconds)||0};
}
function cleanUrl(value){try{const u=new URL(value),host=u.hostname.replace(/^\[|\]$/g,'');return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&host!=='localhost'&&!host.endsWith('.local')&&!host.endsWith('.internal')&&!(net.isIP(host)&&privateAddress(host))?u.href:'';}catch{return '';}}
function canonicalUrl(value){const clean=cleanUrl(value);if(!clean)return '';const u=new URL(clean);u.hash='';return u.href;}
export function candidateId(source){const url=canonicalUrl(source.url||source.mediaUrl);if(!url)throw new Error('候选内容需要有效的公开来源链接。');return 'candidate-'+createHash('sha256').update(url).digest('hex').slice(0,24);}
export function candidateMatchesMedia(candidate,entry){
  const expected=[...(candidate.repositoryMedia||[]),...(candidate.expectedSha256?[{sha256:candidate.expectedSha256,bytes:candidate.expectedBytes}]:[])];
  const exact=expected.some(m=>m.sha256===entry.sha256&&(!m.bytes||m.bytes===entry.bytes));
  if(expected.length&&!exact)return false;
  return (entry.candidateIds||[]).includes(candidate.id)||
    (!!candidate.url&&canonicalUrl(candidate.url)===canonicalUrl(entry.url)&&(!candidate.repositoryCommit||!entry.repositoryCommit||candidate.repositoryCommit===entry.repositoryCommit||exact));
}

export class MediaLibrary{
  constructor(directory,inspect){this.directory=path.resolve(directory);this.inspect=inspect;this.entries=[];this.candidates=[];this.writes=Promise.resolve();this.errors=[];}
  async init(){
    await mkdir(this.directory,{recursive:true});
    try{const saved=JSON.parse(await readFile(path.join(this.directory,'index.json'),'utf8'));if(saved.schema!==1||!Array.isArray(saved.entries)||saved.candidates&&!Array.isArray(saved.candidates))throw new Error('本地素材库格式无效。');this.entries=saved.entries;this.candidates=saved.candidates||[];this.repositorySync=saved.repositorySync||null;}
    catch(e){if(e.code!=='ENOENT')throw e;}
    return this;
  }
  async persist(){
    const snapshot=JSON.stringify({schema:1,entries:this.entries,candidates:this.candidates,repositorySync:this.repositorySync||null},null,2);
    this.writes=this.writes.catch(()=>{}).then(async()=>{const temporary=path.join(this.directory,'index-'+randomUUID()+'.tmp');await writeFile(temporary,snapshot,{mode:0o600});await rename(temporary,path.join(this.directory,'index.json'));});
    await this.writes;
  }
  async rememberCandidates(sources,context={}){
    const saved=[];
    for(const source of sources){
      if(!['video','image','audio','article','paper'].includes(source.kind))continue;
      const url=canonicalUrl(source.url||source.mediaUrl);if(!url)continue;
      const details=metadata({...source,url}),id=candidateId({url});
      const foundDate=context.reviewedAt||context.reviewed_at||new Date().toISOString();
      const seenAt=Number.isFinite(Date.parse(foundDate))?new Date(foundDate).toISOString():new Date().toISOString();
      const event=(context.events||[]).find(e=>e.source_ids?.includes(source.id));
      const origin={run:context.run?path.resolve(context.run):null,jobId:String(context.jobId||''),sourceId:String(source.id||''),
        topic:String(context.topic||'').slice(0,200),style:context.style||null,query:String(context.query||'').slice(0,2000),seenAt,
        eventId:event?.event_id||'',decision:event?.decision||'',reason:String(event?.reason||'').slice(0,4000),
        dateEvidence:String(event?.date_evidence||'').slice(0,4000),caveats:Array.isArray(event?.caveats)?event.caveats.slice(0,30).map(String):[]};
      let entry=this.candidates.find(c=>c.id===id);
      if(entry&&(!details.repositoryCommit||details.repositoryCommit===entry.repositoryCommit)){
        // A scoped search may omit the full catalog fields; keep known data for the same snapshot.
        if(!Array.isArray(source.repositoryMedia)||!source.repositoryMedia.length)details.repositoryMedia=entry.repositoryMedia||[];
        if(!source.postText)details.postText=entry.postText||'';
        if(!details.batchDate)details.batchDate=entry.batchDate||'';
        if(!details.collectedAt)details.collectedAt=entry.collectedAt||'';
      }
      if(!entry){entry={...details,id,kind:source.kind,status:'candidate',thumbnailUrl:cleanUrl(source.thumbnailUrl),localPath:'',firstSeenAt:seenAt,lastSeenAt:seenAt,origins:[]};this.candidates.push(entry);}
      else if(seenAt>=entry.lastSeenAt){
        if(context.query==='每日仓库完整目录'){details.topicFit=entry.topicFit||details.topicFit;details.styleFit=entry.styleFit||details.styleFit;details.needIds=entry.needIds||details.needIds;details.caveats=[...new Set([...(entry.caveats||[]),...details.caveats])];}
        Object.assign(entry,details,{kind:source.kind,thumbnailUrl:cleanUrl(source.thumbnailUrl)||entry.thumbnailUrl,lastSeenAt:seenAt,localPath:'',status:'candidate'});
      }
      if(!entry.origins.some(o=>o.run===origin.run&&o.jobId===origin.jobId&&o.sourceId===origin.sourceId&&o.query===origin.query&&o.topic===origin.topic&&o.style===origin.style))entry.origins.push(origin);
      entry.origins=entry.origins.sort((a,b)=>b.seenAt.localeCompare(a.seenAt)).slice(0,30);saved.push(entry);
    }
    if(saved.length)await this.persist();return saved;
  }
  async candidateList(media){
    media||=await this.list();
    return this.candidates.map(c=>({...c,localCacheIds:media.filter(e=>e.availability==='available'&&candidateMatchesMedia(c,e)).map(e=>e.id)})).sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt));
  }
  async markAcquisition(id,job){
    const candidate=this.candidates.find(c=>c.id===id);if(!candidate)return;
    candidate.acquisition={jobId:job.id,status:job.status,startedAt:job.startedAt,completedAt:job.completedAt||null,error:job.error||'',summary:job.summary||''};
    await this.persist();
  }
  async remember(source,run){
    const file=await contained(source.localPath||source.local_path,run),ext=path.extname(file).toLowerCase();
    if(!mediaExtensions.has(ext))throw new Error('仅缓存有效的视频、图片或音频。');
    if((await stat(file)).size>350*1024*1024)throw new Error('单个缓存素材不能超过 350 MB。');
    const checked=await this.inspect(file),details=metadata(source);
    if(source.sha256&&checked.sha256!==source.sha256)throw new Error('原素材已经变化，未加入缓存。');
    verifySourceIdentity(checked,details);
    let entry=this.entries.find(e=>e.sha256===checked.sha256);
    const folder=path.join(this.directory,'files');await mkdir(folder,{recursive:true});await contained(folder,this.directory);
    const destination=path.join(folder,checked.sha256+ext);
    let valid=false;try{valid=await fileHash(await contained(entry?.localPath||destination,this.directory))===checked.sha256;}catch{}
    if(!valid){const temporary=destination+'.'+randomUUID()+'.part';try{await copyFile(file,temporary);if(await fileHash(temporary)!==checked.sha256)throw new Error('复制后的素材校验失败。');await rename(temporary,destination);}finally{await unlink(temporary).catch(()=>{});}}
    const origin={run:path.resolve(run),sourceId:String(source.id||''),title:details.title,url:details.url};
    if(entry){
      if(!valid)entry.localPath=destination;
      entry.origins||=[];if(!entry.origins.some(o=>o.run===origin.run&&o.sourceId===origin.sourceId))entry.origins.push(origin);
    }else{
      entry={...details,id:'cache-'+checked.sha256.slice(0,24),status:'ready',
        kind:mimeTypes[ext]?.startsWith('image/')?'image':checked.hasVideo?'video':'audio',
        sha256:checked.sha256,bytes:checked.bytes,duration:checked.duration,width:checked.width,height:checked.height,
        end:details.end||checked.duration,localPath:destination,thumbnailPath:null,cachedAt:new Date().toISOString(),origins:[origin]};
      this.entries.unshift(entry);
    }
    if(checked.hasVideo&&!entry.thumbnailPath){
      const thumbnail=path.join(this.directory,'previews',entry.id+'.jpg');await mkdir(path.dirname(thumbnail),{recursive:true});await contained(path.dirname(thumbnail),this.directory);
      try{await execute('ffmpeg',['-v','error','-y','-ss',String(entry.kind==='image'?0:Math.min(.5,checked.duration/3)),'-i',entry.localPath,'-frames:v','1','-vf','scale=480:-2',thumbnail],{timeout:30000});entry.thumbnailPath=thumbnail;}catch{}
    }
    const linked=this.candidates.filter(c=>c.id===source.candidateCacheId||candidateMatchesMedia(c,entry));
    entry.candidateIds=[...new Set([...(entry.candidateIds||[]),...linked.map(c=>c.id)])];
    const info=await stat(entry.localPath);entry.mtimeMs=info.mtimeMs;
    await this.persist();return entry;
  }
  async list(){
    return await Promise.all(this.entries.map(async entry=>{
      let availability='available';try{const file=await contained(entry.localPath,this.directory),info=await stat(file);if(!info.isFile()||info.size!==entry.bytes||info.mtimeMs!==entry.mtimeMs)availability='changed';}catch{availability='missing';}
      return {...entry,availability};
    }));
  }
  async resolve(id,thumbnail=false){
    const entry=this.entries.find(e=>e.id===id);if(!entry)throw new Error('缓存素材不存在。');
    const actual=await contained(entry.localPath,this.directory);
    if(await fileHash(actual)!==entry.sha256)throw new Error('缓存文件已经变化，请重新采集。');
    const info=await stat(actual);if(info.size!==entry.bytes)throw new Error('缓存文件大小已变化，请重新采集。');
    if(thumbnail){if(!entry.thumbnailPath)throw new Error('暂无缩略图。');return {entry,file:await contained(entry.thumbnailPath,this.directory)};}
    return {entry,file:actual};
  }
  async importRun(run){
    const record=JSON.parse(await readFile(path.join(run,'run.json'),'utf8'));const imported=[],errors=[];
    let reports=[];try{reports=await readdir(path.join(run,'source-searches'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!reports.length)await this.rememberCandidates(record.sources||[],{run,topic:record.brief?.topic,style:record.brief?.style,reviewedAt:record.updated_at||record.created_at,query:'历史运行来源'});
    for(const name of reports.filter(name=>name.endsWith('.json')))try{
      const report=JSON.parse(await readFile(path.join(run,'source-searches',name),'utf8'));
      if(Array.isArray(report.sources))await this.rememberCandidates(report.sources,{...report,run,jobId:report.jobId||path.basename(name,'.json')});
    }catch(e){errors.push({title:name,error:e.message});}
    for(const source of record.sources||[]){
      const download=Object.values(record.downloads||{}).find(d=>d.source_id===source.id&&d.status==='completed');
      const file=source.local_path||source.localPath||download?.path;if(!file)continue;
      try{const entry=await this.remember({...source,localPath:file,sha256:source.sha256||download?.sha256,start:source.start??source.source_start_seconds??download?.start,end:source.end??source.source_end_seconds??download?.end},run);imported.push(entry.id);}
      catch(e){errors.push({title:source.title||source.id,error:e.message});}
    }
    return {imported:[...new Set(imported)],errors};
  }
  async backfill(runsDirectory){
    let names;try{names=await readdir(runsDirectory,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
    for(const folder of names.filter(f=>f.isDirectory()))try{
      const result=await this.importRun(path.join(runsDirectory,folder.name));this.errors.push(...result.errors);
    }catch(e){if(e.code!=='ENOENT')this.errors.push({title:folder.name,error:e.message});}
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2),dataDir=args[args.indexOf('--data-dir')+1],run=args[args.indexOf('--run')+1];
  if(!args.includes('--data-dir')||!args.includes('--run')||!dataDir||!run)throw new Error('Usage: node library.mjs --data-dir <workbench-data> --run <actual-run>');
  const {findPlugin,createPluginBridge}=await import('./plugin.mjs');
  const plugin=await findPlugin(path.dirname(fileURLToPath(import.meta.url))),bridge=createPluginBridge(plugin,path.join(dataDir,'requests'));
  const library=await new MediaLibrary(path.join(dataDir,'material-library'),file=>bridge('inspect-media',{file})).init();
  console.log(JSON.stringify(await library.importRun(path.resolve(run)),null,2));
}
