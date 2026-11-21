import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {startStudio} from '../src/server.mjs';
const exec=promisify(execFile);
const tmp=await mkdtemp(path.join(os.tmpdir(),'studio-webview-'));
const file=process.argv[2]||path.join(os.tmpdir(),'video-studio-webview.png');
const app=await startStudio({root:path.join(tmp,'data')});
try{
  const bin=path.join(tmp,'webview');
  await exec('/usr/bin/xcrun',['swiftc',fileURLToPath(new URL('../test/webview-smoke.swift',import.meta.url)),'-o',bin],{timeout:120000});
  await mkdir(path.dirname(file),{recursive:true});
  const {stdout}=await exec(bin,[app.url,file],{timeout:95000});
  console.log(stdout.trim(),file);
}finally{await app.close();await rm(tmp,{recursive:true,force:true});}
