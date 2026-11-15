import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validThreadId} from './desktop-session.mjs';
import path from 'node:path';
import {desktopRoot,withDesktopMutex,readDesktopJson,ownsLock,lockPath} from './desktop-lock.mjs';

const execute=promisify(execFile);

// Use the desktop's supported deep link so the saved desktop tools remain
// available. A separate app-server daemon is not the desktop tool host.
// Opening the link is a wake request, never proof of task acknowledgement.
export async function wakeDesktopThread(threadId,{platform=process.platform,run=execute}={}){
  if(!validThreadId(threadId))throw Error('桌面唤起需要有效的本机会话 ID。');
  if(platform!=='darwin')throw Error('当前系统尚不支持自动唤起桌面会话。');
  await run('/usr/bin/open',['-g',`codex://threads/${threadId}`],{timeout:10000,maxBuffer:64000});
}

// Serialize the navigation decision with claim, revoke and owner replacement.
// Start the OS request under the mutex, but never await it while holding the
// mutex: the desktop must be free to claim immediately after navigation.
export async function beginDesktopWake(ticketFile,ticket,canStart,start){
  return withDesktopMutex(desktopRoot(ticketFile),async()=>{
    const current=await readDesktopJson(ticketFile);
    const owner=await readDesktopJson(path.join(lockPath(desktopRoot(ticketFile),ticket.threadId),'owner.json'));
    const ack=await readDesktopJson(path.join(path.dirname(ticketFile),'desktop-ack.json'));
    if(ack&&['jobId','requestId','threadId'].some(k=>ack[k]!==ticket[k]))throw Error('桌面执行回执与本次任务不一致');
    if(ack||!current||current.requestId!==ticket.requestId||current.revoked||Date.now()>current.leaseUntil||!ownsLock(owner,ticket)||!canStart())return null;
    let pending;try{pending=Promise.resolve(start());}catch(error){pending=Promise.reject(error);}
    return {outcome:pending.then(()=>({ok:true}),error=>({ok:false,error}))};
  },ticket.python);
}
