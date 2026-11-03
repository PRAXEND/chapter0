import {readFile,writeFile,mkdir,unlink,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';

const execute=promisify(execFile);
const environmentPath=value=>path.resolve(value.startsWith('~/')?path.join(os.homedir(),value.slice(2)):value);
export async function findPlugin(root,env=process.env){
  const candidates=env.VIDEO_STUDIO_PLUGIN_ROOT?[environmentPath(env.VIDEO_STUDIO_PLUGIN_ROOT)]:[path.resolve(root,'..'),path.resolve(root,'../../plugins/video-studio'),path.resolve(root,'../plugins/video-studio')];
  for(const folder of candidates){try{const m=JSON.parse(await readFile(path.join(folder,'plugin.json'),'utf8'));if(m.name==='video-studio'){await readFile(path.join(folder,'scripts/web_bridge.py'));return {root:await realpath(folder),version:m.version};}}catch{}}
  throw new Error('找不到支持网页工作台的 Video Studio 插件，请安装随包插件或设置 VIDEO_STUDIO_PLUGIN_ROOT。');
}
export async function workbenchIdentity(root,env=process.env){
  const plugin=await findPlugin(root,env);
  const identity={pluginRoot:plugin.root,version:plugin.version,serverRoot:await realpath(root),
    styleHome:env.VIDEO_STUDIO_HOME?environmentPath(env.VIDEO_STUDIO_HOME):null,
    packRoot:env.VIDEO_STUDIO_PACK_ROOT?environmentPath(env.VIDEO_STUDIO_PACK_ROOT):null};
  return {...identity,signature:createHash('sha256').update(JSON.stringify(identity)).digest('hex')};
}
export function createPluginBridge(plugin,dataDir){
  const python=process.env.VIDEO_STUDIO_PYTHON || 'python3';
  return async function bridge(action,payload){
    const args=[path.join(plugin.root,'scripts/web_bridge.py'),action];let file;
    if(payload!==undefined){await mkdir(dataDir,{recursive:true});file=path.join(dataDir,'bridge-'+randomUUID()+'.json');await writeFile(file,JSON.stringify(payload),{mode:0o600});args.push('--file',file);}
    try{const result=await execute(python,args,{timeout:action==='bootstrap'?660000:action==='verify-video'?360000:45000,maxBuffer:5*1024*1024});return JSON.parse(result.stdout);}
    catch(e){let message;try{message=JSON.parse(e.stderr).error;}catch{}throw new Error(message || (e.code==='ENOENT'?'找不到 Python 3.10+，请检查本地环境。':`插件步骤 ${action} 执行失败。`));}
    finally{if(file)await unlink(file).catch(()=>{});}
  };
}
