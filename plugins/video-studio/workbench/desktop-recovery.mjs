import path from 'node:path';
import {rm} from 'node:fs/promises';
import {desktopActivity,turnText,validThreadId} from './desktop-session.mjs';
import {readDesktopJson,atomicDesktopJson,lockPath,withDesktopMutex,createDesktopLock} from './desktop-lock.mjs';

const terminal=status=>['completed','interrupted','failed'].includes(status);
export async function findDesktopTurn(reader,ticket,turnId=ticket.turnId){
  let cursor;const seen=new Set();
  for(let page=0;page<200;page++){
    const result=await reader.call('thread/turns/list',{threadId:ticket.threadId,limit:100,itemsView:'summary',...(cursor?{cursor}:{})});
    const turn=result.data?.find(t=>turnId?t.id===turnId:turnText(t).includes(ticket.marker));
    if(turn)return turn;
    if(!result.nextCursor)return null;
    if(seen.has(result.nextCursor))throw Error('桌面轮次分页重复，无法核实任务状态');
    seen.add(result.nextCursor);cursor=result.nextCursor;
  }
  throw Error('桌面轮次记录过长，尚未核实原任务，未释放运行锁');
}
async function inspectLock(dataDir,threadId,reader){
  if(!validThreadId(threadId))throw Error('请选择本机 Codex 桌面会话。');
  const directory=lockPath(dataDir,threadId),owner=await readDesktopJson(path.join(directory,'owner.json'));
  if(!owner){
    const {stat}=await import('node:fs/promises');
    try{await stat(directory);return {status:'unknown',message:'旧运行锁缺少所有者记录，不能安全释放；请核对原桌面任务。'};}catch(e){if(e.code==='ENOENT')return {status:'idle',message:'没有遗留的工作台运行锁。'};throw e;}
  }
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(owner.jobId))throw Error('旧运行锁所有者格式无效');
  const ticketFile=path.join(dataDir,'jobs',owner.jobId,'desktop','ticket.json'),ticket=await readDesktopJson(ticketFile);
  if(!ticket||ticket.jobId!==owner.jobId||ticket.threadId!==threadId||(owner.token&&ticket.lockToken!==owner.token))return {status:'unknown',jobId:owner.jobId,message:'原任务票据缺失或身份不一致，未释放运行锁。'};
  const activity=await desktopActivity(reader,threadId);
  const turn=ticket.turnId?{id:ticket.turnId}:await findDesktopTurn(reader,ticket);
  const status=turn&&activity.turns.get(turn.id);
  const ack=await readDesktopJson(path.join(path.dirname(ticketFile),'desktop-ack.json'));
  if(ack&&['jobId','requestId','threadId'].some(k=>ack[k]!==ticket[k]))throw Error('原任务领取回执身份不一致');
  const expired=ticket.revoked||Date.now()>ticket.leaseUntil;
  const releasable=terminal(status)||(!turn&&!ack&&expired&&activity.turns.get(activity.latest)!=='inProgress');
  return {status:releasable?'recoverable':status==='inProgress'?'active':'unknown',jobId:owner.jobId,
    message:releasable?'已核实原任务结束或未领取票据已失效，可以释放遗留运行锁。':status==='inProgress'?'原桌面任务仍在执行，请先在桌面停止或等待完成。':'尚未核实原桌面任务终态，保留运行锁，避免重复制作。',ticketFile,ticket,directory};
}
export async function reconcileDesktopLock({dataDir,threadId,reader,release=false,jobId,python}){
  return withDesktopMutex(dataDir,async()=>{
    const result=await inspectLock(dataDir,threadId,reader);
    if(result.status==='recoverable'&&(release||jobId)){
      await atomicDesktopJson(result.ticketFile,{...result.ticket,revoked:true});
      await rm(result.directory,{recursive:true,force:true});
      result.status='released';result.message='已核实并释放遗留运行锁，原项目和文件保持不变。';
    }
    let owner;
    if(jobId){
      if(!['idle','released'].includes(result.status))throw Error(result.message+' 可在“桌面执行会话”中检查恢复状态。');
      owner=await createDesktopLock(dataDir,threadId,jobId);
    }
    return {status:result.status,jobId:result.jobId||null,message:result.message,...(owner?{owner}:{})};
  },python);
}
