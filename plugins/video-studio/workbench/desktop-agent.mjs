import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,rm,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareAgentRequest,cleanError} from './agent.mjs';
import {atomicJson,inspectDesktop,turnText,desktopActivity} from './desktop-session.mjs';
import {readRegularJson,validateResult} from './desktop-worker.mjs';
import {productionCheckpointReader} from './continuous.mjs';
import {acceptProductionProgress,toolFailure} from './production-progress.mjs';

const execute=promisify(execFile),root=path.dirname(fileURLToPath(import.meta.url));
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
export function recordedTool(item){
  if(item.type==='mcpToolCall'){const error=toolFailure(item);return {server:item.server,tool:item.tool,status:error?'failed':item.status,...(error?{error:cleanError(error)}:{})};}
  if(item.type==='dynamicToolCall'&&/^mcp__/.test(item.tool))return {server:item.namespace||'',tool:item.tool,status:item.status==='completed'?(item.success===false?'failed':'completed'):item.status};
  return null;
}

// Queuing is not acknowledgement. Success requires a matching desktop turn,
// its actual terminal state, a worker claim, and a schema-checked result.
export function runDesktopAgent({codex,reader,job,context,event,onFinish,onProductionCheckpoint,onSourceProgress,restore=false,pollMs=2500,ackTimeoutMs=120000,queue=execute}){
  const directory=path.join(context.jobDirectory,'desktop'),ticketFile=path.join(directory,'ticket.json');
  let ticket,timer,stopped=false,detached=false,polling=false,lastProgress='',lastWarning='',lockOwned=false,publishes=Promise.resolve();
  const seen=new Map(),readCheckpoint=onProductionCheckpoint?productionCheckpointReader({job,context,adopt:onProductionCheckpoint,event}):async()=>{};
  const attempt=restore&&job.attempts?.at(-1)||{stage:context.planning?.stage||job.action,startedAt:new Date().toISOString(),execution:job.execution};
  const lock=path.join(path.dirname(path.dirname(context.jobDirectory)),'desktop-lock-'+job.execution.desktopThreadId);
  const publish=()=>{if(!ticket)return Promise.resolve();const snapshot=structuredClone(ticket);publishes=publishes.catch(()=>{}).then(()=>atomicJson(ticketFile,snapshot));return publishes;};
  const revoke=async()=>{if(ticket){ticket.revoked=true;await publish();}};
  const controller={
    cancel(reason='user'){job.cancelRequested=true;job.stopReason=reason;revoke().catch(()=>{});event('cancelling','已请求桌面任务停止。当前工具可能仍在执行；确认该轮结束后才释放工作台。可在 Codex 桌面窗口立即停止。');},
    detach(){detached=true;clearInterval(timer);}
  };
  async function finish(code,error,finalText=''){
    if(stopped||detached)return;stopped=true;clearInterval(timer);await revoke();
    if(lockOwned)await rm(lock,{recursive:true,force:true});
    attempt.completedAt=new Date().toISOString();attempt.code=code;
    await onFinish({code,error:error?cleanError(error):'',finalText});
  }
  async function progress(){
    await readCheckpoint();
    if(onSourceProgress&&context.sourceProgressPath)try{await onSourceProgress(await readRegularJson(context.sourceProgressPath));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(['produce','create'].includes(job.action))try{
      const file=path.join(context.run,'workbench-progress.json'),raw=await readFile(file,'utf8');if(raw===lastProgress)return;
      const value=JSON.parse(raw);if(acceptProductionProgress(value,job,(await stat(file)).mtimeMs)){lastProgress=raw;job.productionStage=value.stage;event('progress',value.message||value.stage);}
    }catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
  }
  async function items(turn,terminal){
    // Read this turn only. Never accept historical exports or another turn's tools.
    let cursor,pages=0;
    do{const page=await reader.call('thread/items/list',{threadId:ticket.threadId,turnId:turn.id,limit:100,sortDirection:terminal?'asc':'desc',...(cursor?{cursor}:{})});
      for(const entry of page.data||[]){if(entry.turnId!==turn.id)continue;const item=entry.item,key=item.id+':'+item.type;
        const record=recordedTool(item);if(!record||seen.get(key)===record.status)continue;seen.set(key,record.status);
        if(!job.toolCalls.some(t=>t.desktopItemId===item.id&&t.status===record.status))job.toolCalls.push({...record,desktopItemId:item.id});
        event(record.status==='failed'?'warning':'tool',`${record.tool} · ${record.status}`);
      }
      cursor=terminal?page.nextCursor:null;if(++pages>200)throw Error('桌面执行记录过长，请检查任务。');
    }while(cursor);
  }
  async function poll(){
    if(stopped||detached||polling)return;polling=true;let terminal=false;
    try{
      if(!ticket.revoked){ticket.leaseUntil=Date.now()+120000;await publish();}
      const result=await reader.call('thread/turns/list',{threadId:ticket.threadId,limit:30,itemsView:'summary'});
      const turn=result.data?.find(t=>job.desktop?.turnId?t.id===job.desktop.turnId:turnText(t).includes(ticket.marker));
      let ack;try{ack=await readRegularJson(path.join(directory,'desktop-ack.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
      if(ack&&['jobId','requestId','threadId'].some(k=>ack[k]!==ticket[k]))throw Error('桌面执行回执与本次任务不一致');
      if(!turn){
        if(job.cancelRequested||Date.now()-ticket.queuedAt>ackTimeoutMs){
          // A claimed job can already be running while history indexing lags.
          // Keep the execution slot occupied until its real turn is observable.
          await revoke();if(ack){eventOnce('桌面已领取任务，正在等待执行状态；请保持桌面端开启，勿重复开始。');return;}
          await finish(1,job.cancelRequested?'已撤销尚未执行的桌面消息':'桌面会话未接收任务。请打开并保持所选 Codex 会话，再点击继续；本次排队消息已作废，不会重复制作。');return;
        }
        return;
      }
      const activity=await desktopActivity(reader,ticket.threadId),actualStatus=activity.turns.get(turn.id);
      terminal=['completed','interrupted','failed'].includes(actualStatus);
      if(!job.desktop.turnId){job.desktop.turnId=turn.id;job.threadId=ticket.threadId;attempt.threadId=ticket.threadId;event('thread','桌面会话已开始执行本次任务');}
      if(ack&&!job.desktop.acknowledged){job.desktop.acknowledged=true;event('working','桌面 Agent 已领取当前制作要求');}
      await progress();
      // Poll recent items while running; terminal read captures every actual call.
      await items(turn,terminal);
      if(!terminal)return;
      const usage=activity.usage?.get(turn.id);
      if(usage){if(!job.desktop.usageRecorded){attempt.usage=usage;job.usage??={};for(const [key,value]of Object.entries(usage))job.usage[key]=(job.usage[key]||0)+value;job.desktop.usageRecorded=true;event('usage','已收到当前桌面轮次的实际 Token 用量');}job.usageIncomplete=false;}
      if(job.cancelRequested){await finish(1,'桌面会话已结束；已提交的远端任务仍需查询状态。');return;}
      if(actualStatus!=='completed'){await finish(1,'桌面会话已中断或失败。已有文件已保留，请继续已有任务。');return;}
      if(!ack){await finish(1,'桌面会话没有领取工作台任务，请检查所选窗口及插件是否可用。');return;}
      let answer;try{answer=await readRegularJson(path.join(directory,'desktop-result.json'));}catch(e){if(e.code==='ENOENT'){await finish(1,'桌面任务结束但未提交结构化结果。请检查桌面窗口，已有素材与项目保留。');return;}throw e;}
      if(['jobId','requestId','threadId'].some(k=>answer[k]!==ticket[k]))throw Error('桌面结果与本次任务不一致');
      validateResult(answer.result,await readRegularJson(ticket.schemaFile));
      await finish(0,'',JSON.stringify(answer.result));
    }catch(e){if(terminal)await finish(1,e.message);else eventOnce('桌面状态检查：'+cleanError(e.message));}
    finally{polling=false;}
  }
  function eventOnce(message){if(lastWarning!==message){lastWarning=message;event('warning',message);}}
  (async()=>{
    await mkdir(directory,{recursive:true});
    if(restore){
      ticket=await readRegularJson(ticketFile);
      job.desktop??={requestId:ticket.requestId,threadId:ticket.threadId,directory};
      if(ticket.jobId!==job.id||ticket.threadId!==job.execution.desktopThreadId)throw Error('桌面恢复记录身份不一致');
      const owner=await readRegularJson(path.join(lock,'owner.json'));if(owner.jobId!==job.id)throw Error('桌面会话已被其他工作台任务占用');lockOwned=true;
      if(ticket.leaseUntil<Date.now()||job.cancelRequested)await revoke();
      event('recovery','已重新接管桌面任务状态；不会再次发送制作消息');
    }else{
      await inspectDesktop(reader,job.execution.desktopThreadId);
      try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')throw Error('此桌面会话仍有工作台任务，先恢复或停止原任务。');throw e;}
      lockOwned=true;await atomicJson(path.join(lock,'owner.json'),{jobId:job.id});
      const prepared=await prepareAgentRequest(job,context),requestId=randomUUID();
      ticket={schema:1,jobId:job.id,requestId,threadId:job.execution.desktopThreadId,marker:`[VideoStudio request:${requestId}]`,queuedAt:Date.now(),leaseUntil:Date.now()+120000,revoked:!!job.cancelRequested,promptFile:path.join(directory,'prompt.txt'),schemaFile:prepared.schemaPath};
      const command=`${quote(process.execPath)} ${quote(path.join(root,'desktop-worker.mjs'))}`;
      const prompt=`${ticket.marker}\n这是用户在 Video Studio 工作台点击按钮授权的任务。只依据当前请求及其指定风格与项目；本窗口此前的聊天不是本次素材或规则。不得开启另一轮制作或自建后台执行器。\n首先执行 ${command} claim ${quote(ticketFile)}；失败则立即停止，不操作素材、浏览器或 ChatCut。成功后读取返回的 promptFile。\n`;
      const body=`${prepared.prompt}\n\n桌面执行协议：\n- 本次请求标记 ${ticket.marker}，所有路径以当前 Structured context 为准。\n- 在每个阶段及每次生成、导入、导出或浏览器写操作前执行 ${command} check ${quote(ticketFile)}；若失败或取消标记出现，立即停止，不自行重试。\n- 使用本会话已授权的 Computer Use 与 ChatCut 工具。Chrome 标签 API 技术性超时可改用工具文档允许的原生 Chrome 应用控制；使用实际观察到的应用路径，网址优先粘贴。明确的权限拒绝不能通过换入口绕过。\n- 不重新生成已有成功音频、导出或项目；查询并复用当前 run 记录的真实 ID。\n- 所有 ChatCut 调用必须保留工具原始执行记录，不得自行编造调用成功证据。\n- 完成后将符合 ${prepared.schemaPath} 的 JSON 写入本任务目录中的 result.json，再执行 ${command} complete ${quote(ticketFile)} <该JSON绝对路径>。只写最终自然语言回复不能完成工作台任务。\n- complete 成功后立即结束本轮，不开始独立验收；工作台会另起独立验收会话。\n`;
      await writeFile(ticket.promptFile,body,{mode:0o600});await publish();
      job.desktop={requestId,threadId:ticket.threadId,queuedAt:new Date(ticket.queuedAt).toISOString(),directory};
      event('queued','已准备桌面任务，等待所选会话领取');
      if(job.cancelRequested){await finish(1,'任务在排队前已取消');return;}
      // Persist dispatch intent before invoking queue. Recovery only observes it;
      // even an uncertain CLI exit must never trigger an automatic second send.
      try{const reply=await queue(codex,['queue','--thread',ticket.threadId,'--message',prompt,'--resume'],{cwd:context.jobDirectory,timeout:20000,maxBuffer:64000});job.desktop.queueWarning=!!reply.stderr;}
      catch(e){job.desktop.queueWarning=true;event('warning','排队确认暂不可用，正在核对桌面是否已接收；不会重复发送。');}
    }
    job.attempts??=[];if(!job.attempts.includes(attempt))job.attempts.push(attempt);job.usageIncomplete=!job.desktop.usageRecorded;
    timer=setInterval(poll,pollMs);await poll();
  })().catch(async error=>{await finish(1,error.message);});
  return controller;
}
