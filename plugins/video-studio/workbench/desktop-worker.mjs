import {readFile,lstat,open,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function validateResult(value,schema,where='$'){
  const bad=message=>{throw Error(`${where}: ${message}`);};
  if(schema.anyOf){if(!schema.anyOf.some(s=>{try{validateResult(value,s,where);return true;}catch{return false;}}))bad('不符合任一结果格式');return;}
  if('const'in schema&&JSON.stringify(value)!==JSON.stringify(schema.const))bad('值不一致');
  if(schema.enum&&!schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)))bad('不在允许值中');
  const type=Array.isArray(value)?'array':value===null?'null':typeof value;
  if(schema.type&&!(Array.isArray(schema.type)?schema.type:[schema.type]).some(t=>t===type||t==='integer'&&Number.isInteger(value)))bad('类型错误');
  if(type==='object'){
    for(const key of schema.required||[])if(!(key in value))bad('缺少 '+key);
    for(const [key,v]of Object.entries(value)){if(schema.properties?.[key])validateResult(v,schema.properties[key],where+'.'+key);else if(schema.additionalProperties===false)bad('多余字段 '+key);}
  }
  if(type==='array'){if(value.length<(schema.minItems??0)||value.length>(schema.maxItems??Infinity))bad('数量不符');value.forEach((v,i)=>validateResult(v,schema.items||{},`${where}[${i}]`));}
  if(type==='number'&&(!Number.isFinite(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity)))bad('数值超出范围');
  if(type==='string'&&(value.length<(schema.minLength??0)||value.length>(schema.maxLength??Infinity)||schema.pattern&&!new RegExp(schema.pattern).test(value)))bad('文本格式错误');
  return value;
}
export async function readRegularJson(file){const info=await lstat(file);if(!info.isFile()||info.size>4*1024*1024)throw Error('结果必须为不超过 4 MB 的普通文件');return JSON.parse(await readFile(file,'utf8'));}
export async function workerCommand(command,ticketFile,resultFile){
  const ticket=await readRegularJson(ticketFile),directory=path.dirname(ticketFile);
  if(ticket.schema!==1||ticket.revoked||Date.now()>ticket.leaseUntil)throw Error('工作台任务已停止或连接已过期。不得继续执行或提交；请回到工作台恢复。');
  const base={schema:1,jobId:ticket.jobId,requestId:ticket.requestId,threadId:ticket.threadId};
  if(command==='claim'){
    const ack=path.join(directory,'desktop-ack.json');const handle=await open(ack,'wx',0o600);try{await handle.writeFile(JSON.stringify({...base,claimedAt:new Date().toISOString()}));}finally{await handle.close();}
    return {...base,promptFile:ticket.promptFile};
  }
  const ack=await readRegularJson(path.join(directory,'desktop-ack.json'));
  if(Object.keys(base).some(k=>base[k]!==ack[k]))throw Error('任务执行回执不一致');
  if(command==='check')return {...base,active:true};
  if(command!=='complete')throw Error('未知操作');
  const result=validateResult(await readRegularJson(resultFile),await readRegularJson(ticket.schemaFile));
  const target=path.join(directory,'desktop-result.json'),tmp=target+'.tmp';const handle=await open(tmp,'wx',0o600);
  try{await handle.writeFile(JSON.stringify({...base,result}));}finally{await handle.close();}await rename(tmp,target);
  return {...base,submitted:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  workerCommand(...process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
