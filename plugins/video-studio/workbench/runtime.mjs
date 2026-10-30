import {spawn,execFile} from 'node:child_process';
import {access,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {promisify} from 'node:util';
import path from 'node:path';

const execute=promisify(execFile);
// Workbench support floor, not a universal vendor minimum for every model.
export const minimumCodexVersion='0.153.0';
const requiredFlags=['--ephemeral','--json','--output-schema','--add-dir'];
export function versionParts(value){
  const match=String(value).match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?(?:\s|$)/);
  return match?{numbers:match.slice(1,4).map(Number),pre:match[4]?.split('.')||[]}:null;
}
export function compareVersions(left,right){
  const a=versionParts(left),b=versionParts(right);if(!a||!b)throw new Error('无法识别 Codex 版本。');
  for(let i=0;i<3;i++)if(a.numbers[i]!==b.numbers[i])return Math.sign(a.numbers[i]-b.numbers[i]);
  if(!a.pre.length||!b.pre.length)return a.pre.length===b.pre.length?0:a.pre.length?-1:1;
  for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++){
    if(a.pre[i]===b.pre[i])continue;if(a.pre[i]===undefined)return -1;if(b.pre[i]===undefined)return 1;
    const x=a.pre[i],y=b.pre[i],nx=/^\d+$/.test(x),ny=/^\d+$/.test(y);
    return nx&&ny?Math.sign(Number(x)-Number(y)):nx!==ny?nx?-1:1:x<y?-1:1;
  }return 0;
}

export async function codexCandidates(env=process.env,platform=process.platform){
  const names=platform==='win32'?['codex.exe']:['codex'];
  const onPath=name=>(env.PATH||'').split(path.delimiter).filter(Boolean).flatMap(folder=>names.map(n=>path.join(folder,name||n)));
  const explicit=env.VIDEO_DEMO_CODEX_BIN;
  let candidates=explicit?(path.isAbsolute(explicit)?[explicit]:onPath(explicit)):onPath();
  if(!explicit&&platform==='darwin')candidates.push(
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex');
  const found=[];
  for(const file of candidates)try{await access(file,constants.X_OK);const resolved=await realpath(file);if(!found.includes(resolved))found.push(resolved);}catch{}
  return found;
}

// Read-only protocol: never start a thread or a turn, and never persist raw config.
export function readModelCompatibility(codex,{cwd,env=process.env,timeoutMs=10000}={}){
  return new Promise((resolve,reject)=>{
    let child,buffer='',settled=false,config,models=[],pages=0;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);child?.stdin.end();child?.kill();error?reject(error):resolve(result);};
    const timer=setTimeout(()=>finish(new Error('模型兼容检查超时，请检查网络或更新 Codex 后重新检测。')),timeoutMs);
    const send=(method,id,params)=>child.stdin.write(JSON.stringify({method,...(id!==undefined?{id}:{}),params})+'\n');
    child=spawn(codex,['app-server','--listen','stdio://'],{cwd,env,stdio:['pipe','pipe','pipe']});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',()=>finish(new Error('无法启动 Codex 兼容检查。')));
    child.on('close',()=>finish(new Error('Codex 兼容检查提前结束，请升级后重新检测。')));
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>2*1024*1024)return finish(new Error('模型兼容检查响应过大。'));
      let index;while(!settled&&(index=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let reply;try{reply=JSON.parse(line);}catch{continue;}
        if(![1,2,3].includes(reply.id))continue;
        if(reply.error)return finish(new Error('此 CLI 无法核验当前模型，请更新 Codex 后重新检测。'));
        if(reply.id===1){send('initialized',undefined,{});send('config/read',2,{includeLayers:false,cwd});}
        if(reply.id===2){config=reply.result?.config;if(!config)return finish(new Error('未能读取实际模型设置。'));send('model/list',3,{limit:100,includeHidden:true});}
        if(reply.id===3){
          if(!Array.isArray(reply.result?.data))return finish(new Error('未取得当前 CLI 的模型目录。'));
          models.push(...reply.result.data);
          if(reply.result.nextCursor){if(++pages>=10)return finish(new Error('模型目录未读取完整。'));send('model/list',3,{limit:100,includeHidden:true,cursor:reply.result.nextCursor});continue;}
          const selected=config.model||models.find(m=>m.isDefault)?.model;
          const match=models.find(m=>m.model===selected||m.id===selected);
          if(!selected||!match)return finish(new Error(`当前 CLI 未提供${selected?'模型 '+selected:'默认模型'}的兼容记录。请更新 Codex 后重新检测；工作台不会自动更换模型。`));
          const effort=config.model_reasoning_effort;
          if(effort&&Array.isArray(match.supportedReasoningEfforts)&&!match.supportedReasoningEfforts.some(e=>e.reasoningEffort===effort))return finish(new Error(`当前模型 ${selected} 不支持已配置的推理强度 ${effort}，请在 Codex 调整后重新检测。`));
          finish(null,{model:selected,reasoningEffort:effort||null,minimumVersion:match.minimalClientVersion||match.minimal_client_version||null});
        }
      }
    });
    send('initialize',1,{clientInfo:{name:'video_studio_workbench',title:'Video Studio Workbench',version:'0.3.0'}});
  });
}

