import path from 'node:path';
import {stat} from 'node:fs/promises';
import {mediaTool,run} from './media-runtime.mjs';

export const robotics=/机器人|机械手|具身|宇树|优必选|机器人|人形|robot(?:ics|s)?|humanoid|unitree|boston dynamics|optimus|figure ai|agility robotics/i;
const repo='chchenghuiguo-alt/video-daily',api='https://api.github.com/repos/'+repo;
const tokens=q=>String(q).toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]{2}/gu)||[];
const score=(title,q)=>tokens(q).reduce((n,t)=>n+(title.toLowerCase().includes(t)?t.length:0),0);
const posted=f=>Date.parse(f.date)||0;
export async function dailySources(query,{readJson,signal,kind}) {
  const {sha}=await readJson(api+'/commits/HEAD',signal);
  if(!/^[0-9a-f]{40}$/.test(sha))throw Error('素材仓库版本读取失败。');
  const dir=async p=>readJson(api+'/contents/'+p+'?ref='+sha,signal);
  const year=(await dir('')).map(r=>r.name).filter(v=>/^20\d\d$/.test(v)).sort().at(-1);
  if(!year)return [];
  const days=(await dir(year)).map(r=>r.name).filter(v=>/^20\d\d-\d\d-\d\d$/.test(v)).sort().reverse().slice(0,4);
  const raw='https://raw.githubusercontent.com/'+repo+'/'+sha+'/';
  const results=[];
  for(const day of days){
    const prefix=year+'/'+day+'/';
    const m=await readJson(raw+prefix+'manifest.json',signal);
    if(m.status!=='ready'||!Array.isArray(m.items))continue;
    let candidates=m.items.filter(i=>/^\d{1,6}$/.test(i.id)&&(kind!=='video'||i.has_video!==false)&&(m.selection!=='selected'||i.selected===true||m.order?.includes(i.id)));
    candidates.sort((a,b)=>score(b.title,query)-score(a.title,query));
    const selected=candidates.slice(0,4);
    const metas=await Promise.all(selected.map(i=>readJson(raw+prefix+i.id+'/meta.json',signal)));
    for(const [i,meta] of metas.entries()){
      if(!/^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(meta.source_url||''))continue;
      for(const media of meta.media||[]){
        if(media.type!==kind||!/^([\w.-]+\/)*[\w.-]+$/.test(media.file)||media.file.split('/').some(x=>x==='.'||x==='..')||!/^\w{64}$/.test(media.sha256)||!(media.bytes>0))continue;
        const key=prefix+selected[i].id+'/'+media.file;
        results.push({provider:'每日 X 素材仓库',kind,title:meta.title||selected[i].title,statement:meta.summary||'',url:meta.source_url,
          downloadUrl:'https://media.githubusercontent.com/media/'+repo+'/'+sha+'/'+key,alternateUrls:[raw+key],expectedSha256:media.sha256,expectedBytes:media.bytes,
          credit:meta.credit,license:meta.license_note||'使用范围待核',date:meta.published_at||'',eventDate:meta.event_date||'',collectedAt:meta.collected_at||day,
          verification:meta.verification,verifyStatus:meta.verify_status,commit:sha,evidenceLevel:'publisher-post'});
      }
    }
    if(results.length>=4)break;
  }
  return results.sort((a,b)=>score(b.title,query)-score(a.title,query)||posted(b)-posted(a));
}
export function youtubeId(input) {
  try{
    const url=new URL(input);
    if(url.protocol!=='https:'||url.username||url.password||url.port)return;
    const id=url.hostname==='youtu.be'?url.pathname.slice(1):['www.youtube.com','youtube.com','m.youtube.com'].includes(url.hostname)&&url.pathname==='/watch'?url.searchParams.get('v'):'';
    if(/^[\w-]{11}$/.test(id||''))return id;
  }catch{}
}
export async function youtubeSources(query,{signal,execute=run,resolve=mediaTool}={}){
  const exe=await resolve('yt-dlp');
  if(!exe)throw Error('YouTube 区间工具 yt-dlp 尚未安装。');
  const id=youtubeId(query);
  const out=await execute(exe,['--ignore-config','--skip-download','--no-playlist',...(id?[]:['--flat-playlist']),'--dump-json','--socket-timeout','8','--retries','0','--',id?'https://www.youtube.com/watch?v='+id:'ytsearch4:'+query],{signal,maxOutput:6*1024*1024});
  return out.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(v=>/^[\w-]{11}$/.test(v.id)).map(v=>{
    const url='https://www.youtube.com/watch?v='+v.id;
    return {provider:'YouTube',youtubeId:v.id,url,downloadUrl:url,kind:'video',title:v.title||'',statement:v.description?.slice(0,900)||'',
      credit:v.channel||v.uploader||'',license:v.license||'使用范围待核',date:v.upload_date||'',eventDate:'',duration:v.duration,evidenceLevel:'publisher-upload'};
  });
}
export async function acquireYoutube(candidate,temp,window,{signal,resolve=mediaTool,execute=run,probe}){
  if(!window||!Number.isFinite(window.start)||!Number.isFinite(window.end)||window.start<0||window.end<=window.start||window.end-window.start>300)
    throw Error('请选择最多五分钟的原片区间。');
  const id=youtubeId(candidate.url);
  if(!id||id!==candidate.youtubeId)throw Error('无效的视频来源。');
  const deadline=AbortSignal.timeout(180000),opts={signal:signal?AbortSignal.any([signal,deadline]):deadline};
  const url='https://www.youtube.com/watch?v='+id;
  const exe=await resolve('yt-dlp'),ff=await resolve('ffmpeg');
  if(!exe||!ff)throw Error('此来源需要本机 yt-dlp 与 FFmpeg。');
  const [metadata]=await youtubeSources(url,{...opts,execute,resolve});
  if(!metadata||(!/creative commons|cc[- ]by/i.test(metadata.license)&&candidate.userAuthorized!==true))throw Error('原片尚无可确认的使用授权，请选有相应许可的来源或在工程中提供已获授权的原片地址。');
  const file=path.join(temp,'source.mp4');
  await execute(exe,['--ignore-config','--no-playlist','--no-progress','--retries','1','--socket-timeout','12','--max-filesize','256M','--ffmpeg-location',ff,'--download-sections','*'+window.start+'-'+window.end,'--force-keyframes-at-cuts','-f','bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]','--merge-output-format','mp4','--remux-video','mp4','-o',file,'--',url],opts);
  const actual=await probe(file,opts);
  if(actual.kind!=='video'||Math.abs(actual.duration-(window.end-window.start))>1||(await stat(file)).size>256*1024*1024)throw Error('取得的源片段与登记区间不一致。');
  return {file,source:{...candidate,...metadata,sourceOffsetSeconds:window.start,sourceEndSeconds:window.end,sourceWindow:window}};
}
