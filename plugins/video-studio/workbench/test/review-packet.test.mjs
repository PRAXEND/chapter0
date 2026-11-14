import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {prepareReviewPacket} from '../review-packet.mjs';
import {fileHash} from '../media.mjs';

async function fixture(){
  const run=await realpath(await mkdtemp(path.join(os.tmpdir(),'review-packet-'))),files=[];
  for(const [name,role,content] of [['v.mp4','video','synthetic protocol bytes'],['p.png','cover_portrait',Buffer.from([137,80,78,71,13,10,26,10])],['h.png','cover_landscape',Buffer.from([137,80,78,71,13,10,26,10])],['copy.txt','copy','标题：测试\n正文：实际内容\n话题：#测试'],['s.srt','subtitles','synthetic subtitles']]){
    const file=path.join(run,name);await writeFile(file,content);files.push({path:file,role,sha256:await fileHash(file)});
  }
  const probe={manifest:path.join(run,'manifest.json'),metrics:path.join(run,'metrics.json'),artifact_sha256:files[0].sha256};
  const metrics={full_decode:true,audio:{hard_failures:[]},sync:{status:'checked',report:{caption_sync:{coverage_complete:true,outside_frame_tolerance:[]},source_window_issues:[],export_matches_cards:{matches:true}}}};
  await writeFile(probe.manifest,JSON.stringify({timeline_complete:true,contact_sheets:[{id:'sheet-1'}]}));
  await writeFile(probe.metrics,JSON.stringify(metrics));
  const context={run,jobDirectory:run,probe,candidate:{files,qaStatus:'needs_review'},brief:{requirements:{captions:true,narration:false}}};
  const inspect=async file=>file.endsWith('p.png')?{width:300,height:400}:{width:400,height:300};
  return {run,probe,context,metrics,inspect};
}
test('preflight preserves caption tolerances, actual text matching and known failure gates',async()=>{
  const f=await fixture();try{
    assert.equal((await prepareReviewPacket(f.context,f.inspect)).report,null);
    for(const mutation of [m=>m.sync.report.caption_sync.outside_frame_tolerance=[7],m=>m.sync.report.caption_sync.coverage_complete=false,m=>m.audio.hard_failures=['true_peak_exceeded']]){
      const m=structuredClone(f.metrics);mutation(m);await writeFile(f.probe.metrics,JSON.stringify(m));
      assert.equal((await prepareReviewPacket(f.context,f.inspect)).report.completed,false);
    }
    await writeFile(f.probe.metrics,JSON.stringify(f.metrics));f.context.candidate.qaStatus='failed';
    assert.ok((await prepareReviewPacket(f.context,f.inspect)).report.checks.producer_unresolved);
  }finally{await rm(f.run,{recursive:true,force:true});}
});
test('known defects stop before the independent model and return a durable repair report',async()=>{
  const f=await fixture();try{
    f.context.candidate.qaStatus='failed';let called=0,resolve;const done=new Promise(r=>resolve=r);
    const source=await readFile(new URL('../studio-server.mjs',import.meta.url),'utf8');
    const fn=source.slice(source.indexOf('function runReviewAgent('),source.indexOf('\nfunction runRepositoryCollection('));
    const options={job:{id:'review'},context:f.context,onFinish:resolve};
    const sandbox=vm.createContext({options,path,prepareReviewPacket,addEvent:()=>{},runAgent:()=>called++,bridge:async(action,p)=>action==='prepare-review'?f.probe:f.inspect(p.file)});
    vm.runInContext(fn,sandbox);vm.runInContext('runReviewAgent(options)',sandbox);await done;
    assert.equal(called,0);assert.equal(f.context.preflightReport.completed,false);assert.ok(f.context.preflightReport.preflight);
    assert.match(await readFile(path.join(f.run,'review-packet.json'),'utf8'),/producer_unresolved/);
  }finally{await rm(f.run,{recursive:true,force:true});}
});


test('review packet includes the approved title and both hashed cover images',async()=>{
  const f=await fixture();try{
    f.context.plan={productionPlan:{coverTitle:'One title',layout:{mode:'portrait-centered',version:2}}};
    const {packet}=await prepareReviewPacket(f.context,f.inspect);
    assert.equal(packet.titleRequirement.coverTitle,'One title');assert.equal(packet.titleRequirement.files.length,3);
    for(const cover of packet.titleRequirement.files.filter(f=>f.role!=='video'))assert.ok(packet.evidence.some(e=>e.path===cover.path&&e.sha256===cover.sha256));
    assert.match(packet.instructions,/BOTH cover PNGs/);assert.match(packet.instructions,/titleObservations/);
  }finally{await rm(f.run,{recursive:true,force:true});}
});


test('v3 review packet binds actual emphasis and every presentation feature',async()=>{
  const f=await fixture();try{
    const layout={mode:'portrait-centered',version:3,ending:{fadeSeconds:1.2,blackHoldSeconds:.6}};
    f.context.plan={productionPlan:{coverTitle:'One title',titleEmphasis:'title',layout}};
    const {packet}=await prepareReviewPacket(f.context,f.inspect);
    assert.equal(packet.titleRequirement.titleEmphasis,'title');
    assert.deepEqual(packet.presentationRequirement,layout);
    assert.match(packet.instructions,/presentationObservations/);assert.match(packet.instructions,/emphasisText/);
  }finally{await rm(f.run,{recursive:true,force:true});}
});
