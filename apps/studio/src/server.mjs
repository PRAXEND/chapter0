import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {voiceLibrary} from './voices.mjs';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,rm,stat,readdir,realpath,open} from 'node:fs/promises';
import {createStore,defaultRoot,fault} from './project.mjs';
import {createQueue} from './jobs.mjs';
import {draftPreviews} from './draft-preview.mjs';
import {capturePreference} from './style-preference.mjs';
import {compileSceneWithSound} from './scene-sound.mjs';
import {legacyLibrary} from './library.mjs';
import {createMusic} from './music.mjs';
import * as media from './media.mjs';
import * as audio from './audio.mjs';
import {createDirector} from './production.mjs';
import {createStyleLibrary} from './style.mjs';
import {reviewProject} from './review.mjs';
import {streamFile,saveUpload,downloadPublic,contained} from '../../../plugins/video-studio/workbench/media.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const web=path.resolve(here,'../www');
const json=(res,obj,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
async function readJson(req){
  let size=0,blocks=[];
  for await(const block of req){size+=block.length;if(size>3*1024*1024)throw fault('请求太大。',413);blocks.push(block);}
  try{return blocks.length?JSON.parse(Buffer.concat(blocks)):{};}catch{throw fault('请求内容无效。',400);}
}
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function disclose(p){return {...p,assets:p.assets.map(({path,...a})=>a)};}
function exposeJob(j){const {snapshot,priorCandidates,published,...safe}=j;return {...safe,creativeEngine:j.creativeResult?.engine||(['produce','revise'].includes(j.kind)?j.input?.engine:snapshot?.lastDirection?.engine),publishedFolder:published?.video?path.dirname(published.video):undefined,files:j.files?Object.keys(j.files):[]};}
function openWithMac(file,reveal=false){
  if(process.platform!=='darwin')throw fault('系统打开操作需要 macOS。');
  const child=spawn('/usr/bin/open',reveal?['-R',file]:[file],{stdio:'ignore',detached:true});child.unref();
}
async function nativeOwner(root) {
  await mkdir(root,{recursive:true,mode:0o700});
  // SQLite owns the OS file lock. A crash releases it even if startup never wrote a PID.
  const lease=new DatabaseSync(path.join(root,'service-owner.sqlite'));
  try{lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER);');}
  catch(e){lease.close();if(e.errcode===5||e.errcode===6||/locked|busy/i.test(e.message))throw fault('此资料库已由打开的工作台管理。',409);throw e;}
  return async()=>{lease.exec('ROLLBACK');lease.close();};
}
export async function startStudio({root=defaultRoot(),port=0,legacyRoot,dependencies={},owner=true}={}) {
  const release=owner?await nativeOwner(root):async()=>{};
  const store=createStore(root,{probeMedia:dependencies.probeMedia||media.probeMedia});
  const styles=dependencies.styles||createStyleLibrary(root);
  const drafts=draftPreviews(store,dependencies.media||media);
  const director=dependencies.director||createDirector({store,styleLibrary:styles,media,audio,drafts});
  const standardLibrary=path.resolve(root)===path.resolve(defaultRoot())&&!process.env.STUDIO_DATA_ROOT;
  const movies=path.join(os.homedir(),'Movies','Video Studio');
  const deliveryRoot=process.env.STUDIO_DELIVERY_ROOT||(standardLibrary?path.join(movies,'交付'):path.join(root,'deliveries'));
  const blindRoot=process.env.STUDIO_REVIEW_ROOT||(standardLibrary?path.join(movies,'盲评工作台'):root);
  const queue=createQueue({store,director,deliveryRoot,styles,media:dependencies.media||media,reviewProject:dependencies.reviewProject||reviewProject,
    async prepare(project,{signal,onProgress}){
      const caps=await audio.audioCapabilities();
      const features=[];
      if((project.mode==='interview'||['import','system','clone'].includes(project.settings.voiceMode))&&!caps.transcription)features.push('speech');
      if(project.settings.voiceMode==='clone'&&!caps.clone)features.push('clone');
      if(features.length){const {prepareMedia}=await import('../scripts/prepare-media.mjs');for(const f of features){onProgress('首次准备本机组件 · '+f);await prepareMedia(f,{signal,onProgress});}}
    }});
  const legacy=legacyLibrary(legacyRoot),music=createMusic(store),voices=voiceLibrary(store);
  const token=randomBytes(32).toString('base64url'),cookie=randomBytes(32).toString('base64url');
  let opened=false,authority,stopped=false,blindHandler,install,installChild;
  const staged=new Map();
  async function fileFor(j,key){if(!j.files?.[key])throw fault('此文件尚未生成。',404);return contained(j.files[key],store.paths(j.projectId).outputs);}
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers.host!==authority)throw fault('本地工作台地址无效。',403);
      const origin='http://'+authority;
      if(req.headers.origin&&req.headers.origin!==origin)throw fault('请求来源无效。',403);
      const url=new URL(req.url,origin);
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const method=req.method;
      if(url.pathname.startsWith('/open/')&&method==='GET'&&!opened&&equal(url.pathname.slice(6),token)){
        opened=true;res.writeHead(303,{Location:process.env.STUDIO_START_VIEW==='blind'?'/blind':'/', 'Set-Cookie':'vs_'+authority.split(':')[1]+'='+cookie+'; HttpOnly; Path=/; SameSite=Strict','Cache-Control':'no-store'});return res.end();
      }
      const cookies=Object.fromEntries((req.headers.cookie||'').split('; ').filter(Boolean).map(s=>s.split('=')));
      if(!equal(cookies['vs_'+authority.split(':')[1]],cookie))throw fault('请从工作台启动入口打开。',403);
      const parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if(parts[0]==='blind'||(parts[0]==='api'&&parts[1]==='blind')){
        if(!blindHandler){const {createBlindRoutes}=await import('./blind-routes.mjs');const {createBlindReview}=await import('./blind-review.mjs');blindHandler=createBlindRoutes({blind:createBlindReview(blindRoot),store});}
        return await blindHandler(req,res,url);
      }
      if(parts[0]!=='api'){
        const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
        if(!['index.html','app.js','studio.css'].includes(name)||method!=='GET')throw fault('页面不存在。',404);
        res.setHeader('Content-Type',{'index.html':'text/html; charset=utf-8','app.js':'text/javascript; charset=utf-8','studio.css':'text/css; charset=utf-8'}[name]);
        res.setHeader('Cache-Control','no-store');return res.end(await readFile(path.join(web,name)));
      }
      const [,kind,id,action,part,leaf]=parts;
      if(kind==='status'&&method==='GET')return json(res,{media:await media.mediaCapabilities(),audio:await audio.audioCapabilities(),install,cloudMusic:music.connected()});
      if(kind==='prepare'&&method==='POST'){
        const b=await readJson(req);if(!['render','speech','clone'].includes(b.feature))throw fault('未知安装项。');
        if(install?.state==='running')throw fault('已有组件正在准备。',409);
        install={feature:b.feature,state:'running',message:'正在准备本机依赖'};
        installChild=spawn(process.execPath,[path.resolve(here,'../scripts/prepare-media.mjs'),b.feature],{stdio:['ignore','pipe','pipe']});
        const observe=d=>{install.message=String(d).trim().slice(-250);};installChild.stdout.on('data',observe);installChild.stderr.on('data',observe);
        installChild.on('error',e=>{install={...install,state:'failed',message:e.message};});
        installChild.on('close',code=>{install={...install,state:code===0?'done':'failed'};installChild=null;});return json(res,install,202);
      }
      if(kind==='voices'&&method==='GET')return json(res,await voices.list());
      if(kind==='account'&&method==='GET')return json(res,await director.account());
      if(kind==='login'&&method==='POST'){
        const data=await director.login();const u=data.authUrl||data.verificationUrl;
        if(u){const v=new URL(u);if(v.protocol==='https:'&&['auth.openai.com','auth0.openai.com','chatgpt.com','auth.chatgpt.com'].includes(v.hostname))openWithMac(v.href);}
        return json(res,data);
      }
      if(kind==='music'&&id==='connection'&&method==='POST')return json(res,music.connect((await readJson(req)).key));
      if(kind==='styles'){
        if(method==='GET'&&!id)return json(res,await styles.list());
        if(method==='POST'&&id==='learn')return json(res,await styles.learn(await readJson(req)),201);
        if(method==='POST'&&id==='preferences')return json(res,await capturePreference(styles,store,await readJson(req)),201);
        if(method==='GET'&&id&&action&&part==='references'){
          const ref=await styles.getReference(id,action,leaf);if(!ref?.path||ref.verified===false)throw fault('参考文件尚未核验。',404);return await streamFile(req,res,ref.path);
        }
        if(method==='GET'&&id)return json(res,await styles.get(id,action));
      }
      if(kind==='legacy'&&method==='GET')return json(res,await legacy.list());
      if(kind==='legacy-editor'&&method==='POST'){
        const p=(await legacy.list()).find(p=>p.id===id);if(!p?.editor)throw fault('此工程没有登记旧编辑入口。',404);
        openWithMac(p.editor);return json(res,{opened:true});
      }
      if(kind==='jobs'&&id){
        if(method==='GET'&&!action)return json(res,exposeJob(store.getJob(id)));
        if(method==='POST'&&action==='direction')return json(res,exposeJob(await queue.redirect(id,await readJson(req))),202);
        if(method==='POST'&&action==='pause')return json(res,exposeJob(queue.pause(id)));
        if(method==='POST'&&action==='resume')return json(res,exposeJob(queue.resume(id,await readJson(req))));
        if(['GET','HEAD'].includes(method)&&action==='file')return await streamFile(req,res,await fileFor(store.getJob(id),part),{download:url.searchParams.has('download')});
        if(method==='POST'&&action==='reveal'){const j=store.getJob(id);const key=part||'video';const delivered=j.published?.[key];const file=delivered?await contained(delivered,deliveryRoot).catch(()=>fileFor(j,key)):await fileFor(j,key);openWithMac(file,true);return json(res,{opened:true});}
      }
      if(kind==='imports'){
        if(method==='POST'&&!id){const key=randomUUID(), dir=path.join(root,'incoming',key);await mkdir(path.join(dir,'assets'),{recursive:true,mode:0o700});staged.set(key,dir);return json(res,{id:key},201);}
        const dir=staged.get(id);if(!dir)throw fault('临时导入已过期。',404);
        if(method==='POST'&&action==='file'){
          const name=decodeURIComponent(req.headers['x-project-path']||req.headers['x-file-name']||'');let dst;
          if(name==='project.vstudio.json'||/^style\/(?:manifest|spec)\.json$/.test(name)||/^style\/media\/[a-f0-9]{64}\.[a-z0-9]{1,5}$/.test(name))dst=path.join(dir,name);
          else if(/^(?:assets\/)?[a-f0-9]{64}\.[a-z0-9]{1,8}$/i.test(name))dst=path.join(dir,'assets',path.basename(name));
          else throw fault('文件不属于导出工程。');
          await mkdir(path.dirname(dst),{recursive:true,mode:0o700});
          await saveUpload(req,dst,12*1024**3);return json(res,{saved:true});
        }
        if(method==='POST'&&action==='open'){
          try{return json(res,disclose(await store.importSnapshot(path.join(dir,'project.vstudio.json'),styles)),201);}
          finally{staged.delete(id);await rm(dir,{recursive:true,force:true});}
        }
      }
      if(kind==='projects'){
        if(!id&&method==='GET')return json(res,store.list());
        if(!id&&method==='POST'){const b=await readJson(req);if(b.style)b.style=await pinnedStyle(styles,b.style);return json(res,disclose(store.create(b)),201);}
        if(!id)throw fault('缺少工程编号。');
        const p=store.get(id);
        if(!action&&method==='GET')return json(res,disclose(p));
        if(action==='configure'&&method==='POST'){const b=await readJson(req);if(b.changes.style)b.changes.style=await pinnedStyle(styles,b.changes.style);return json(res,disclose(store.configure(id,b.baseRevision,b.changes)));}
        if(action==='edits'&&method==='POST'){const b=await readJson(req);return json(res,disclose(store.apply(id,b.baseRevision,b.commands,'user')));}
        if(action==='draft'&&!part&&method==='POST'){
          const b=await readJson(req);const d=await drafts.open(p,b.fromFrame??0);
          return json(res,{...d,url:'/api/projects/'+id+'/draft/'+d.name});
        }
        if(action==='draft'&&/^\d+-\d+-\d+\.mp4$/.test(part||'')&&['GET','HEAD'].includes(method)){
          const dir=path.join(store.paths(id).cache,'drafts');
          return await streamFile(req,res,await contained(path.join(dir,part),dir));
        }
        if(action==='select'&&method==='POST'){const b=await readJson(req);if(b.clipId&&!p.timeline.clips.some(c=>c.id===b.clipId))throw fault('片段不存在。');store.setMeta(id,{selection:b});return json(res,{ok:true});}
        if(action==='facts'&&method==='GET')return json(res,{facts:p.facts||[],notes:p.directorNotes||[],anchors:p.sourceAnchors||[]});
        if(action==='facts'&&part&&leaf==='open'&&method==='POST'){
          const fact=/^\d+$/.test(part)&&p.facts?.[Number(part)];
          if(!fact?.url)throw fault('工程中没有这条出处。',404);
          let link;try{link=new URL(fact.url);}catch{throw fault('出处网址无效。');}
          if(!['https:','http:'].includes(link.protocol)||link.username||link.password)throw fault('出处需要公开的网页地址。');
          (dependencies.openSource||openWithMac)(link.href);return json(res,{opened:true});
        }
        if(action==='jobs'&&method==='GET')return json(res,store.listJobs(id).map(exposeJob));
        if(action==='jobs'&&method==='POST'){const {kind,...input}=await readJson(req);return json(res,exposeJob(queue.enqueue(id,kind,input)),202);}
        if(action==='transcript'&&method==='POST'){const b=await readJson(req);if(!(await audio.audioCapabilities()).transcription){const {prepareMedia}=await import('../scripts/prepare-media.mjs');await prepareMedia('speech',{});}return json(res,await director.transcribe(id,{assetId:b.assetId}));}
        if(action==='restore-sentence'&&method==='POST'){const b=await readJson(req);await director.restoreUtterance(id,b);return json(res,disclose(store.get(id)));}
        if(action==='learn-style'&&method==='POST'){
          const b=await readJson(req),a=p.assets.find(a=>a.id===b.assetId);
          if(b.assetId&&!a)throw fault('参考素材不在本工程。');
          const references=a?[await styles.captureReference(await contained(a.path,store.paths(id).assets),{kind:a.kind,title:a.name})]:[];
          const observations=a&&b.observation?.trim()?[{dimension:a.kind==='audio'?'audio':'visual',instruction:b.observation.trim(),evidence:'reference',basis:'user_direction'}]:[];
          const s=await styles.learn({id:'personal-'+randomUUID(),name:b.name,script:b.script||'',observations,references,templateIds:['action-result','step-reveal'].includes(b.templateId)?[b.templateId]:[],knownExceptions:b.exception?.trim()?[String(b.exception).trim().slice(0,2000)]:[]});
          return json(res,s,201);
        }
        if(action==='scene'&&method==='POST'){const b=await readJson(req);
          if(b.baseRevision!==p.revision)throw fault('时间线已更新，请重新选择入点。',409);
          const style=await styles.get(p.style.id,p.style.version);
          const selected=p.timeline.clips.find(c=>c.id===(b.clipId||p.selection?.clipId) && c.track==='video');
          const anchor=selected&&b.actionFrame>=selected.start&&b.actionFrame<selected.start+selected.duration?{anchorAssetId:selected.assetId,anchorSourceFrame:Math.round((selected.sourceIn||0)+(b.actionFrame-selected.start)*(selected.speed||1))}:{};
          const scene={...b,anchorAssetId:anchor.anchorAssetId,anchorSourceFrame:anchor.anchorSourceFrame,style};
          const result=await compileSceneWithSound(styles,store,p,scene);
          return json(res,disclose(store.apply(id,result.baseRevision,result.clips.map(clip=>({op:'add',clip})),'user')));}
        if(action==='legacy'&&method==='POST'){const b=await readJson(req);const a=await legacy.item(b.projectId,b.itemId);return json(res,await store.addAsset(id,a.path,{...a.source,name:a.name,legacyProject:b.projectId,legacyItem:a.id,legacyStatus:a.status}),201);}
        if(action==='cloud-music'&&method==='POST')return json(res,await music.compose(id,await readJson(req)),201);
        if(action==='music-receipt'&&part&&method==='GET')return json(res,await music.check(id,part));
        if(action==='reconcile-music'&&method==='POST')return json(res,disclose(music.reconcile(id,await readJson(req))));
        if(action==='assets'&&part&&['GET','HEAD'].includes(method)){
          const a=p.assets.find(a=>a.id===part);if(!a)throw fault('素材不存在。',404);return await streamFile(req,res,await contained(a.path,store.paths(id).assets));
        }
        if((action==='assets'||action==='url')&&!part&&method==='POST'){
          let name,source={};let remote;
          if(action==='url'){const b=await readJson(req);remote=b.url;name=path.basename(new URL(remote).pathname);source={url:remote,rights:b.rights||'用户选择的直链'};}
          else name=decodeURIComponent(req.headers['x-file-name']||'media');
          name=path.basename(name||'media').slice(0,180);
          const tmp=path.join(store.paths(id).cache,'import-'+randomUUID()+path.extname(name).replace(/[^.a-zA-Z0-9]/g,'').slice(0,10));
          try{if(remote)await downloadPublic(remote,tmp);else await saveUpload(req,tmp,12*1024**3);
            const a=await store.addAsset(id,tmp,{name,...source});return json(res,{...a,path:undefined},201);
          }finally{await rm(tmp,{force:true});}
        }
        if(action==='voices'&&method==='POST'){const b=await readJson(req);if(part==='use')return json(res,disclose(await voices.use(id,b.id,b.baseRevision)));if(part==='enroll')return json(res,await voices.enroll(id,b),201);}
        if(action==='anchor'&&method==='POST'){const b=await readJson(req);const a=p.assets.find(a=>a.id===b.assetId);if(!a||!Number.isInteger(b.sourceFrame)||b.sourceFrame<0||b.sourceFrame>Math.ceil(a.duration*p.profile.fps)||!String(b.label||'').trim())throw fault('请标记素材内的真实动作。');return json(res,disclose(store.configure(id,b.baseRevision,{sourceAnchors:[...(p.sourceAnchors||[]),{assetId:a.id,sourceFrame:b.sourceFrame,label:String(b.label).slice(0,180)}]})));}
        if(action==='audition'&&method==='POST'){
          const b=await readJson(req),ref=p.assets.find(a=>a.id===p.settings.voiceReferenceAssetId);
          const mode=p.settings.voiceMode;
          if(mode==='import'||mode==='original'){
            const recording=mode==='import'?p.assets.find(a=>a.id===p.settings.narrationAssetId):
              p.assets.find(a=>a.id===p.timeline.clips.find(c=>c.track==='narration')?.assetId)||p.assets.find(a=>a.hasAudio);
            if(!recording)throw fault('请先在工程中选择带声音的原始录音。');
            return json(res,{id:recording.id});
          }
          if(mode==='clone'){
            if(!p.settings.voiceConsent||!ref)throw fault('请登记获授权的参考录音。');
            if(!(await audio.audioCapabilities()).clone){const {prepareMedia}=await import('../scripts/prepare-media.mjs');await prepareMedia('clone',{});}
          }
          const file=path.join(store.paths(id).cache,'audition-'+randomUUID()+'.wav');
          try{
            await audio.synthesize(String(b.text||'神舟十九号经过酒泉。上午九点二十分，陈老师把三点一四写在屏幕上，请大家等画面变亮，再听下一句。').slice(0,400),{mode,voice:p.settings.systemVoice,referencePath:ref?.path,referenceText:p.settings.voiceReferenceText,output:file});
            const a=await store.addAsset(id,file,{name:'音色试听.wav',audition:true,referenceHash:ref?.sha256});return json(res,{id:a.id});
          }finally{await rm(file,{force:true});}
        }
      }
      throw fault('找不到该操作。',404);
    }catch(e){if(res.headersSent){res.destroy();return;}const status=e.status||({ENOENT:404}[e.code])||400;json(res,{error:e.message||'操作失败。'},status);}
  });
  server.requestTimeout=0;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  authority='127.0.0.1:'+server.address().port;queue.recover();
  return {url:'http://'+authority+'/open/'+token,store,queue,async close(){if(stopped)return;stopped=true;const done=new Promise(r=>server.close(r));server.closeIdleConnections();const installer=installChild;const settled=installer?once(installer,'close').catch(()=>{}):Promise.resolve();installer?.kill('SIGTERM');await Promise.all([settled,queue.close(),drafts.close()]);await director.close?.();await done;store.close();await release();}};
}
async function pinnedStyle(styles,selector){const s=await styles.get(selector.id,selector.version);return {id:s.id,name:s.name,version:s.version};}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const app=await startStudio({port:Number(process.env.STUDIO_PORT||0)});
  process.stdout.write((process.argv.includes('--native')?JSON.stringify({url:app.url}):'Video Studio  '+app.url)+'\n');
  let closing=false;const stop=async()=>{if(closing)return;closing=true;await app.close();process.exit(0);};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  if(process.argv.includes('--native')){process.stdin.resume();process.stdin.on('end',stop);}
}
