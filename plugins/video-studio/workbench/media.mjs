import {createReadStream,createWriteStream} from 'node:fs';
import {stat,realpath,mkdir,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform,Readable} from 'node:stream';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';

export const mediaExtensions=new Set(['.mp4','.mov','.webm','.mkv','.m4v','.jpg','.jpeg','.png','.webp','.gif','.mp3','.wav','.m4a','.aac','.ogg']);
export const mimeTypes={'.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.m4v':'video/mp4','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.srt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8','.json':'application/json; charset=utf-8'};
export async function fileHash(file){const hash=createHash('sha256');for await(const block of createReadStream(file))hash.update(block);return hash.digest('hex');}
export async function contained(file,root){const [a,b]=await Promise.all([realpath(file),realpath(root)]);if(a!==b && !a.startsWith(b+path.sep))throw new Error('文件不在本期工作目录中。');return a;}
export function privateAddress(ip){
  const address=ip.replace(/^\[|\]$/g,'').toLowerCase();
  if(net.isIP(address)===4){const [a,b]=address.split('.').map(Number);return a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a>=224;}
  if(net.isIP(address)===6)return address==='::'||address==='::1'||address.startsWith('fc')||address.startsWith('fd')||/^fe[89ab]/.test(address)||address.startsWith('ff')||address.startsWith('::ffff:');
  return true;
}
export async function publicUrl(raw){
  const url=new URL(raw);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('请使用不含账号信息的公开 HTTP(S) 链接。');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(host==='localhost'||host.endsWith('.local')||host.endsWith('.internal'))throw new Error('素材链接需要指向公开网站。');
  const addresses=net.isIP(host)?[{address:host}]:await dns.lookup(host,{all:true});
  if(!addresses.length||addresses.some(a=>privateAddress(a.address)))throw new Error('不支持访问内网或本机服务作为网络素材。');
  return url.href;
}
export async function saveUpload(readable,destination,maxBytes=350*1024*1024){
  let count=0;
  const limiter=new Transform({transform(chunk,encoding,callback){count+=chunk.length;callback(count>maxBytes?new Error('单个文件不能超过 350 MB。'):null,chunk);}});
  await mkdir(path.dirname(destination),{recursive:true});
  try{await pipeline(readable,limiter,createWriteStream(destination,{flags:'wx'}));if(!count)throw new Error('文件为空。');return count;}
  catch(e){await unlink(destination).catch(()=>{});throw e;}
}
export async function downloadPublic(raw,destination){
  let url=raw;
  for(let n=0;n<6;n++){
    url=await publicUrl(url);
    const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(120000),headers:{'User-Agent':'VideoStudioWorkbench/0.3'}});
    if([301,302,303,307,308].includes(response.status)){const target=response.headers.get('location');await response.body?.cancel();if(!target)throw new Error('下载跳转缺少目标地址。');url=new URL(target,url).href;continue;}
    if(!response.ok)throw new Error(`素材下载失败（HTTP ${response.status}）。`);
    if(!response.body)throw new Error('下载没有返回文件内容。');
    if(Number(response.headers.get('content-length'))>350*1024*1024){await response.body.cancel();throw new Error('素材超过 350 MB，请缩短采集范围。');}
    await saveUpload(Readable.fromWeb(response.body),destination);return {contentType:response.headers.get('content-type'),url};
  }
  throw new Error('素材链接跳转次数过多。');
}
export async function streamFile(req,res,file,{download=false,name}={}){
  const info=await stat(file);if(!info.isFile())throw new Error('文件不存在。');
  const headers={'Content-Type':mimeTypes[path.extname(file).toLowerCase()]||'application/octet-stream','Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'};
  if(download)headers['Content-Disposition']=`attachment; filename*=UTF-8''${encodeURIComponent(name||path.basename(file))}`;
  const range=req.headers.range;
  if(range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    let start,end;
    if(!match || (!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});return res.end();}
    if(!match[1]){const suffix=Number(match[2]);start=Math.max(0,info.size-suffix);end=info.size-1;}else{start=Number(match[1]);end=match[2]?Number(match[2]):info.size-1;}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=info.size){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});return res.end();}
    end=Math.min(end,info.size-1);res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${info.size}`,'Content-Length':end-start+1});
    if(req.method==='HEAD')return res.end();createReadStream(file,{start,end}).on('error',()=>res.destroy()).pipe(res);return;
  }
  res.writeHead(200,{...headers,'Content-Length':info.size});
  if(req.method==='HEAD')return res.end();createReadStream(file).on('error',()=>res.destroy()).pipe(res);
}
