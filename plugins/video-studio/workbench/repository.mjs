import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile);
export const repository='chchenghuiguo-alt/video-daily';
async function github(endpoint){
  try{const {stdout}=await execute('gh',['api',`repos/${repository}/${endpoint}`],{timeout:20000,maxBuffer:8*1024*1024});return JSON.parse(stdout);}
  catch{throw new Error('无法读取每日素材仓库，请检查本机 GitHub CLI 的连接后重试；已有缓存仍可浏览。');}
}
async function parallel(items,fn){let next=0;const results=new Array(items.length);await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{while(next<items.length){const i=next++;results[i]=await fn(items[i]);}}));return results;}
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}/.test(value)&&Number.isFinite(Date.parse(value));

// Read only known text paths at one commit. No media endpoint, LFS download or repository scripts.
export async function repositoryCatalog(read=github,now=new Date()){
  const commit=(await read('commits/HEAD')).sha;
  if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('每日仓库没有返回有效版本。');
  const tree=await read(`git/trees/${commit}?recursive=1`);
  if(tree.truncated||!Array.isArray(tree.tree))throw new Error('每日仓库目录不完整，本次未更新缓存。');
  const paths=new Set(tree.tree.filter(f=>f.type==='blob').map(f=>f.path));
  const text=async p=>{
    if(!paths.has(p))throw new Error(`仓库缺少 ${p}`);
    const result=await read(`contents/${p}?ref=${commit}`);
    if(result.encoding!=='base64'||typeof result.content!=='string')throw new Error(`无法读取 ${p} 的文本记录。`);
    return Buffer.from(result.content,'base64').toString('utf8');
  };
  const rules=await parallel(['README.md','AGENTS.md','schema/manifest.schema.json','schema/meta.schema.json'],text);
  if(JSON.parse(rules[2]).type!=='object'||JSON.parse(rules[3]).type!=='object')throw new Error('仓库数据规范无法识别。');
  const manifests=[...paths].filter(p=>/^\d{4}\/\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(p)).sort().reverse();
  const sources=[],batches=[],errors=[];
  for(const file of manifests){
    const folder=file.slice(0,-'/manifest.json'.length),date=folder.split('/')[1];
    try{
      const manifest=JSON.parse(await text(file));
      if(manifest.schema_version!==2||manifest.date!==date||!['ready','pending'].includes(manifest.status)||!Array.isArray(manifest.items))throw new Error('清单格式不符合当前规范。');
      const batch={date,status:manifest.status,total:manifest.items.length,imported:0};batches.push(batch);
      if(manifest.status!=='ready')continue;
      const records=await parallel(manifest.items,async item=>{
        try{
          if(!/^\d{3}$/.test(item.id))throw new Error('条目编号无效。');
          const base=folder+'/'+item.id;
          const [metaText,post]=await Promise.all([text(base+'/meta.json'),text(base+'/post.md')]);
          const meta=JSON.parse(metaText),url=new URL(meta.source_url);
          if(meta.schema_version!==2||meta.id!==item.id||meta.date!==date||!meta.title||url.protocol!=='https:'||!['x.com','twitter.com','www.x.com','www.twitter.com'].includes(url.hostname)||url.username||url.password||!Array.isArray(meta.media)||!Array.isArray(meta.verification))throw new Error('条目元数据或原帖链接无效。');
          const media=meta.media.map(m=>{
            if(!/^(videos\/\d{2}\.mp4|images\/\d{2}\.jpg)$/.test(m.file)||!paths.has(base+'/'+m.file)||!['video','image'].includes(m.type)||!Number.isSafeInteger(m.bytes)||m.bytes<=0||! /^[a-f0-9]{64}$/.test(m.sha256))throw new Error('媒体记录不完整。');
            return {file:base+'/'+m.file,type:m.type,sha256:m.sha256,bytes:m.bytes,width:m.w,height:m.h,duration:m.duration||0};
          });
          const primary=media.find(m=>m.type==='video')||media[0],image=media.find(m=>m.type==='image');
          const mediaUrl=p=>`https://media.githubusercontent.com/media/${repository}/${commit}/${p}`;
          return {id:`repo-${date}-${item.id}`,title:meta.title,kind:primary?.type||'article',url:url.href,mediaUrl:primary?mediaUrl(primary.file):'',thumbnailUrl:image?mediaUrl(image.file):'',
            description:meta.summary||'',author:meta.source||'',rights:meta.license_note||'unknown',publishedAt:validDate(meta.published_at)?meta.published_at:'',collectedAt:validDate(meta.collected_at)?meta.collected_at:'',batchDate:date,
            sourceType:'x_repository',repositoryCommit:commit,repositoryPath:primary?.file||base+'/meta.json',expectedSha256:primary?.sha256||'',expectedBytes:primary?.bytes||0,
            repositoryMedia:media,postText:post.slice(0,16000),verification:`仓库原帖记录：${meta.verify_status||'unverified'}；已读取 post.md / meta.json，未复核原帖事实或观看媒体。`,
            caveats:meta.verification,needIds:[],topicFit:'',styleFit:'',eventDate:'',dateEvidence:meta.published_at?`原帖时间来自 meta.published_at；${date} 是仓库收集批次，不等于事件发生日。`:'原帖发布日期缺失；批次日期不作为发布日期。',start:0,end:0};
        }catch(e){errors.push({title:`${date}/${item.id}`,error:e.message});return null;}
      });
      const imported=records.filter(Boolean);sources.push(...imported);batch.imported=imported.length;
    }catch(e){errors.push({title:date,error:e.message});}
  }
  return {sources,coverage:{repository,commit,checkedAt:now.toISOString(),batches,errors,sourceCount:sources.length}};
}
