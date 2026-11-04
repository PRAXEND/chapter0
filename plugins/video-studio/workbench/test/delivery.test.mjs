import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {initialStudio,brief,inputHash} from '../studio-workflow.mjs';
import {bindCandidate,validateDeliveryFiles,enforceIndependentReview} from '../quality.mjs';
import {fileHash,contained} from '../media.mjs';

const source=await fs.readFile(new URL('../studio-server.mjs',import.meta.url),'utf8');
const deliver=source.slice(source.indexOf('async function deliver('),source.indexOf('\nasync function savePlan('));
async function fixture({failCopy=false,onApproval=async()=>{}}={}){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'delivery-recovery-')),run=path.join(temp,'run'),outputRoot=path.join(temp,'output');
  await fs.mkdir(run);await fs.mkdir(outputRoot);
  const producer={id:'producer',threadId:'producer-thread',inputHash:'inputs',planHash:'plan',toolCalls:[{server:'chatcut',tool:'track_export',status:'completed'}]};
  const report={completed:true,independentJobId:'reviewer',independentThreadId:'reviewer-thread',producerJobId:'producer',checks:{visuals:{method:'sampled_composited_frames'}}};
  await fs.writeFile(path.join(run,'run.json'),JSON.stringify({project:{projectId:'project',timelineId:'timeline',planHash:'plan',inputHash:'inputs'},reviews:{visuals:{reviewer_job_id:'reviewer',reviewer:'reviewer-thread',producer_job_id:'producer'}}}));
  // Filesystem recovery fixture; media probing is tested by the HTTP integration suite.
  const files=[];
  for(const [name,role,bytes] of [['video.mp4','video','diagnostic fixture'],['portrait.png','cover_portrait',Buffer.from([137,80,78,71,13,10,26,10])],['landscape.png','cover_landscape',Buffer.from([137,80,78,71,13,10,26,10])],['copy.txt','copy','标题：测试\n正文：测试内容\n话题：#测试']]){
    const file=path.join(run,name);await fs.writeFile(file,bytes);files.push({path:file,role});
  }
  const planFile=path.join(run,'plan.md');await fs.writeFile(planFile,'Approved storyboard');
  const candidate=await bindCandidate({status:'exported',projectId:'project',timelineId:'timeline',files},run,producer);
  report.artifact_sha256=candidate.files[0].sha256;
  const project={...initialStudio(),topic:'retry test',run,outputRoot,deliveryDate:'2026-11-04',narration:false,captions:false,qualityCycle:{candidate,report},approval:{planHash:'plan'}};
  const destination=path.join(outputRoot,'2026-11-04_retry test');
  let approvalCalls=0,copyFailed=false;
  const bridge=async(action,{file}={})=>{
    if(action==='inspect-media')return file.endsWith('portrait.png')?{width:300,height:400}:{width:400,height:300};
    if(action==='review-audit')return report;
    if(action==='verify-video')return {duration:3,width:1920,height:1080};
    if(action==='check-approval'){await onApproval(++approvalCalls,destination);return {file:planFile};}
    throw Error('Unexpected bridge action: '+action);
  };
  const context=vm.createContext({...fs,path,project,randomUUID,Buffer,contained,fileHash,brief,inputHash,validateDeliveryFiles,enforceIndependentReview,bridge,cleanEditor:()=>'',candidate,producer,addEvent:()=>{},copyFile:async(...args)=>{
    await fs.copyFile(...args);
    if(failCopy&&!copyFailed){copyFailed=true;throw Error('transient copy failure');}
  }});
  vm.runInContext(deliver,context);
  return {temp,run,outputRoot,destination,project,candidate,deliver:()=>vm.runInContext('deliver(candidate,producer)',context),close:()=>fs.rm(temp,{recursive:true,force:true})};
}

test('delivery retries after partial copies and approval errors without touching prior outputs',async()=>{
  for(const failure of ['copy','approval']){
    const f=await fixture({failCopy:failure==='copy',onApproval:async n=>{if(failure==='approval'&&n===1)throw Error('transient approval failure');}});
    try{
      await fs.mkdir(f.destination);await fs.writeFile(path.join(f.destination,'existing.txt'),'previous delivery');
      const stale=path.join(f.outputRoot,'.pending-producer');await fs.mkdir(stale);await fs.writeFile(path.join(stale,'keep.txt'),'old interrupted attempt');
      const before=(await fs.readdir(f.outputRoot)).sort();
      await assert.rejects(f.deliver,/transient/);
      assert.deepEqual((await fs.readdir(f.outputRoot)).sort(),before);assert.equal(f.project.deliveries.length,0);
      const delivery=await f.deliver();
      assert.equal(delivery.directory,f.destination+'（2）');assert.equal(f.project.deliveries.length,1);
      assert.equal(await fs.readFile(path.join(f.destination,'existing.txt'),'utf8'),'previous delivery');
      assert.equal(await fs.readFile(path.join(stale,'keep.txt'),'utf8'),'old interrupted attempt');
      for(const file of delivery.files){assert.equal(path.dirname(file.path),delivery.directory);assert.equal(await fileHash(file.path),file.sha256);}
      assert.deepEqual((await fs.readdir(f.outputRoot)).filter(n=>n.startsWith('.pending-')),['.pending-producer']);
    }finally{await f.close();}
  }
});

test('failure cleanup never recursively removes a populated delivery reservation',async()=>{
  const f=await fixture({onApproval:async(n,directory)=>{if(n===1){await fs.writeFile(path.join(directory,'keep.txt'),'external file');throw Error('transient approval failure');}}});
  try{
    await assert.rejects(f.deliver,/transient/);
    assert.equal(await fs.readFile(path.join(f.destination,'keep.txt'),'utf8'),'external file');
    assert.equal((await f.deliver()).directory,f.destination+'（2）');
    assert.equal(await fs.readFile(path.join(f.destination,'keep.txt'),'utf8'),'external file');
  }finally{await f.close();}
});
