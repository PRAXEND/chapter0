import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {provisionalPackage} from '../provisional.mjs';
import {fileHash} from '../media.mjs';
const exec=promisify(execFile);
test('failed candidate has immutable complete local artifacts and a real ZIP without formal delivery',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'provisional-')),run=path.join(temp,'run');await mkdir(run);
  try{
    const files=[];for(const [name,role,bytes] of [['v.mp4','video','protocol fixture video'],['s.srt','subtitles','test subtitle'],['p.png','cover_portrait',Buffer.from([137,80,78,71,13,10,26,10])],['h.png','cover_landscape',Buffer.from([137,80,78,71,13,10,26,10])],['copy.txt','copy','标题：测试\n正文：测试内容\n话题：#测试']]){
      const file=path.join(run,name);await writeFile(file,bytes);files.push({path:file,role,sha256:await fileHash(file)});
    }
    const candidate={files,producerJobId:'producer',projectId:'p',timelineId:'t',qaStatus:'failed'};
    const project={run,topic:'test',outputRoot:path.join(temp,'output'),captions:true,plan:{shots:[{to:3}]},sources:[],selected:[],deliveries:[]};
    const bridge=async(action,{file,directory})=>{
      if(action==='inspect-media')return file.endsWith('p.png')?{width:300,height:400}:{width:400,height:300};
      assert.equal(action,'archive-package');const output=path.join(directory,'完整临时交付.zip');
      await exec('/usr/bin/python3',['-c',"import pathlib,sys,zipfile;d=pathlib.Path(sys.argv[1]);z=zipfile.ZipFile(sys.argv[2],'w');[z.write(p,p.name) for p in d.iterdir() if p.is_file() and str(p)!=sys.argv[2]];z.close()",directory,output]);return {file:output};
    };
    const report={completed:false,checks:{visuals:{status:'fail'}}};
    const d=await provisionalPackage(project,candidate,report,bridge);assert.equal(d.complete,true);assert.equal(d.qaStatus,'provisional');assert.equal(project.deliveries.length,0);
    assert.equal((await provisionalPackage(project,candidate,report,bridge)).id,d.id);
    const zip=d.files.find(f=>f.role==='archive');const result=await exec('/usr/bin/python3',['-c',"import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps(z.namelist()))",zip.path]);
    assert.equal(JSON.parse(result.stdout).length,10);assert.match(await readFile(path.join(d.directory,'请先阅读.txt'),'utf8'),/尚未通过/);
    await writeFile(files[0].path,'new render');assert.equal(await fileHash(d.files.find(f=>f.role==='video').path),files[0].sha256);
    await assert.rejects(()=>provisionalPackage(project,candidate,report,bridge),/变化/);
  }finally{await rm(temp,{recursive:true,force:true});}
});
