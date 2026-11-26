import {execFileSync} from 'node:child_process';
import {copyFile,mkdir,stat,writeFile,rename,rm} from 'node:fs/promises';
import {constants,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import os from 'node:os';
import {currentStyles} from '../src/style-catalog.mjs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileHash} from '../../../plugins/video-studio/workbench/media.mjs';

// A sparse worktree contains Git LFS pointer text. Build from the committed pack and
// materialize each published object by its exact digest, even on a fresh installation.
export async function bundleStyles(repo,destination) {
  const git=(args,input)=>execFileSync('git',args,{cwd:repo,input,maxBuffer:32*1024**2});
  const prefix='user-packs/henry-video-styles/';
  const index=JSON.parse(git(['show','HEAD:'+prefix+'checksums.json']));
  const manifest=JSON.parse(git(['show','HEAD:'+prefix+'manifest.json']));
  const wanted=currentStyles.map(p=>'styles/'+p.id+'-v'+p.version+'.json');
  if(manifest.id!=='henry-video-styles'||!Array.isArray(manifest.styles)||manifest.styles.length!==wanted.length||
    wanted.some(name=>!manifest.styles.includes(name))||Object.keys(index.files).some(n=>
      n.startsWith('styles/')&&!wanted.includes(n)||/^manifest.*\.json$/.test(n)&&n!=='manifest.json'))throw Error('风格发行包目录与当前两套风格不符');
  const required=new Set(['checksums.json',...Object.keys(index.files)].map(n=>prefix+n));
  const files=git(['ls-tree','-rz','HEAD','--',prefix]).toString().split('\0').filter(Boolean).map(row=>{
    const [meta,name]=row.split('\t');const [mode,type,oid]=meta.split(' ');if(type!=='blob'||mode==='120000')throw Error('风格包中有无效文件 '+name);
    return {name,oid};
  }).filter(file=>required.has(file.name));
  if(files.length!==required.size)throw Error('风格发行包缺少校验清单中的文件');
  const raw=git(['cat-file','--batch'],files.map(f=>f.oid).join('\n')+'\n');let cursor=0;
  const gitDir=path.resolve(repo,git(['rev-parse','--git-common-dir']).toString().trim());
  const worktrees=process.env.STUDIO_PACK_CHECKOUT?[path.resolve(process.env.STUDIO_PACK_CHECKOUT)]:[];
  for(const file of files){
    const end=raw.indexOf(10,cursor);const [oid,type,length]=raw.subarray(cursor,end).toString().split(' ');if(oid!==file.oid||type!=='blob')throw Error('风格对象清单损坏');
    const body=raw.subarray(end+1,end+1+Number(length));cursor=end+2+Number(length);
    const out=path.join(destination,file.name);await mkdir(path.dirname(out),{recursive:true});
    const pointer=body.length<256&&/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n?$/.exec(body.toString());
    if(!pointer){await writeFile(out,body);continue;}
    const [,digest,bytes]=pointer;const object=path.join(gitDir,'lfs/objects',digest.slice(0,2),digest.slice(2,4),digest);
    const cache=path.join(os.homedir(),'Library/Caches/VideoStudioBuild/published-media',digest);
    const candidates=[cache,object,...new Set([...worktrees,repo].map(tree=>path.join(tree,file.name)))];
    let ready=false;
    for(const candidate of candidates){
      if((await stat(candidate).catch(()=>null))?.size!==Number(bytes))continue;
      if(await fileHash(candidate)!==digest)continue;
      await copyFile(candidate,out,constants.COPYFILE_FICLONE);ready=true;break;
    }
    if(!ready){
      // Fetch only files already present with this exact pointer in the public release.
      const base='b6a41eeb40f104cfad01a90fe6330606b6ddccb2';
      let published;try{published=git(['cat-file','blob',base+':'+file.name]);}catch{}
      if(published?.equals(body)){
        await mkdir(path.dirname(cache),{recursive:true});const tmp=cache+'.'+randomUUID();
        try{
          const suffix=file.name.split('/').map(encodeURIComponent).join('/');
          const response=await fetch('https://media.githubusercontent.com/media/PRAXEND/chapter0/'+base+'/'+suffix,{signal:AbortSignal.timeout(300000)});
          if(!response.ok)throw Error('风格媒体下载失败 '+response.status);
          await pipeline(Readable.fromWeb(response.body),createWriteStream(tmp,{flags:'wx'}));
          if((await stat(tmp)).size!==Number(bytes)||await fileHash(tmp)!==digest)throw Error('风格媒体下载校验失败 '+file.name);
          await rename(tmp,cache);await copyFile(cache,out,constants.COPYFILE_FICLONE);ready=true;
        }finally{await rm(tmp,{force:true});}
      }
    }
    if(!ready)throw Error('缺少已核验的风格媒体 '+file.name+'，请在视频仓库运行 git lfs fetch origin v0.3.0-web.39 后重新构建。');
  }
}
