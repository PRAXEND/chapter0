import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {startStudio} from '../src/server.mjs';
import {requiredTool} from '../src/media-runtime.mjs';
const run=promisify(execFile),root=await mkdtemp(path.join(os.tmpdir(),'studio-control-webkit-'));
const server=await startStudio({root:path.join(root,'data'),dependencies:{director:{account:async()=>({available:true,connected:false}),close(){}}}});
try{
  const binary=path.join(root,'controls-webkit');
  const src=name=>fileURLToPath(new URL('../test/'+name,import.meta.url));
  const movie=path.join(root,'clip.mp4'),probe=path.join(root,'probe.js');
  await Promise.all([
    run('/usr/bin/xcrun',['swiftc',src('timeline-player-webkit.swift'),'-o',binary],{timeout:100000}),
    run(await requiredTool('ffmpeg'),['-v','error','-f','lavfi','-i','color=c=blue:s=96x64:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',movie])
  ]);
  const data=(await readFile(movie)).toString('base64');
  await writeFile(probe,'const testMovie='+JSON.stringify(data)+';\n'+await readFile(src('control-states-webkit.js'),'utf8'));
  const {stdout}=await run(binary,[server.url,probe],{timeout:100000});
  console.log(stdout.trim());if(!JSON.parse(stdout).passed)throw Error('系统 WebView 控件状态回归未通过。');
}catch(e){if(e.stdout)process.stderr.write(e.stdout);throw e;}
finally{await server.close();await rm(root,{recursive:true,force:true});}
