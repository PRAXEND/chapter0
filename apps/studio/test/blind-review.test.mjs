import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFile,mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createBlindReview} from '../src/blind-review.mjs';
import {createBlindRoutes} from '../src/blind-routes.mjs';

async function fixture(t) {
  const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'studio-rating-')));t.after(()=>rm(dir,{recursive:true,force:true}));
  const outputs=path.join(dir,'output');await mkdir(outputs);
  const files=[];
  for(let i=0;i<18;i++){const f=path.join(outputs,i+'.mp4');await writeFile(f,'fixture '+i);files.push(f);}
  return {library:createBlindReview(dir),dir,outputs,files};
}
test('held out protocol counts pending usable files as false blocks, refuses to count missing severe locations',async t=>{
  const {library,files}=await fixture(t);
  const samples=files.map((videoPath,i)=>({videoPath,mode:['topic','script','interview'][i%3],systemStatus:i>=12?'repair':i===1?'unverified':'deliverable',systemIssues:i>=12?[{severity:'major',fromFrame:30,toFrame:35}]:[]}));
  const s=await library.create({kind:'gate',samples});
  assert.equal((await library.summary(s.id)).thresholdMet,null);
  for(const person of ['synthetic-test-1','synthetic-test-2']) {
    const session=await library.open(s.id,person);
    assert.equal(session.items.length,18);assert.equal('samples' in session,false);
    for(const i of session.items){
      const file=await library.media(s.id,person,i.code);
      const n=files.indexOf(file);
      await library.rate(s.id,person,{code:i.code,decision:n>=12?'redo':'usable',observation:'合成测试输入',fromFrame:30,toFrame:35});
    }
  }
  const result=await library.summary(s.id);
  assert.equal(result.thresholdMet,true);assert.equal(result.metrics.falseBlocks,1);assert.equal(result.metrics.severeLocated,6);
});
test('style protocol, hashed freeze and pairs keep project and source identities out of the ballot',async t=>{
  const {library,files}=await fixture(t);
  const samples=files.slice(0,12).map((videoPath,i)=>({videoPath,mode:'script',expected:i%2?'热点':'科普',topicGroup:'topic-'+Math.floor(i/4)}));
  const s=await library.create({kind:'style',samples});
  for(const person of ['fixture-a','fixture-b']) {
    const session=await library.open(s.id,person);
    for(const item of session.items) {
      assert.equal('expected' in item,false);
      const n=files.indexOf(await library.media(s.id,person,item.code));
      await library.rate(s.id,person,{code:item.code,decision:samples[n].expected,observation:'合成测试输入'});
    }
  }
  assert.ok((await library.summary(s.id)).thresholdMet);
  const paired=await library.create({kind:'pair',samples:[{mode:'script',videoPath:files[0],comparisonPath:files[1],primary:'workbench'}]});
  for(const person of ['fixture-a','fixture-b']){
    const session=await library.open(paired.id,person),code=session.items[0].code;
    const decision=(await library.media(paired.id,person,code,'A'))===files[0]?'A':'B';
    await library.rate(paired.id,person,{code,decision,observation:'测试选择同一来源'});
    await assert.rejects(library.rate(paired.id,person,{code,decision,observation:'重复'}),/已提交/);
  }
  assert.equal((await library.summary(paired.id)).metrics.workbench,1);
  const v=await library.open(s.id,'new-viewer');await writeFile(files[files.indexOf(await library.media(s.id,'new-viewer',v.items[0].code))],'changed');
  await assert.rejects(library.media(s.id,'new-viewer',v.items[0].code),/变化/);
  await assert.rejects(library.create({kind:'gate',samples:[{mode:'topic',videoPath:'/etc/passwd',systemStatus:'repair'}]}),/已授权/);
});
test('HTTP curator accepts only registered candidates, anonymizes filenames and serves byte ranges',async t=>{
  const {library,files,outputs}=await fixture(t);
  const j={id:'job',projectId:'p',status:'done',kind:'render',revision:2,createdAt:'2026-10-01',qa:{status:'deliverable',candidatePlayable:true},files:{video:files[0]}};
  const store={listJobs:()=>[j],get:()=>({id:'p',mode:'script',title:'project name'}),getJob:id=>id==='job'?j:null,paths:()=>({outputs})};
  const handle=createBlindRoutes({blind:library,store});const server=createServer((req,res)=>handle(req,res,new URL(req.url,'http://localhost')));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const address='http://127.0.0.1:'+server.address().port;
  async function post(url,data) {return fetch(address+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});}
  const wrong=await post('/api/blind/studies',{kind:'gate',samples:[{videoPath:'/etc/passwd'}]});assert.equal(wrong.status,400);
  const created=await (await post('/api/blind/studies',{kind:'gate',samples:[{jobId:'job',projectId:'p'}]})).json();
  const root='/api/blind/studies/'+created.id;const session=await (await post(root+'/session',{reviewer:'fixture'})).json();
  const url=address+root+'/media?reviewer=fixture&code='+session.items[0].code;
  const part=await fetch(url,{headers:{range:'bytes=0-3'}});assert.equal(part.status,206);assert.equal(await part.text(),'fixt');
  const bad=await fetch(url,{headers:{range:'bytes=999999-9999999'}});assert.equal(bad.status,416);
  const page=await fetch(address+'/blind');assert.match(await page.text(),/审片人名称/);
});
