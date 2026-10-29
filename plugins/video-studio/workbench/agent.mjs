import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {schemas,taskPrompt} from './studio-workflow.mjs';

export function cleanError(value){return String(value||'任务失败').replace(/\x1b\[[0-9;]*m/g,'').replace(/([?&](?:token|access_token|editor-boot-token|key|signature|x-amz-signature)=)[^\s&"']+/gi,'$1[redacted]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').slice(0,900);}
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
export function runAgent({codex,job,context,event,onFinish,timeoutMs}){
  let child,timer,progressTimer,buffer='',stderr='',finalText='',failure='',finished=false,lastProgress='';
  const signalChild=signal=>{if(!child?.pid)return;try{if(process.platform==='win32')child.kill(signal);else process.kill(-child.pid,signal);}catch{}};
  const controller={cancel(reason='user'){job.cancelRequested=true;job.stopReason=reason;if(child){signalChild('SIGTERM');const kill=setTimeout(()=>{if(!finished)signalChild('SIGKILL');},5000);kill.unref();}}};
  const complete=async(code,error)=>{
    if(finished)return;finished=true;clearTimeout(timer);clearInterval(progressTimer);
    if(buffer.trim())consume(buffer);
    job.connectionNotices=stderr.split('\n').filter(line=>/chatcut/i.test(line)).map(line=>cleanError(line)).slice(-12);
    await onFinish({code,error:error?.message||failure||stderr,finalText});
  };
  function consume(line){
    let data;try{data=JSON.parse(line);}catch{return;}
    if(data.type==='thread.started'){job.threadId=data.thread_id;event('thread','独立 Codex 会话已启动');}
    if(data.type==='turn.started')event('working','Agent 正在执行插件工作流');
    const item=data.item;
    if(item?.type==='mcp_tool_call'){
      const tool=String(item.tool||item.name||'tool'),server=String(item.server||'');
      if(data.type==='item.started'){job.toolCalls.push({server,tool,status:'started'});event('tool',`调用 ${server?server+' · ':''}${tool}`);}
      if(data.type==='item.completed'){job.toolCalls.push({server,tool,status:item.status||'completed'});event(item.status==='failed'?'warning':'tool',`${tool} ${item.status==='failed'?'返回失败':'已返回'}`);}
    }
    if(item?.type==='command_execution' && data.type==='item.started')event('local',localStepMessage(item));
    if(item?.type==='agent_message' && data.type==='item.completed')finalText=item.text||'';
    if(data.type==='turn.completed' && data.usage){job.usage=data.usage;event('usage','已收到本次任务的 Token 用量');}
    if(data.type==='error'||data.type==='turn.failed'){failure=data.message||data.error?.message||'Codex 执行失败';event('warning',cleanError(failure));}
  }
  (async()=>{
    const schemaPath=path.join(context.jobDirectory,'output.schema.json');
    await writeFile(schemaPath,JSON.stringify(schemas[job.action]));
    await writeFile(path.join(context.jobDirectory,'request.json'),JSON.stringify(context,null,2));
    const args=['exec','--ephemeral','--sandbox',job.action==='connect'?'read-only':'workspace-write','--skip-git-repo-check','--json','--color','never','--output-schema',schemaPath,'-C',context.run,'--add-dir',context.jobDirectory,'-'];
    if(job.action!=='connect')args.splice(1,0,'-c','sandbox_workspace_write.network_access=true');
    child=spawn(codex,args,{stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',cwd:context.run,env:process.env});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',text=>{buffer+=text;let index;while((index=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,index));buffer=buffer.slice(index+1);}});
    child.stderr.on('data',block=>{stderr=(stderr+block.toString()).slice(-5000);});
    child.stdin.on('error',()=>{});
    child.on('error',e=>complete(null,e));child.on('close',code=>complete(code));
    child.stdin.end(taskPrompt(job.action,context));
    const timeout=timeoutMs??(job.action==='produce'?60*60*1000:['discover','collect','plan'].includes(job.action)?15*60*1000:5*60*1000);
    timer=setTimeout(()=>{failure='任务超时。已停止本地会话；若有远端任务，请继续查询已有状态，勿重复提交。';controller.cancel('timeout');},timeout);
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