export async function inspectCodex({env=process.env,cwd,platform=process.platform,run=execute,modelProbe=readModelCompatibility}={}){
  const checkedAt=new Date().toISOString(),candidates=await codexCandidates(env,platform),checked=[];
  const result={codex:false,authenticated:false,authenticationStatus:'unknown',compatible:false,codexPath:null,codexVersion:null,model:null,reasoningEffort:null,modelMinimumVersion:null,cliCheckFailure:null,minimumCodexVersion,checkedAt,error:null,candidates:checked};
  for(const file of candidates){
    try{const version=(await run(file,['--version'],{cwd,env,timeout:5000,maxBuffer:32000})).stdout.trim();
      const valid=!!versionParts(version)&&compareVersions(version,minimumCodexVersion)>=0;
      checked.push({path:file,version,ok:valid,reason:valid?'':'低于工作台支持版本 '+minimumCodexVersion});
    }catch{checked.push({path:file,version:null,ok:false,reason:'无法执行或识别版本'});}
  }
  const usable=checked.filter(c=>c.ok).sort((a,b)=>compareVersions(b.version,a.version));
  if(!usable.length)return {...result,error:checked.length?`Codex CLI 版本不满足要求（工作台至少 ${minimumCodexVersion}）。请更新 Codex 应用或 CLI，再重新检测。`:'没有找到可执行的 Codex CLI。请安装并登录后重新检测；显式指定的路径不会被自动替换。'};
  const chosen=usable[0];Object.assign(result,{codex:true,codexPath:chosen.path,codexVersion:chosen.version});
  try{
    const checks=await Promise.allSettled([run(chosen.path,['login','status'],{cwd,env,timeout:5000,maxBuffer:32000}),run(chosen.path,['exec','--help'],{cwd,env,timeout:5000,maxBuffer:64000})]);
    const [auth,help]=checks.map(check=>check.status==='fulfilled'?check.value:null);
    if(auth){result.authenticated=/Logged in/i.test(auth.stdout+auth.stderr);result.authenticationStatus=result.authenticated?'logged_in':'not_logged_in';}
    else if(/not logged in/i.test(String(checks[0].reason?.stdout||'')+String(checks[0].reason?.stderr||'')))result.authenticationStatus='not_logged_in';
    const failed=checks.findIndex(check=>check.status==='rejected');
    if(failed>=0){
      const error=checks[failed].reason,stage=failed===0?'登录状态':'执行参数';
      const detail=String(error.stderr||'')+String(error.message||'');
      const directoryError=/getcwd|uv_cwd|current (?:working )?directory|failed to determine.*directory/i.test(detail);
      const kind=directoryError?'working_directory':error.killed?'timeout':result.authenticationStatus==='not_logged_in'&&failed===0?'not_logged_in':'process_failed';
      result.cliCheckFailure={stage:failed===0?'login':'parameters',kind,code:typeof error.code==='number'?error.code:null,signal:error.signal||null};
      result.error=directoryError?'CLI 检查的运行目录已失效，请重新启动工作台；账号登录状态未被修改。':kind==='timeout'?`CLI ${stage}检查超时，暂时未能确认结果，请重新检测。`:kind==='not_logged_in'?'此 Codex CLI 尚未登录，请登录后重新检测。':`CLI ${stage}检查进程未能完成，请重新检测；仍失败时查看运行环境。`;
      return result;
    }
    if(!result.authenticated)throw new Error('请先登录此 Codex CLI，再重新检测。');
    if(requiredFlags.some(flag=>!help.stdout.includes(flag)))throw new Error('当前 CLI 不支持工作台需要的执行参数，请更新 Codex 后重新检测。');
    const proof=await modelProbe(chosen.path,{cwd,env});
    if(proof.minimumVersion&&compareVersions(chosen.version,proof.minimumVersion)<0)throw new Error(`模型 ${proof.model} 要求 CLI ${proof.minimumVersion} 或更新版本，请升级后重新检测。`);
    Object.assign(result,{compatible:true,model:proof.model,reasoningEffort:proof.reasoningEffort,modelMinimumVersion:proof.minimumVersion});
  }catch(error){result.error=error.message||'CLI 兼容检查失败，请重新检测。';}
  return result;
}

export function sourceCapabilities(source,{direct=false}={}){
  const capabilities=['python','media'];
  if(source?.sourceType==='x_repository')capabilities.push(direct?'repository_media':'repository');
  let youtube=source?.sourceType==='youtube';try{youtube||=['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(new URL(source?.url).hostname);}catch{}
  if(youtube)capabilities.push('downloader');
  return capabilities;
}

export function dependencyFailures(report,capabilities){return capabilities.flatMap(id=>{const check=report?.checks?.find(c=>c.id===id);return check?.ok?[]:[check||{id,label:id,message:'尚未检查此依赖，请重新检测。'}];});}
