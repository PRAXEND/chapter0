import {mkdir,writeFile,stat,copyFile,rename,unlink} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileHash,contained} from './media.mjs';
import {repository} from './repository.mjs';

const mediaPath=/^(\d{4}\/\d{4}-\d{2}-\d{2})\/(\d{3})\/(videos\/\d{2}\.mp4|images\/\d{2}\.jpg)$/;
const maxBytes=350*1024*1024;
const execute=promisify(execFile);
// curl honours the user's standard proxy environment on Node 20 as well as 24.
// Native fetch ignores it on several supported Node releases and can stall.
const curlArgs=['--disable','--fail','--silent','--show-error','--connect-timeout','10','--max-time','120','--max-redirs','0'];
export function canCollectRepository(source){
  return source?.sourceType==='x_repository' && /^[a-f0-9]{40}$/.test(source.repositoryCommit||'') &&
    mediaPath.test(source.repositoryPath||'') && /^[a-f0-9]{64}$/.test(source.expectedSha256||'') &&
    Number.isSafeInteger(source.expectedBytes)&&source.expectedBytes>0;
}
const rawUrl=(commit,file)=>`https://raw.githubusercontent.com/${repository}/${commit}/${file}`;
export async function readRepositoryText(url,signal){
  try{const {stdout}=await execute('curl',[...curlArgs,'--max-time','20',url],{signal,timeout:25000,maxBuffer:256*1024});return stdout;}
  catch(e){if(signal?.aborted)throw signal.reason;throw new Error(`仓库记录读取失败（${e.code==='ENOENT'?'缺少 curl':e.code||'超时'}），请检查网络连接。`);}
}
export async function downloadRepositoryMedia(url,file,{signal,bytes}){
  signal?.throwIfAborted();
  const child=spawn('curl',[...curlArgs,'--max-filesize',String(bytes),url],{signal,stdio:['ignore','pipe','ignore']});
  const completion=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`素材下载失败（curl ${code}），请检查网络、访问状态或预期大小。`)));});
  completion.catch(()=>{});
  let received=0;
  const limiter=new Transform({transform(chunk,encoding,callback){received+=chunk.length;callback(received>bytes?new Error('下载超过预期大小。'):null,chunk);}});
  try{await pipeline(child.stdout,limiter,createWriteStream(file,{flags:'wx'}),{signal});await completion;}
  finally{if(child.exitCode===null)child.kill();await completion.catch(()=>{});}
}

