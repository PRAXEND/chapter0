import {appendFile} from 'node:fs/promises';

// Store lifecycle/timing metadata, never tool inputs, tool output bodies or reasoning text.
export function executionLog(file){
  let pending=Promise.resolve(),bytes=0;
  return {
    write(record){const line=JSON.stringify({at:new Date().toISOString(),...record})+'\n';if(bytes+Buffer.byteLength(line)>2*1024*1024)return;bytes+=Buffer.byteLength(line);pending=pending.then(()=>appendFile(file,line,{mode:0o600})).catch(()=>{});},
    flush(){return pending;}
  };
}
export function activityEvent(data){
  if(!['item.started','item.completed','item.updated'].includes(data.type))return false;
  return ['command_execution','mcp_tool_call','agent_message','reasoning','web_search','file_change'].includes(data.item?.type);
}
export function executionEvent(data,elapsedMs){
  const item=data.item;
  return {event:data.type,elapsedMs,...(item?{itemType:item.type,itemId:item.id,status:item.status,exitCode:item.exit_code,...(item.type==='mcp_tool_call'?{server:item.server,tool:item.tool||item.name}:{})}:{})};
}
