import {constants} from 'node:fs';
import {access,chmod,copyFile,link,lstat,mkdir,realpath,readlink,stat,symlink,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const missing=error=>error?.code==='ENOENT';
const entry=async p=>lstat(p).catch(e=>{if(!missing(e))throw e;return null;});
const inside=(parent,child)=>child===parent||child.startsWith(parent+path.sep);
export const studioProfileHome=()=>process.env.VIDEO_STUDIO_CODEX_HOME||
  path.join(os.homedir(),'Library','Application Support','Video Studio','codex-runtime');
export const desktopProfileHome=()=>process.env.CODEX_HOME||path.join(os.homedir(),'.codex');

export function childEnvironment(profile,{reader=false}={}){
  const env={...process.env,CODEX_HOME:profile};
  // The desktop supplies this to child shells. Leaving it set misclassifies an
  // ordinary app-server thread as a foreground Desktop/vscode conversation.
  for(const key of ['CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_SESSION_ID','CODEX_THREAD_ID','CODEX_TOOL_CALL_ID','CODEX_APP_TOOLS_PIPE_PATH','CODEX_APP_RUNTIME_CLI_PATH','CODEX_PERMISSION_PROFILE','CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY'])
    delete env[key];
  if(!reader){
    env.CODEX_SQLITE_HOME=profile;
    for(const type of ['CONFIG','STATE','CACHE','DATA'])env['XDG_'+type+'_HOME']=path.join(profile,'xdg',type.toLowerCase());
  }
  return env;
}

async function accountLink(privateFile,sharedFile,enable){
  const existing=await entry(privateFile);
  if(existing?.isSymbolicLink()){
    if(path.resolve(path.dirname(privateFile),await readlink(privateFile))!==sharedFile)
      throw Error('工作台认证链接与当前账号目录不符，请检查本机工作台账号设置。');
    if(!enable)await unlink(privateFile).catch(e=>{if(!missing(e))throw e;});
    return enable;
  }
  if(existing||!enable)return false;
  try{await symlink(sharedFile,privateFile);}
  catch(e){if(e.code!=='EEXIST')throw e;return accountLink(privateFile,sharedFile,enable);}
  return true;
}

export async function prepareProfile({home,desktop,settings}){
  if(!path.isAbsolute(home)||!path.isAbsolute(desktop))throw Error('Codex 会话目录须为绝对路径。');
  const shared=await realpath(desktop).catch(e=>{if(!missing(e))throw e;return path.resolve(desktop);});
  const chosen=await realpath(home).catch(e=>{if(!missing(e))throw e;return path.resolve(home);});
  if(inside(shared,chosen)||inside(chosen,shared))throw Error('工作台会话目录须独立于桌面 Codex 目录。');
  await mkdir(home,{recursive:true,mode:0o700});
  const directory=await realpath(home),info=await stat(directory);
  if(inside(shared,directory)||inside(directory,shared)||!info.isDirectory()||
     (typeof process.getuid==='function'&&info.uid!==process.getuid())||info.mode&0o077)
    throw Error('工作台会话目录须由当前用户独占（0700）并位于桌面 Codex 目录之外。');
  // CODEX_SQLITE_HOME also applies to Desktop even if its usual CODEX_HOME is elsewhere.
  const overlap=async location=>{
    if(!location)return false;
    const resolved=await realpath(location).catch(e=>{if(!missing(e))throw e;return path.resolve(location);});
    return resolved===directory;
  };
  if(await overlap(process.env.CODEX_SQLITE_HOME))throw Error('工作台与桌面必须各自使用独立的 Codex 会话索引。');
  for(const name of ['sessions','archived_sessions','state_5.sqlite','thread_history_1.sqlite','session_index.jsonl']){
    if((await entry(path.join(directory,name)))?.isSymbolicLink())throw Error('工作台的聊天索引与记录需要存放在独立的本机目录。');
  }
  const authFile=path.join(directory,'auth.json'),own=await entry(authFile),sharedFile=path.join(shared,'auth.json');
  const hasSharedFile=await stat(sharedFile).then(s=>s.isFile()).catch(e=>{if(!missing(e))throw e;return false;});
  // An independent login belongs to this profile even if a desktop login later appears.
  // With keyring/auto, a leftover auth.json need not represent the active account.
  const desktopConfig=(await entry(shared))?.isDirectory() ? await settings(shared) : {};
  if(await overlap(desktopConfig.sqliteHome))throw Error('当前桌面 Codex 已配置使用该会话索引，请另选工作台目录。');
  const modelDefaults={};
  if(typeof desktopConfig.model==='string'&&/^[a-zA-Z0-9_.:-]{1,120}$/.test(desktopConfig.model))modelDefaults.model=desktopConfig.model;
  if(['none','minimal','low','medium','high','xhigh','max','ultra'].includes(desktopConfig.effort))modelDefaults.effort=desktopConfig.effort;
  const mode=desktopConfig.credentialMode;
  const share=hasSharedFile&&mode==='file'&&(!own||own.isSymbolicLink());
  const lock=await accountLink(path.join(directory,'auth.lock'),path.join(shared,'auth.lock'),share);
  if(share&&!lock&&!own) {
    // A previous standalone login may have left its own lock. Do not split refresh locks.
    return {directory,desktop:shared,storeId:identity(directory),accountSource:'studio',credentialStore:mode,modelDefaults};
  }
  if(share&&!lock)throw Error('工作台与桌面账号的刷新锁不一致。');
  await accountLink(authFile,sharedFile,share);
  return {directory,desktop:shared,storeId:identity(directory),accountSource:share?'desktop-file':'studio',credentialStore:mode,modelDefaults};
}
const identity=directory=>'studio-v1-'+createHash('sha256').update(directory).digest('hex').slice(0,24);

const validId=id=>typeof id==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
export function workbenchLegacy(thread,id){
  // Old app launches could inherit the Desktop originator override. Their cwd was
  // always the host-owned video-studio-agent-* folder, regardless of the project location.
  if(!validId(id)||thread?.id!==id||!thread.path||typeof thread.cwd!=='string')return false;
  const absolute=path.resolve(thread.cwd);
  return /^video-studio-agent-[0-9A-Za-z]+$/.test(path.basename(absolute))&&
    (path.dirname(absolute)===path.resolve(os.tmpdir())||
     path.dirname(absolute).replace(/^\/private(?=\/var\/)/,'')===path.resolve(os.tmpdir()).replace(/^\/private(?=\/var\/)/,''));
}
export async function privateRollout(profile,thread,id) {
  if(!workbenchLegacy(thread,id))throw Error('原会话没有工作台独立创作目录的标识，无法迁入。');
  const source=await realpath(thread.path);
  const relative=path.relative(profile.desktop,source);
  const parts=relative.split(path.sep);
  if(!['sessions','archived_sessions'].includes(parts[0])||parts.includes('..')||
    !path.basename(source).startsWith('rollout-')||!path.basename(source).endsWith('-'+id+'.jsonl'))
    throw Error('旧会话文件不属于该工作台线程。');
  const dest=path.join(profile.directory,'sessions',...parts.slice(1)), dir=path.dirname(dest);
  await mkdir(dir,{recursive:true,mode:0o700});
  if(!inside(profile.directory,await realpath(dir)))throw Error('迁移目标不在工作台会话目录内。');
  const previous=await entry(dest);
  if(previous){
    if(!previous.isFile()||!inside(profile.directory,await realpath(dest)))throw Error('迁移目标不是独立的工作台记录。');
    return dest;
  }
  const tmp=path.join(dir,'.import-'+randomUUID());
  try{
    const before=await stat(source,{bigint:true});
    await copyFile(source,tmp,constants.COPYFILE_FICLONE);await chmod(tmp,0o600);
    const after=await stat(source,{bigint:true});
    if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ino!==after.ino)throw Error('旧会话正在写入，请待原回合停止后继续。');
    try{await link(tmp,dest);}catch(e){if(e.code!=='EEXIST')throw e;}
    if(!(await lstat(dest)).isFile()||!inside(profile.directory,await realpath(dest)))throw Error('迁入记录的位置无效。');
    await access(dest,constants.R_OK);return dest;
  }finally{await unlink(tmp).catch(e=>{if(!missing(e))throw e;});}
}