// Acquisition is mechanical once the user chooses a pinned file. It must not run
// another model search, clone a repository or download the rest of the batch.
export async function collectRepository(context,{signal,event=()=>{},inspect,decode,reuse=async()=>null,
  readText=readRepositoryText,download=downloadRepositoryMedia}={}){
  const source=context.source;
  if(!canCollectRepository(source))throw new Error('所选仓库素材缺少固定版本和校验信息。');
  if(source.expectedBytes>maxBytes)throw new Error('单条素材超过 350 MB，请选择较小的素材。');
  signal?.throwIfAborted();
  const [,folder,item,relative]=mediaPath.exec(source.repositoryPath),base=folder+'/'+item,commit=source.repositoryCommit;
  event('verification','核对所选条目的固定版本清单、元数据和 LFS 指针');
  const [manifestText,metaText,pointer]=await Promise.all([
    readText(rawUrl(commit,folder+'/manifest.json'),signal),readText(rawUrl(commit,base+'/meta.json'),signal),
    readText(rawUrl(commit,source.repositoryPath),signal)
  ]);
  const manifest=JSON.parse(manifestText),meta=JSON.parse(metaText),date=folder.split('/')[1];
  if(manifest.schema_version!==2||manifest.status!=='ready'||manifest.date!==date||!manifest.items?.some(i=>i.id===item))throw new Error('所选素材不在固定版本的 ready 清单中。');
  const media=meta.media?.find(m=>m.file===relative);
  if(meta.schema_version!==2||meta.id!==item||meta.date!==date||meta.source_url!==source.url||
    !media||media.sha256!==source.expectedSha256||media.bytes!==source.expectedBytes||media.type!==(relative.startsWith('videos/')?'video':'image')||
    !Number.isInteger(media.w)||media.w<=0||!Number.isInteger(media.h)||media.h<=0)throw new Error('所选素材与固定版本元数据不一致。');
  const oid=/^oid sha256:([a-f0-9]{64})$/m.exec(pointer),size=/^size (\d+)$/m.exec(pointer);
  if(!pointer.startsWith('version https://git-lfs.github.com/spec/v1\n')||oid?.[1]!==media.sha256||Number(size?.[1])!==media.bytes)throw new Error('LFS 指针与所选素材的哈希或大小不一致。');
  const budget=context.brief.requirements.max_download_seconds;
  if(media.type==='video'&&(!Number.isFinite(media.duration)||media.duration<=0||media.duration>budget))throw new Error('完整源视频超过本次采集时长预算或缺少时长，请使用有界片段采集。');
  if(media.type==='video'&&((context.acquisitionUsage?.videoSeconds||0)+media.duration>budget||
    (context.acquisitionUsage?.videoSources||0)+1>context.brief.requirements.max_video_sources))throw new Error('本期已采集的视频加上该原片会超过来源数或总时长预算。');
  const materials=path.join(context.run,'materials');await mkdir(materials,{recursive:true});await contained(materials,context.run);
  const file=path.join(materials,media.sha256+path.extname(relative));
  const matches=async f=>{try{const actual=await contained(f,context.run);return (await stat(actual)).size===media.bytes&&await fileHash(actual)===media.sha256;}catch{return false;}};
  let method='verified_run_file';
  if(!await matches(file)){
    // Do not overwrite an unrelated or modified file, even at a content-addressed path.
    try{await stat(file);throw new Error('同名本地素材已变化，请检查文件后重试。');}catch(e){if(e.code!=='ENOENT')throw e;}
    const temporary=file+'.'+randomUUID()+'.part';
    try{
      const cached=await reuse(source);signal?.throwIfAborted();
      if(cached){event('cache','复用已校验的本地素材');await copyFile(cached,temporary);method='verified_cache';}
      else{event('download','直接下载所选媒体，保留原件和源区间');method='public_lfs';await download(`https://media.githubusercontent.com/media/${repository}/${commit}/${source.repositoryPath}`,temporary,{signal,bytes:media.bytes});}
      signal?.throwIfAborted();if(!await matches(temporary))throw new Error('素材下载不完整或 SHA-256 不匹配。');
      await rename(temporary,file);
    }finally{await unlink(temporary).catch(()=>{});}
  }
  signal?.throwIfAborted();event('verification','校验实际规格与完整解码');
  const checked=await inspect(file);
  if(checked.sha256!==media.sha256||checked.bytes!==media.bytes||checked.width!==media.w||checked.height!==media.h||
    media.type==='video'&&(!checked.hasVideo||!Number.isFinite(checked.duration)||checked.duration<=0||Math.abs(checked.duration-media.duration)>.15))throw new Error('素材实际规格与元数据不一致。');
  const start=Number(source.start)||0,end=Number(source.end)||checked.duration;
  if(media.type==='video'&&(start>=checked.duration||end>checked.duration+.1||end<=start))throw new Error('所选源区间超出实际视频长度。');
  await decode(file,signal);signal?.throwIfAborted();
  const report={repository,commit,repositoryPath:source.repositoryPath,sourceUrl:source.url,method,
    expected:{sha256:media.sha256,bytes:media.bytes},actual:checked,decodeVerified:true,
    originalFilePreserved:true,selectedRange:{start,end},visualReview:'unverified',facts:'unverified',rights:source.rights||'unknown'};
  const reports=path.join(context.run,'acquisition');await mkdir(reports,{recursive:true});await contained(reports,context.run);
  const reportPath=path.join(reports,commit+'-'+media.sha256+'.json');await writeFile(reportPath,JSON.stringify(report,null,2));
  return {summary:'所选媒体已直接采集并校验，未重新搜索；原件完整保留，画面和事实仍需审阅。',sources:[{...source,localPath:file,start,end,
    acquisitionReport:reportPath,verification:'固定版本 ready 清单、meta、LFS 指针、大小、SHA-256、规格与完整解码一致；未替代画面/事实/权利审阅。'}]};
}

// Keep a single-source agent's request bounded even when the catalog contains
// hundreds of posts. Discovery still receives the complete candidate metadata.
export function scopedCollectionContext(context){
  const source=context.source,related=s=>s.id===source.id||s.url===source.url||source.expectedSha256&&s.sha256===source.expectedSha256;
  return {...context,knownSources:(context.knownSources||[]).filter(related),selectedSources:[],plan:null,
    sourceReview:context.sourceReview?{...context.sourceReview,events:(context.sourceReview.events||[]).filter(e=>e.source_ids?.includes(source.id))}:null};
}
