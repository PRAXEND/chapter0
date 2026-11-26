import {mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {startStudio} from '../src/server.mjs';
const run=promisify(execFile),root=await mkdtemp(path.join(os.tmpdir(),'studio-control-webkit-'));
const server=await startStudio({root:path.join(root,'data'),dependencies:{director:{account:async()=>({available:true,connected:false}),close(){}}}});
try{
  const binary=path.join(root,'controls-webkit');
  const src=name=>fileURLToPath(new URL('../test/'+name,import.meta.url));
  await run('/usr/bin/xcrun',['swiftc',src('timeline-player-webkit.swift'),'-o',binary],{timeout:100000});
  const {stdout}=await run(binary,[server.url,src('control-states-webkit.js')],{timeout:100000});
  console.log(stdout.trim());if(!JSON.parse(stdout).passed)throw Error('系统 WebView 控件状态回归未通过。');
}catch(e){if(e.stdout)process.stderr.write(e.stdout);throw e;}
finally{await server.close();await rm(root,{recursive:true,force:true});}
