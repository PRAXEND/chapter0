import {spawn,execFile} from 'node:child_process';
import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {promisify} from 'node:util';

const root=path.dirname(fileURLToPath(import.meta.url));
if(Number(process.versions.node.split('.')[0])<20) {
  console.error('请先安装 Node.js 20 或更新版本：https://nodejs.org/');
  process.exit(1);
}
const env={...process.env};
// Finder-launched terminals may not have the bundled Codex CLI on PATH.
if(!env.VIDEO_DEMO_CODEX_BIN && process.platform==='darwin') {
  try {await promisify(execFile)('codex',['--version'],{timeout:5000});}
  catch {
    const bundled='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
    try {await access(bundled);env.VIDEO_DEMO_CODEX_BIN=bundled;}catch{}
  }
}
console.log('Video Studio 视频制作工作台\n关闭此窗口或按 Ctrl+C 可停止服务。\n');
const child=spawn(process.execPath,[path.join(root,'studio-server.mjs')],{cwd:root,env,stdio:['inherit','pipe','inherit']});
let opened=false,buffer='';
child.stdout.setEncoding('utf8');
child.stdout.on('data',text=>{
  process.stdout.write(text);
  buffer=(buffer+text).slice(-4000);
  const match=buffer.match(/Video Agent Demo: (http:\/\/127\.0\.0\.1:\d+)/);
  if(opened || !match)return;
  opened=true;
  if(env.FRAME_DEMO_NO_BROWSER==='1')return;
  const url=match[1];
  const command=process.platform==='darwin'?['open',[url]]:process.platform==='win32'?['cmd.exe',['/d','/c','start','',url]]:['xdg-open',[url]];
  execFile(command[0],command[1],error=>{if(error)console.log('请手动在浏览器打开：'+url);});
});
child.on('error',error=>{console.error('无法启动服务：'+error.message);process.exitCode=1;});
child.on('close',code=>{process.exitCode=code ?? 1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
