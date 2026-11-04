import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileHash} from '../media.mjs';
import {preparePlanning,runPlanningAgent} from '../planning.mjs';
import {taskPrompt,initialStudio,updateSettings} from '../studio-workflow.mjs';
import {renderPlanningDraft} from '../public/planning-view.js';

async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'planning-recovery-'));
  await writeFile(path.join(root,'run.json'),'{}');await writeFile(path.join(root,'media.mp4'),'isolated fixture bytes');await writeFile(path.join(root,'evidence.json'),'{}');
  const source={id:'real-fixture',localPath:path.join(root,'media.mp4'),sha256:await fileHash(path.join(root,'media.mp4')),duration:10};
  const context={run:root,selectedSources:[source],brief:{style:null,topic:'fixture',requirements:{narration:true}},settings:{music:'none'},inputHash:'same-input',userFollowup:''};
  const values={analysis:{summary:'actual inspection',observations:[{sourceId:source.id,observations:'fixture frames',facts:['visible fact'],usableWindows:[{start:0,end:2,actionGroup:'one',description:'one action'}]}],referenceChecks:[],styleObservations:'no selected style',evidenceFiles:[{path:path.join(root,'evidence.json'),sha256:await fileHash(path.join(root,'evidence.json'))}],gaps:[],limitations:['audio not heard']},script:{title:'fixture',summary:'summary',script:'actual script',beats:[{id:'b1',narration:'actual script',purpose:'explain',sourceIds:[source.id]}],gaps:[],limitations:['audio not heard']},storyboard:{title:'fixture',script:'actual script',shots:[{id:'s1'}],limitations:['audio not heard']}};
  async function run({failAt,alterContext={},onCheckpoint}={}){
    const id=String(Math.random()),job={id,action:'plan',events:[],toolCalls:[],execution:{model:'unchanged',reasoningEffort:'xhigh'}},directory=path.join(root,id);await mkdir(directory);
    const c={...context,...alterContext,jobId:id,jobDirectory:directory},called=[],events=[];
    const outcome=await new Promise(resolve=>runPlanningAgent({job,context:c,codex:'fixture-only',event:(...e)=>events.push(e),onCheckpoint,onFinish:resolve,runAgent:options=>{
      const stage=options.context.planning.stage;called.push(stage);assert.equal(options.job.execution.reasoningEffort,'xhigh');
      queueMicrotask(()=>{if(stage===failAt){job.cancelRequested=true;job.stopReason='timeout';options.onFinish({code:1,error:'fixture timeout',finalText:''});}else options.onFinish({code:0,finalText:JSON.stringify(values[stage])});});
      return {cancel(){job.cancelRequested=true;}};
    }}));
    return {outcome,called,events,job,context:c};
  }
  return {root,context,values,run,dispose:()=>rm(root,{recursive:true,force:true})};
}

