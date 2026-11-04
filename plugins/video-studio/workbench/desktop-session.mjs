import {readFile,writeFile,rename,realpath,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {DesktopReader} from './desktop-rpc.mjs';

export const validThreadId=id=>typeof id==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id);
export async function atomicJson(file,value){const tmp=file+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,file);}
export async function readPermissions(reader,thread){
  if(!thread.path||!reader.codexHome)throw Error('此 Codex 版本未提供可核验的桌面权限记录，请更新应用。');
  const [file,base]=await Promise.all([realpath(thread.path),realpath(path.join(reader.codexHome,'sessions'))]);
  if(!file.startsWith(base+path.sep)||(await stat(file)).size>512*1024*1024)throw Error('桌面会话记录路径或大小异常，请使用新的专用会话。');
  let context,identity;
  const lines=createInterface({input:createReadStream(file),crlfDelay:Infinity});
  for await(const line of lines){let row;try{row=JSON.parse(line);}catch{continue;}if(row.type==='session_meta')identity=row.payload?.id;if(row.type==='turn_context')context=row.payload;}
  if(identity!==thread.id)throw Error('桌面会话记录身份不一致。');
  return {fullAccess:context?.approval_policy==='never'&&context?.sandbox_policy?.type==='danger-full-access',model:context?.model||thread.model,reasoningEffort:context?.effort||context?.reasoning_effort||null};
}
export function turnText(turn){return (turn.items||[]).filter(i=>i.type==='userMessage').flatMap(i=>i.content||[]).filter(i=>i.type==='text').map(i=>i.text).join('\n');}
// A separate read-only app-server does not own the desktop's live turn and can
// infer "interrupted" for an unfinished rollout. Use actual lifecycle events.
export async function desktopActivity(reader,id){
  if(reader.activity)return reader.activity(id);
  reader.activityCache??=new Map();let entry=reader.activityCache.get(id);
  if(!entry){const {thread}=await reader.call('thread/read',{threadId:id,includeTurns:false});await readPermissions(reader,thread);entry={file:await realpath(thread.path),offset:0,buffer:'',turns:new Map(),usage:new Map(),totals:{},baseline:{},latest:null};reader.activityCache.set(id,entry);}
  const size=(await stat(entry.file)).size;if(size<entry.offset){entry.offset=0;entry.buffer='';entry.turns.clear();entry.latest=null;}
  if(size>entry.offset){
    const stream=createReadStream(entry.file,{start:entry.offset,end:size-1,encoding:'utf8'});for await(const text of stream)entry.buffer+=text;entry.offset=size;
    let end;while((end=entry.buffer.indexOf('\n'))>=0){const line=entry.buffer.slice(0,end);entry.buffer=entry.buffer.slice(end+1);let row;try{row=JSON.parse(line);}catch{continue;}
      const v=row.payload;if(row.type!=='event_msg')continue;
      if(v?.type==='token_count'&&v.info?.total_token_usage){
        entry.totals=v.info.total_token_usage;
        const delta=Object.fromEntries(Object.entries(entry.totals).map(([k,n])=>[k,n-(entry.baseline[k]||0)]));
        if(entry.latest&&Object.values(delta).every(n=>Number.isSafeInteger(n)&&n>=0))entry.usage.set(entry.latest,delta);
      }
      const turnId=v?.turn_id||v?.turn_attribution?.turn_id||(v?.type==='turn_aborted'?entry.latest:null);if(!turnId)continue;
      if(v.type==='task_started'){entry.turns.set(turnId,'inProgress');entry.latest=turnId;entry.baseline={...entry.totals};}
      if(v.type==='task_complete')entry.turns.set(turnId,'completed');
      if(v.type==='turn_aborted')entry.turns.set(turnId,'interrupted');
    }
  }
  return entry;
}
export async function inspectDesktop(reader,id,{allowBusy=false}={}){
  if(!validThreadId(id))throw Error('请选择本机 Codex 桌面会话。');
  const {thread}=await reader.call('thread/read',{threadId:id,includeTurns:false});
  if(thread.source!=='vscode'||thread.originator!=='Codex Desktop')throw Error('请选择 Codex 桌面端建立的本地会话。');
  const permissions=await readPermissions(reader,thread);
  if(!permissions.fullAccess)throw Error('请在所选桌面会话开启“完全访问”，发送一条简短消息并等待完成，再保存配置。');
  const activity=await desktopActivity(reader,id);
  if(!allowBusy&&activity.turns.get(activity.latest)==='inProgress')throw Error('所选桌面会话正在执行其他任务，请等待完成。');
  return {threadId:id,title:thread.name||thread.preview||'未命名会话',...permissions,checkedAt:new Date().toISOString()};
}
export function desktopSessions({dataDir,codex,env=process.env,Reader=DesktopReader}){
  const file=path.join(dataDir,'desktop-session.json');let config={schema:1,mode:env.VIDEO_STUDIO_AGENT_MODE==='cli'?'cli':'desktop'},reader;
  const client=()=>{if(!reader)reader=new Reader(codex(),{cwd:dataDir});return reader;};
  return {
    async load(){try{const saved=JSON.parse(await readFile(file,'utf8'));if(saved.schema===1&&validThreadId(saved.threadId))config={...saved,mode:config.mode};}catch(e){if(e.code!=='ENOENT')throw e;}},
    state(){return {...config,configured:config.mode==='cli'||!!config.threadId};},
    async list(){const result=await client().call('thread/list',{limit:60,sortKey:'updated_at',sortDirection:'desc',sourceKinds:['vscode'],archived:false});return (result.data||[]).filter(t=>t.originator==='Codex Desktop').map(t=>({id:t.id,title:t.name||t.preview?.slice(0,80)||'未命名会话',cwd:t.cwd}));},
    async configure(id){const checked=await inspectDesktop(client(),id);config={schema:1,mode:'desktop',...checked};await atomicJson(file,config);return this.state();},
    async requireReady(){if(config.mode==='cli')return null;if(!config.threadId)throw Error('首次使用请先完成“桌面执行会话”配置，再点击一键生成。');return inspectDesktop(client(),config.threadId);},
    reader:client,
    close(){reader?.close();}
  };
}
