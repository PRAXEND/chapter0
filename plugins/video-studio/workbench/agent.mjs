import {spawn} from 'node:child_process';
import {readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {schemas,taskPrompt} from './studio-workflow.mjs';

export function cleanError(value){return String(value||'任务失败').replace(/\x1b\[[0-9;]*m/g,'').replace(/([?&](?:token|access_token|editor-boot-token|key|signature|x-amz-signature)=)[^\s&"']+/gi,'$1[redacted]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').slice(0,900);}
export function failureKind(value){const text=String(value||'');return /requires a newer version of Codex|upgrade.*(?:app or CLI|Codex)/i.test(text)?'cli_incompatible':/yt-dlp is missing|Missing executable:\s*(?:ffmpeg|ffprobe)|No module named ['"]?yt_dlp/i.test(text)?'dependency_missing':/connection refused|ECONNREFUSED/i.test(text)?'connection_refused':null;}
function localStepMessage(item){
  const command=String(item.command||'');
  if(/serve-local-media|upload-media/.test(command))return '准备导入本次选定的素材';
  if(/ffprobe/.test(command))return '读取视频规格与实际时长';
  if(/ffmpeg/.test(command))return '分析素材画面或检查完整解码';
  if(/SKILL\.md|style\.json/.test(command))return '读取风格与制作流程';
  if(/studio\.py/.test(command))return '保存或检查插件制作记录';
  return '执行本地工作流步骤';
}
export function jobStopState(job){return job.stopReason==='timeout'
  ?{status:'failed',error:'任务达到运行时限，已有素材和分析结果已保留。可重试并复用记录；如有远端任务，应先查询已有状态。'}
  :{status:'cancelled',error:'本地会话已停止。已提交的远端任务需要在继续时查询状态。'};}
export function runAgent({codex,job,context,event,onFinish,onSourceProgress,timeoutMs,progressIntervalMs=1500}){
  let child,timer,progressTimer,buffer='',stderr='',finalText='',failure='',finished=false,lastProgress='',lastSourceProgress='',progressPending=Promise.resolve(),refused=0;
  const signalChild=signal=>{if(!child?.pid)return;try{if(process.platform==='win32')child.kill(signal);else process.kill(-child.pid,signal);}catch{}};
  const controller={cancel(reason='user'){job.cancelRequested=true;job.stopReason=reason;if(child){signalChild('SIGTERM');const kill=setTimeout(()=>{if(!finished)signalChild('SIGKILL');},5000);kill.unref();}}};
  const complete=async(code,error)=>{
    if(finished)return;finished=true;clearTimeout(timer);clearInterval(progressTimer);
    if(buffer.trim())consume(buffer);
    await readSourceProgress();await progressPending;
    job.connectionNotices=stderr.split('\n').filter(line=>/chatcut/i.test(line)).map(line=>cleanError(line)).slice(-12);
    await onFinish({code:job.failureKind&&code===0?1:code,error:error?.message||failure||stderr,finalText});
  };
  const readSourceProgress=async()=>{
    if(job.action!=='discover'||!context.sourceProgressPath||!onSourceProgress)return;
    progressPending=progressPending.catch(()=>{}).then(async()=>{
      try{if((await stat(context.sourceProgressPath)).size>512000)throw new Error('候选检查点超过大小限制');const raw=await readFile(context.sourceProgressPath,'utf8');if(raw===lastSourceProgress)return;const snapshot=JSON.parse(raw);await onSourceProgress(snapshot);lastSourceProgress=raw;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))event('warning','中间候选尚未保存：'+cleanError(error.message));}
    });return progressPending;
  };
  const stopOnFailure=message=>{
    const kind=failureKind(message);if(!kind)return;
    if(kind==='connection_refused'&&++refused<3)return;
    job.failureKind=kind;
    failure=kind==='cli_incompatible'?'当前模型要求更新的 Codex。请升级实际使用的应用或 CLI，再重新检测；已停止本次调用，未更换模型。':kind==='dependency_missing'?'下载或媒体依赖缺失。请先补齐依赖并重新检测；已停止继续探测，已有候选会保留。':'连接连续被拒绝 3 次，已停止本轮重试并保存已有候选。请检查网络或对应服务，恢复后继续，避免重复采集。';
    signalChild('SIGTERM');
    const kill=setTimeout(()=>{if(!finished)signalChild('SIGKILL');},5000);kill.unref();
  };
  function consume(line){
    let data;try{data=JSON.parse(line);}catch{return;}
    if(data.type==='thread.started'){job.threadId=data.thread_id;event('thread','独立 Codex 会话已启动');}
    if(data.type==='turn.started'){refused=0;event('working','Agent 正在执行插件工作流');}
    const item=data.item;
    if(item?.type==='mcp_tool_call'){
      const tool=String(item.tool||item.name||'tool'),server=String(item.server||'');
      if(data.type==='item.started'){job.toolCalls.push({server,tool,status:'started'});event('tool',`调用 ${server?server+' · ':''}${tool}`);}
      if(data.type==='item.completed'){job.toolCalls.push({server,tool,status:item.status||'completed'});event(item.status==='failed'?'warning':'tool',`${tool} ${item.status==='failed'?'返回失败':'已返回'}`);}
    }
    if(item?.type==='command_execution' && data.type==='item.started')event('local',localStepMessage(item));
    if(item?.type==='command_execution' && data.type==='item.completed'&&item.exit_code)stopOnFailure(item.aggregated_output);
    if(item?.type==='agent_message' && data.type==='item.completed')finalText=item.text||'';
    if(data.type==='turn.completed' && data.usage){job.usage=data.usage;event('usage','已收到本次任务的 Token 用量');}
    if(data.type==='error'||data.type==='turn.failed'){const message=data.message||data.error?.message||'Codex 执行失败';failure=message;stopOnFailure(message);event('warning',cleanError(failure));}
  }
  (async()=>{
    const schemaPath=path.join(context.jobDirectory,'output.schema.json');
    await writeFile(schemaPath,JSON.stringify(schemas[job.action]));
    await writeFile(path.join(context.jobDirectory,'request.json'),JSON.stringify(context,null,2));
    // Optional MCP servers otherwise get only a short catalog-building grace period.
    // Wait for their bounded startup before this independent session sees its tools.
    const args=['exec','-c','mcp_optional_startup_grace_ms=0','--ephemeral','--sandbox',job.action==='connect'?'read-only':'workspace-write','--skip-git-repo-check','--json','--color','never','--output-schema',schemaPath,'-C',context.run,'--add-dir',context.jobDirectory,'-'];
    if(job.execution?.model)args.splice(1,0,'--model',job.execution.model);
    if(job.action!=='connect')args.splice(1,0,'-c','sandbox_workspace_write.network_access=true');
    const programDirs=Object.values(context.environment?.programs||{}).filter(Boolean).map(file=>path.dirname(file));
    const env={...process.env,PATH:[...new Set([...programDirs,process.env.PATH||''])].join(path.delimiter)};
    if(context.environment?.python)env.VIDEO_STUDIO_PYTHON=context.environment.python;
    if(context.environment?.programs?.ffmpeg)env.VIDEO_STUDIO_FFMPEG_DIR=path.dirname(context.environment.programs.ffmpeg);
    child=spawn(codex,args,{stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',cwd:context.run,env});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',text=>{buffer+=text;let index;while((index=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,index));buffer=buffer.slice(index+1);}});
    child.stderr.on('data',block=>{stderr=(stderr+block.toString()).slice(-5000);});
    child.stdin.on('error',()=>{});
    child.on('error',e=>complete(null,e));child.on('close',code=>complete(code));
    child.stdin.end(taskPrompt(job.action,context));
    const timeout=timeoutMs??(job.action==='produce'?60*60*1000:['discover','collect','plan'].includes(job.action)?15*60*1000:5*60*1000);
    timer=setTimeout(()=>{failure='任务超时。已停止本地会话；若有远端任务，请继续查询已有状态，勿重复提交。';controller.cancel('timeout');},timeout);
    if(job.action==='discover')progressTimer=setInterval(()=>{readSourceProgress();},progressIntervalMs);
    if(job.action==='produce')progressTimer=setInterval(async()=>{
      try{
        const raw=await readFile(path.join(context.run,'workbench-progress.json'),'utf8');
        if(raw===lastProgress)return;lastProgress=raw;const progress=JSON.parse(raw);
        if(['importing','narration','editing','exporting','reviewing'].includes(progress.stage)){
          job.productionStage=progress.stage;event('progress',cleanError(progress.message||progress.stage));
          if(typeof progress.editorUrl==='string'){try{const url=new URL(progress.editorUrl);if(url.protocol==='https:'&&url.hostname==='app.chatcut.io'){url.searchParams.delete('editor-boot-token');url.searchParams.delete('dockviewLayout');job.editorUrl=url.href;}}catch{}}
        }
      }catch{}
    },1500);
    if(job.cancelRequested)controller.cancel();
  })().catch(e=>complete(null,e));
  return controller;
}