test('timeout after script keeps unapproved draft, fresh process resumes only storyboard',async()=>{
  const f=await fixture();try{
    const saved=[];const first=await f.run({failAt:'storyboard',onCheckpoint:async(stage,value)=>saved.push({stage,value})});
    assert.equal(first.outcome.code,1);assert.deepEqual(saved.map(x=>x.stage),['analysis','script']);assert.equal(saved[1].value.script,'actual script');
    assert.equal(first.job.stopReason,'timeout');
    const next=await f.run();assert.deepEqual(next.called,['storyboard']);assert.equal(next.outcome.code,0);
    assert.deepEqual(JSON.parse(next.outcome.finalText).limitations,['audio not heard']);
    const third=await f.run();assert.deepEqual(third.called,[]);assert.equal(third.outcome.code,0);
  }finally{await f.dispose();}
});
test('changed brief, source hash, style or explicit regeneration cannot reuse stale checkpoints',async()=>{
  const f=await fixture();try{
    await f.run();
    for(const alterContext of [{brief:{...f.context.brief,topic:'changed'}},{settings:{music:'instrumental'}},{userFollowup:'change ending'},{planGeneration:'new-explicit-generation'}])assert.deepEqual((await f.run({alterContext})).called,['analysis','script','storyboard']);
    await writeFile(f.context.selectedSources[0].localPath,'changed');
    const invalid=await f.run();assert.equal(invalid.outcome.code,1);assert.deepEqual(invalid.called,[]);assert.match(invalid.outcome.error,/素材发生变化/);
    f.context.selectedSources[0].sha256=await fileHash(f.context.selectedSources[0].localPath);
    assert.deepEqual((await f.run()).called,['analysis','script','storyboard']);
    const before=(await preparePlanning(f.context)).fingerprint;
    await mkdir(path.join(f.root,'style'));await writeFile(path.join(f.root,'style/SKILL.md'),'style-one');await writeFile(path.join(f.root,'style/style.json'),JSON.stringify({references:[{id:'r'}]}));
    const snapshot={selector:'style@1',skill_path:path.join(f.root,'style/SKILL.md'),files:{'SKILL.md':await fileHash(path.join(f.root,'style/SKILL.md')),'style.json':await fileHash(path.join(f.root,'style/style.json'))}};
    await writeFile(path.join(f.root,'run.json'),JSON.stringify({style_snapshot:snapshot}));
    assert.notEqual((await preparePlanning(f.context)).fingerprint,before);
    await writeFile(snapshot.skill_path,'changed outside versioning');await assert.rejects(preparePlanning(f.context),/风格快照已变化/);
  }finally{await f.dispose();}
});
test('corrupt or changed analysis evidence invalidates all subsequent stages',async()=>{
  const f=await fixture();try{
    const first=await f.run();const directory=first.context.planningState.directory;
    await writeFile(path.join(directory,'script.json'),'{partial');
    assert.deepEqual((await f.run()).called,['script','storyboard']);
    await writeFile(path.join(f.root,'evidence.json'),'changed evidence');
    f.values.analysis.evidenceFiles[0].sha256=await fileHash(path.join(f.root,'evidence.json'));
    assert.deepEqual((await f.run()).called,['analysis','script','storyboard']);
    const record=JSON.parse(await readFile(path.join(directory,'analysis.json'),'utf8'));record.result.summary='tampered';await writeFile(path.join(directory,'analysis.json'),JSON.stringify(record));
    assert.deepEqual((await f.run()).called,['analysis','script','storyboard']);
  }finally{await f.dispose();}
});
test('cancel between stages never launches later work, saved stage remains resumable',async()=>{
  const f=await fixture();try{
    const job={id:'cancel',action:'plan'},jobDirectory=path.join(f.root,'cancel');await mkdir(jobDirectory);let controller,calls=0;
    const result=await new Promise(resolve=>{controller=runPlanningAgent({job,context:{...f.context,jobId:'cancel',jobDirectory},event(){},onFinish:resolve,onCheckpoint:async()=>controller.cancel(),runAgent:({onFinish})=>{calls++;queueMicrotask(()=>onFinish({code:0,finalText:JSON.stringify(f.values.analysis)}));return {cancel(){}};}});});
    assert.equal(result.code,1);assert.equal(calls,1);assert.equal(job.stopReason,'user');
    assert.deepEqual((await f.run()).called,['script','storyboard']);
  }finally{await f.dispose();}
});
test('draft is escaped, cannot approve; final stage retains every style and common requirement',()=>{
  const escape=s=>s.replaceAll('<','&lt;').replaceAll('>','&gt;');
  const html=renderPlanningDraft({title:'<img>',script:'</textarea><script>bad</script>',summary:'draft',gaps:['need evidence']},escape);
  assert.ok(!html.includes('<script>'));assert.match(html,/readonly/);assert.doesNotMatch(html,/approve-plan|save-plan/);
  const p=initialStudio();p.planDraft={script:'stale'};updateSettings(p,{selected:[],topic:'new topic'});assert.equal(p.planDraft,null);
  const prompt=taskPrompt('plan',{planning:{stage:'storyboard'}});assert.match(prompt,/EVERY snapshot rule/);assert.match(prompt,/duration tolerance/);assert.match(prompt,/sourceUses/);assert.match(prompt,/validate-plan/);
  const script=taskPrompt('plan',{planning:{stage:'script'}});assert.match(script,/complete script/);assert.doesNotMatch(script,/Return stylePlan/);
});
