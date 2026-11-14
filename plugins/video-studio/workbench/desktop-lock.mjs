import {spawn} from 'node:child_process';
import {access,mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const helper=fileURLToPath(new URL('../scripts/desktop_mutex.py',import.meta.url));
export const desktopRoot=ticketFile=>path.dirname(path.dirname(path.dirname(path.dirname(ticketFile))));
export const lockPath=(dataDir,threadId)=>path.join(dataDir,'desktop-lock-'+threadId);
export async function atomicDesktopJson(file,value){const tmp=file+'.'+randomUUID()+'.tmp';try{await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,file);}finally{await rm(tmp,{force:true});}}
export async function readDesktopJson(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function withDesktopMutex(dataDir,fn,python){
  if(!python){python=process.env.VIDEO_STUDIO_PYTHON;}
  if(!python){const local=path.join(os.homedir(),'Library/Application Support/Video Studio/runtime/bin/python3');try{await access(local);python=local;}catch{python='python3';}}
  const child=spawn(python,['-u',helper,path.join(dataDir,'.desktop-mutex')],{stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});let error='';child.stderr.on('data',b=>error+=b);
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('会话运行状态正在被其他进程核对，请稍后重试。'));},30000);
      const fail=e=>{clearTimeout(timer);reject(e);};
      child.once('error',fail);child.once('exit',code=>fail(Error('会话运行锁不可用：'+(error.trim()||code))));
      let output='';child.stdout.on('data',b=>{output+=b;if(output.includes('locked\n')){clearTimeout(timer);resolve();}});
    });
    return await fn();
  }finally{child.stdin.end();}
}
export function ownsLock(owner,ticket){return owner?.jobId===ticket.jobId&&(!owner.token||owner.token===ticket.lockToken);}
export function assertTicket(ticket){if(!ticket||ticket.schema!==1||ticket.revoked||Date.now()>ticket.leaseUntil)throw Error('工作台任务已停止或连接已过期。不得继续执行或提交；请回到工作台恢复。');}

// Only called while holding the same OS mutex used by claim, lease, finish and
// recovery. An old observer must never resurrect a revoked ticket or new owner.
export async function updateTicket(ticketFile,snapshot){
  const dataDir=desktopRoot(ticketFile);
  return withDesktopMutex(dataDir,async()=>{
    const current=await readDesktopJson(ticketFile);
    if(current&&current.requestId!==snapshot.requestId)throw Error('桌面票据身份已变化');
    const owner=await readDesktopJson(path.join(lockPath(dataDir,snapshot.threadId),'owner.json'));
    const next={...snapshot,revoked:!!(snapshot.revoked||current?.revoked||!ownsLock(owner,snapshot))};
    await atomicDesktopJson(ticketFile,next);return next;
  },snapshot.python);
}
export async function releaseDesktopLock(ticketFile,ticket){
  const dataDir=desktopRoot(ticketFile);
  await withDesktopMutex(dataDir,async()=>{
    const directory=lockPath(dataDir,ticket.threadId),owner=await readDesktopJson(path.join(directory,'owner.json'));
    const current=await readDesktopJson(ticketFile);
    if(current?.requestId===ticket.requestId)await atomicDesktopJson(ticketFile,{...current,revoked:true});
    if(ownsLock(owner,ticket))await rm(directory,{recursive:true,force:true});
  },ticket.python);
}
export async function revokeAndCheckClaim(ticketFile,ticket){
  return withDesktopMutex(desktopRoot(ticketFile),async()=>{
    const current=await readDesktopJson(ticketFile);
    if(current?.requestId!==ticket.requestId)throw Error('桌面票据身份已变化');
    const ack=await readDesktopJson(path.join(path.dirname(ticketFile),'desktop-ack.json'));
    if(ack&&['jobId','requestId','threadId'].some(k=>ack[k]!==ticket[k]))throw Error('桌面执行回执与本次任务不一致');
    await atomicDesktopJson(ticketFile,{...current,revoked:true});
    return !!ack;
  },ticket.python);
}
export async function createDesktopLock(dataDir,threadId,jobId){
  const directory=lockPath(dataDir,threadId),owner={schema:2,jobId,token:randomUUID(),pid:process.pid,createdAt:new Date().toISOString()};
  await mkdir(directory);await atomicDesktopJson(path.join(directory,'owner.json'),owner);return owner;
}
