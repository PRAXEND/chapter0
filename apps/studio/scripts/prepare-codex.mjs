import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {access,mkdir,mkdtemp,rename,rm,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

const exec=promisify(execFile);
export const codexVersion='0.167.0-alpha.3.2';
const expected='TdqlnjV3sbrV7uYvmiOHSJWlYedefDlL4HBPS520DRIlnawSym1fofM7xmeJ9JDx6/WMTrMYwjRHEQ41jsah0A==';
const pkg='https://registry.npmjs.org/@openai/codex/-/codex-'+codexVersion+'-darwin-arm64.tgz';
export async function prepareCodex(){
  const root=path.join(os.homedir(),'Library/Caches/VideoStudioBuild/codex-'+codexVersion);
  const found=async()=>{for(const layout of ['codex/codex','bin/codex','CodexCLI.app/Contents/MacOS/codex']){const candidate=path.join(root,'package/vendor/aarch64-apple-darwin',layout);try{await access(candidate);return candidate;}catch{}}};
  const existing=await found();if(existing)return existing;
  await mkdir(path.dirname(root),{recursive:true});const tmp=await mkdtemp(root+'.tmp-');
  try{
    const file=path.join(tmp,'package.tgz');
    const r=await fetch(pkg,{signal:AbortSignal.timeout(180000)});if(!r.ok)throw Error('Codex 运行包下载失败 '+r.status);
    await pipeline(Readable.fromWeb(r.body),createWriteStream(file,{flags:'wx'}));
    const hash=createHash('sha512');for await(const block of createReadStream(file))hash.update(block);
    if(hash.digest('base64')!==expected)throw Error('Codex 运行包完整性校验失败');
    await exec('/usr/bin/tar',['-xzf',file,'-C',tmp]);await rm(file);
    try{await rename(tmp,root);}catch(e){if(!['EEXIST','ENOTEMPTY'].includes(e.code))throw e;}
    const exe=await found();if(!exe)throw Error('未找到此版本的 Codex 运行程序。');return exe;
  }finally{await rm(tmp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)console.log(await prepareCodex());
