import {spawn} from 'node:child_process';
import {mkdir,open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {workbenchDataDirectory} from './paths.mjs';
import {workbenchIdentity} from './plugin.mjs';

export async function ensureWorkbench({env=process.env, timeoutMs=30000}={}) {
  const port=Number(env.PORT||4317);
  if (!Number.isInteger(port)||port<1||port>65535) throw new Error('PORT 需要为 1–65535 的整数。');
  const url=`http://127.0.0.1:${port}`, dataDirectory=workbenchDataDirectory(env);
  const root=path.dirname(fileURLToPath(import.meta.url)),identity=await workbenchIdentity(root,env);
  async function probe() {
    let response;
    try {response=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1500)});}
    catch(error) {
      if (error.cause?.code==='ECONNREFUSED') return null;
      throw new Error('无法核对工作台端口，请检查已有服务后再启动。');
    }
    let health;try {health=await response.json();}catch{}
    if (health?.app!=='video-studio-workbench') throw new Error(`端口 ${port} 已被其他服务占用，未替换该服务。`);
    if (typeof health.dataDirectory!=='string'||path.resolve(health.dataDirectory)!==dataDirectory) throw new Error('此端口的工作台使用另一个数据目录，未切换或覆盖其项目。');
    if(health.version!==identity.version||health.runtimeIdentity?.signature!==identity.signature)
      throw new Error(`端口 ${port} 的工作台版本、代码目录或风格目录与本次启动不一致。已有版本：${health.version||'未知'}；本次版本：${identity.version}。请在已有任务结束后停止原服务，再从本次插件目录启动；未复用或关闭旧服务。`);
    return {url,version:health.version,dataDirectory};
  }
  const existing=await probe();if(existing)return {...existing,reused:true};
  await mkdir(dataDirectory,{recursive:true,mode:0o700});
  const logFile=path.join(dataDirectory,'server.log'), log=await open(logFile,'a',0o600);
  let child,exitCode,spawnError;
  try {
    child=spawn(process.execPath,[path.join(root,'studio-server.mjs')],{cwd:dataDirectory,env:{...env,VIDEO_STUDIO_WEB_DATA:dataDirectory,VIDEO_STUDIO_PLUGIN_ROOT:identity.pluginRoot,
      ...(identity.styleHome?{VIDEO_STUDIO_HOME:identity.styleHome}:{}),...(identity.packRoot?{VIDEO_STUDIO_PACK_ROOT:identity.packRoot}:{})},detached:true,stdio:['ignore',log.fd,log.fd]});
    child.on('error',error=>{spawnError=error;});child.on('exit',code=>{exitCode=code;});child.unref();
  } finally {await log.close();}
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    if(spawnError||exitCode!==undefined)throw new Error(`工作台未能启动，请查看 ${logFile}`);
    await delay(250);
    const ready=await probe();if(ready)return {...ready,reused:false,pid:child.pid,logFile};
  }
  throw new Error(`启动尚未确认。请查看 ${logFile}，再次调用会先核对现有服务。`);
}
