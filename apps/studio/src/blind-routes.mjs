import {createReadStream} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';

const ui=new URL('./blind-ui/',import.meta.url);
async function body(req) {
  const chunks=[];let total=0;
  for await(const b of req) {total+=b.length;if(total>1_000_000) throw Error('研究样本清单过大');chunks.push(b);}
  return JSON.parse(Buffer.concat(chunks).toString());
}
function json(res,value,status=200) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(value));
}
async function movie(req,res,file) {
  const {size}=await stat(file);
  const mime=({'.mov':'video/quicktime','.webm':'video/webm'})[path.extname(file).toLowerCase()]||'video/mp4';
  const headers={'content-type':mime,'accept-ranges':'bytes','cache-control':'private, no-store','x-content-type-options':'nosniff'};
  let start=0,end=size-1,code=200;
  if(req.headers.range) {
    const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!range||(!range[1]&&!range[2])) {res.writeHead(416,{'content-range':'bytes */'+size});res.end();return;}
    start=range[1]?Number(range[1]):Math.max(0,size-Number(range[2]));
    end=range[1]&&range[2]?Math.min(Number(range[2]),size-1):size-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start<0||end>=size){res.writeHead(416,{'content-range':'bytes */'+size});res.end();return;}
    code=206;headers['content-range']='bytes '+start+'-'+end+'/'+size;
  }
  res.writeHead(code,{...headers,'content-length':end-start+1});
  if(req.method==='HEAD') {res.end();return;}
  await pipeline(createReadStream(file,{start,end}),res).catch(e=>{if(e.code!=='ERR_STREAM_PREMATURE_CLOSE'&&e.code!=='ECONNRESET') throw e;});
}
export function createBlindRoutes({blind,store}) {
  function candidates() {
    return store.listJobs().filter(j=>j.status==='done'&&j.files?.video&&j.qa?.candidatePlayable&&j.kind!=='preview').map(j=>{
      const p=store.get(j.projectId);
      return {projectId:p.id,jobId:j.id,title:p.title,mode:p.mode,revision:j.revision,createdAt:j.createdAt};
    });
  }
  function candidate(projectId,jobId) {
    if(typeof projectId!=='string'||typeof jobId!=='string') throw Error('请选择已登记成片');
    const j=store.getJob(jobId),p=store.get(projectId);
    if(!p||!j||j.projectId!==p.id||j.status!=='done'||!j.files?.video||!j.qa?.candidatePlayable || j.kind==='preview') throw Error('候选未登记为可播放成片');
    const rel=path.relative(store.paths(projectId).outputs,j.files.video);
    if(!rel || rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)) throw Error('候选文件未绑定工程输出');
    return {videoPath:j.files.video,mode:p.mode,systemStatus:j.qa.status,systemIssues:j.qa.issues||[]};
  }
  async function create(data) {
    if(!Array.isArray(data.samples)||data.samples.length>100) throw Error('样本清单无效');
    const rows=data.samples.map(s=>{
      const base=candidate(s.projectId,s.jobId);
      if(data.kind==='pair') {
        const other=candidate(s.comparisonProjectId,s.comparisonJobId);
        if(s.jobId===s.comparisonJobId) throw Error('请选择两个不同的候选');
        return {...base,comparisonPath:other.videoPath,primary:s.primary};
      }
      return {...base,expected:s.expected,topicGroup:s.topicGroup};
    });
    return blind.create({kind:data.kind,title:data.title,samples:rows,choices:data.choices});
  }
  return async function handleBlind(req,res,url) {
    try {
      if(req.method==='GET'&&['/blind','/blind/','/blind/app.js','/blind/styles.css'].includes(url.pathname)) {
        const filename=url.pathname.endsWith('.js')?'app.js':url.pathname.endsWith('.css')?'styles.css':'index.html';
        const data=await readFile(new URL(filename,ui));
        const type=filename==='app.js'?'text/javascript':filename==='styles.css'?'text/css':'text/html';
        res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(data);return;
      }
      if(req.method==='GET'&&url.pathname==='/api/blind/candidates') {json(res,candidates());return;}
      if(url.pathname==='/api/blind/studies') {
        if(req.method==='GET') {json(res,await blind.list());return;}
        if(req.method==='POST') {json(res,await create(await body(req)),201);return;}
      }
      const m=/^\/api\/blind\/studies\/([a-f0-9-]{36})\/(session|rating|media|summary)$/.exec(url.pathname);
      if(!m) {json(res,{error:'盲评入口不存在'},404);return;}
      const [,id,action]=m,name=url.searchParams.get('reviewer')||'';
      if(action==='session'&&req.method==='POST') {json(res,await blind.open(id,(await body(req)).reviewer));return;}
      if(action==='rating'&&req.method==='POST') {const input=await body(req);json(res,await blind.rate(id,input.reviewer,input));return;}
      if(action==='summary'&&req.method==='GET') {json(res,await blind.summary(id));return;}
      if(action==='media'&&['GET','HEAD'].includes(req.method)) {await movie(req,res,await blind.media(id,name,url.searchParams.get('code'),url.searchParams.get('side')||'A'));return;}
      json(res,{error:'此方法不适用'},405);
    } catch(error) {
      if(!res.headersSent) json(res,{error:error.code==='ENOENT'?'找不到研究或候选文件':String(error.message||'无法完成盲评请求').slice(0,400)},error.code==='ENOENT'?404:400);
    }
  };
}
