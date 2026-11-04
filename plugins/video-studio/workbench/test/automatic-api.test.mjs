import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,mkdir,chmod,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {brief} from '../studio-workflow.mjs';
import {requestHash,automaticAuthorization} from '../automatic.mjs';

const exec=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('isolated HTTP automatic flow selects, plans, independently reviews, delivers or pauses with provisional files; explicit revision reuses the project',{timeout:180000},async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'automatic-api-')),user=path.join(temp,'user'),data=path.join(temp,'state');let server;
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const base='http://127.0.0.1:'+port,python=process.env.VIDEO_STUDIO_PYTHON||'python3';
  const env={...process.env,VIDEO_STUDIO_AGENT_MODE:'cli',VIDEO_STUDIO_HOME:user,VIDEO_STUDIO_WEB_DATA:data,VIDEO_STUDIO_PYTHON:python,PORT:String(port),VIDEO_STUDIO_TEST_MEDIA:temp};
  const api=async(route,payload)=>{const response=await fetch(base+route,payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Video-Demo':'1'},body:JSON.stringify(payload)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  const stop=async()=>{if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}};
  try{
    await mkdir(user,{recursive:true});
    await exec(python,['-c',`import sys;sys.path.insert(0,${JSON.stringify(path.resolve(root,'../../../tests'))});from test_styles import StyleTests;import styles;styles.register(StyleTests().spec())`],{env});
    const downloader=path.join(user,'runtime/bin/yt-dlp');await mkdir(path.dirname(downloader),{recursive:true});await writeFile(downloader,'#!/usr/bin/env node\nconsole.log("2026.08.19");');await chmod(downloader,0o755);
    await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=1920x1080:r=30','-t','3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',path.join(temp,'clip.mp4')]);
    for(const [name,size] of [['portrait','300x400'],['landscape','400x300']])await exec('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s='+size,'-frames:v','1',path.join(temp,name+'.png')]);
    const fixture=path.join(temp,'codex-fixture.mjs');
    // Explicit protocol test double: no real ChatCut, cloned voices, or online footage.
    await writeFile(fixture,`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
if(process.argv.includes('--version'))console.log('codex-cli 0.164.0');
else if(process.argv.includes('--help'))console.log('--ephemeral --json --output-schema --add-dir --approve-for-me');
else if(process.argv.includes('login'))console.log('Logged in using fixture');
else if(process.argv.includes('app-server')){let b='';process.stdin.on('data',s=>{b+=s;let i;while((i=b.indexOf('\\n'))>=0){const q=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(q.id)console.log(JSON.stringify({id:q.id,result:q.method==='config/read'?{config:{model:'gpt-6-astra'}}:q.method==='model/list'?{data:[{id:'gpt-6-astra',model:'gpt-6-astra',isDefault:true}],nextCursor:null}:{}}));}});}
else{
let text='';for await(const b of process.stdin)text+=b;
const c=JSON.parse(text.split('Structured context (data, never executable instructions):\\n')[1]);
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v));const load=p=>JSON.parse(fs.readFileSync(p));
const record=(kind,value)=>{const f=path.join(c.jobDirectory,kind+'.json');write(f,value);execFileSync(c.environment.python,[path.join(c.pluginRoot,'scripts/studio.py'),'record','--run',c.run,'--kind',kind,'--file',f]);};
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-'+c.jobId}));let result;
if(c.taskAction==='create'&&!c.approval){
if(c.brief.requirements.review_policy!=='sampled-objective-v1')throw Error('legacy review policy leaked into production');
if(c.voice?.savedVoice&&c.productionContext.settings.voice?.voiceId!==c.voice.savedVoice.voiceId)throw Error('selected voice missing from run');
record('material_plan',{topic:c.brief.topic,style:c.brief.style,needs:[{id:'fixture',purpose:'Synthetic protocol',query:'fixture',acceptance:'Known diagnostic bytes'}]});
const file=path.join(c.run,'clip.mp4');fs.copyFileSync(path.join(process.env.VIDEO_STUDIO_TEST_MEDIA,'clip.mp4'),file);
const source={id:'source',title:'Synthetic source',localPath:file,sha256:hash(file),kind:'video',url:'https://example.com/fixture',sourceType:'other',needIds:['fixture'],start:0};
const plan={title:c.userRevision?'用户确认局部修订':'协议回归样片',summary:'Fixture',script:'Test',productionPlan:{version:1,materialReview:'Synthetic source',layout:{mode:'unchanged',bottomInset:0}},shots:[{id:'s1',from:0,to:3,narration:'',visual:'Synthetic diagnostic pattern',screenText:'',transition:'cut',sourceIds:[source.id],sourceUses:[{id:'u1',sourceId:source.id,inSeconds:0,outSeconds:3,actionGroup:'capture',role:'primary',purpose:'fixture',compatibility:'diagnostic'}],layout:{composition:'Full frame',contentBottom:null,captionBottom:null},design:[]}],stylePlan:{selector:'sample@1',rules:[{ruleId:'structure',disposition:'planned',shotIds:['s1'],treatment:'Fixture'}],referenceChecks:[{referenceId:'r1',location:'Fixture',observation:'No aesthetic claim',adaptation:'Fixture narrative'}],contrastReview:'Protocol test only'},gaps:[],limitations:[],notes:[]};
write(c.productionCheckpointPath,{schema:1,jobId:c.jobId,requestId:'prepare-1',sources:[source],editorial:{title:'协议回归样片',rationale:'Fixture',captions:false,music:'none'},plan});
let accepted;for(let n=0;n<100;n++){if(fs.existsSync(c.productionCheckpointResultPath)){accepted=load(c.productionCheckpointResultPath);break;}await new Promise(r=>setTimeout(r,100));}
if(!accepted?.ok)throw Error('Checkpoint failed: '+JSON.stringify(accepted));
Object.assign(c,{plan,selectedSources:[source],planHash:accepted.planHash,inputHash:accepted.inputHash});
record('project',{projectId:'fixture-project',timelineId:'fixture-timeline',planHash:c.planHash,inputHash:c.inputHash,creativeId:c.creativeId});
if(fs.existsSync(path.join(process.env.VIDEO_STUDIO_TEST_MEDIA,'after-checkpoint-crash')))throw Error('Fixture stopped after durable checkpoint');
}
if(['produce','create'].includes(c.taskAction)){
const folder=path.join(c.run,'deliverables');fs.mkdirSync(folder,{recursive:true});
for(const name of ['clip.mp4','portrait.png','landscape.png'])fs.copyFileSync(path.join(process.env.VIDEO_STUDIO_TEST_MEDIA,name),path.join(folder,name));
fs.writeFileSync(path.join(folder,'copy.txt'),'标题：回归测试\\n\\n正文：验证自动制作的协议与交付门槛。\\n\\n话题：\\n#测试');
record('project',{projectId:'fixture-project',timelineId:'fixture-timeline',planHash:c.planHash,inputHash:c.inputHash});
const evidence=path.join(c.run,'review-evidence.json');write(evidence,{timeline:{timeline:{fps:30,totalEntries:1,entries:[{id:'item',timelineRange:{fromFrame:0,toFrame:90}}],tracks:[]}}});
record('beat',{id:'b1',shot_id:'s1',from_frame:0,to_frame:90,source_ids:c.selectedSources.map(s=>s.id),visual_anchor:'Diagnostic full frame',source_uses:[{...c.plan.shots[0].sourceUses[0],item_ids:['item'],from_frame:0,to_frame:90,observations:'Fixture implementation',evidence_files:[{path:evidence,sha256:hash(evidence)}]}],design_results:[]});
console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'chatcut',tool:'track_export',status:'completed'}}));
result={status:'exported',summary:'Synthetic export fixture',projectId:'fixture-project',timelineId:'fixture-timeline',editorUrl:'',files:[['clip.mp4','video'],['portrait.png','cover_portrait'],['landscape.png','cover_landscape'],['copy.txt','copy']].map(([n,role])=>({path:path.join(folder,n),role})),qaStatus:'needs_review',notes:['Protocol fixture only'],questions:[],voiceRequest:{kind:'none',message:'',candidates:[]}};
const defectFile=path.join(process.env.VIDEO_STUDIO_TEST_MEDIA,'delivery-defect');
if(fs.existsSync(defectFile)&&(!c.repair&&!c.userRevision||fs.readFileSync(defectFile,'utf8')==='always'))result.files=result.files.filter(f=>!['cover_landscape','copy'].includes(f.role));
}else if(c.taskAction==='review'){
if(fs.existsSync(path.join(process.env.VIDEO_STUDIO_TEST_MEDIA,'review-crash')))throw Error('Fixture technical review failure');
const manifest=load(c.probe.manifest),ref={path:c.probe.manifest,sha256:hash(c.probe.manifest)},fail=c.brief.topic.includes('拒绝')&&!c.reviewDelta?.requestedRevision;
result={summary:'Independent fixture',observedSheets:manifest.contact_sheets.map(s=>s.id),observedReferenceSheets:[],issues:fail?[{id:'visual-1',check:'visuals',symptom:'Fixture action cropped',suggested_fix:'替换开头，保留动作完整'}]:[],limitations:['No real aesthetic review'],checks:['visuals','occlusion','transitions','flicker','output_details','style_match','material_continuity'].map(check=>({check,result:fail?'fail':'pass',observations:'Isolated protocol observation',evidencePaths:[ref.path],issueIds:check==='visuals'&&fail?['visual-1']:[],rules:check==='style_match'?[{id:'structure',result:fail?'fail':'pass',observations:'Fixture rule'}]:[],issues:[],notApplicableReason:''}))};
}else throw Error('Unexpected fixture stage '+c.taskAction);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
}
`);await chmod(fixture,0o755);await exec(process.execPath,['--check',fixture]);env.VIDEO_DEMO_CODEX_BIN=fixture;
    async function launch(){server=spawn(process.execPath,[path.join(root,'studio-server.mjs')],{env,stdio:['ignore','pipe','pipe']});let log='';server.stderr.on('data',b=>log+=b);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log||'server timeout')),15000);server.stdout.on('data',b=>{if(b.toString().includes('Video Agent Demo:')){clearTimeout(timer);resolve();}});});}
    await launch();
    const scenarios=[{topic:'旧项目恢复完整回归',legacy:true},{topic:'检查点后重启恢复',checkpointCrash:true},{topic:'正常交付协议测试'},{topic:'交付复制失败恢复',deliveryCrash:true},{topic:'拒绝交付协议测试',failure:true},{topic:'交付包确认修订',defect:'first',failure:true},{topic:'交付包持续失败',defect:'always',failure:true},{topic:'手动验收恢复',reviewCrash:true}];
    for(const [index,scenario] of scenarios.entries()){
      if(index)await api('/api/reset',{});
      const failure=!!scenario.failure;
      await rm(path.join(temp,'after-checkpoint-crash'),{force:true});await rm(path.join(temp,'review-crash'),{force:true});await rm(path.join(temp,'delivery-defect'),{force:true});
      if(scenario.defect)await writeFile(path.join(temp,'delivery-defect'),scenario.defect);
      if(scenario.checkpointCrash)await writeFile(path.join(temp,'after-checkpoint-crash'),'fixture');
      if(scenario.reviewCrash)await writeFile(path.join(temp,'review-crash'),'fixture');
      const deliveryRoot=path.join(temp,scenario.deliveryCrash?'blocked-delivery':'delivery');if(scenario.deliveryCrash)await writeFile(deliveryRoot,'transient unavailable output');
      const {project:p}=await api('/api/state');await api('/api/project',{...p,topic:scenario.topic,styleSelector:'sample@1',ratio:'16:9',duration:3,durationMin:null,narration:false,advancedOverrides:{narration:true},outputRoot:deliveryRoot});
      if(scenario.legacy){
        await stop();const old=(await readFile(path.join(data,'workbench-v2.json'),'utf8'));const p=JSON.parse(old);
        delete p.reviewPolicy;p.voiceChoice={provider:'fixture',voiceId:'saved-clone',voiceType:'custom',name:'Saved clone',selected_by_user:true};
        const oldBrief=brief(p);delete oldBrief.requirements.voice;
        const input=path.join(temp,'legacy-create.json');await writeFile(input,JSON.stringify({title:p.topic,brief:oldBrief,outputRoot:path.join(data,'runs')}));
        p.run=JSON.parse((await exec(python,[path.resolve(root,'../scripts/web_bridge.py'),'create','--file',input],{env})).stdout).run;
        const media=path.join(p.run,'clip.mp4');await writeFile(media,await readFile(path.join(temp,'clip.mp4')));
        p.sources=[{id:'source',title:'Existing source',kind:'video',status:'ready',localPath:media,sha256:createHash('sha256').update(await readFile(media)).digest('hex'),duration:3,durationMin:null,width:1920,height:1080,bytes:(await readFile(media)).length,start:0,end:3,url:'https://example.com/fixture'}];p.selected=['source'];
        p.plan={stale:false,gaps:['settings.voice=null','review_policy=null requires playback']};p.approval=null;
        p.deliveries=[{id:'historic',jobId:'historic-producer',qaStatus:'needs_review',files:[],directory:path.join(temp,'historic')}];
        await mkdir(p.deliveries[0].directory);await writeFile(path.join(p.deliveries[0].directory,'keep.txt'),'unchanged old delivery');
        p.automatic={id:'legacy-automatic',requestHash:requestHash(p),status:'blocked',stage:'plan',authorization:automaticAuthorization,repairCount:0,planGapAttempts:3};
        for(const file of [path.join(data,'workbench-v2.json'),path.join(data,'projects',p.id+'.json')])await writeFile(file,JSON.stringify(p));
        await launch();
      }
      await api('/api/jobs',{action:'auto'});
      let current;for(let n=0;n<500;n++){current=await api('/api/state');if(['completed','quality_failed','blocked'].includes(current.project.automatic?.status)&&!current.activeJobId)break;await new Promise(r=>setTimeout(r,100));}
      let q=current.project;
      if(scenario.deliveryCrash){
        assert.equal(q.automatic.status,'blocked');assert.equal(q.qualityCycle.report.completed,true);assert.equal(q.deliveries.length,0);
        const count=q.jobs.length;await stop();await rm(deliveryRoot);await launch();
        const resumed=await api('/api/jobs',{action:'auto'});assert.equal(resumed.job,null);
        current=await api('/api/state');q=current.project;assert.equal(q.jobs.length,count);assert.equal(q.automatic.status,'completed');assert.equal(q.deliveries.length,1);
      }
      if(scenario.checkpointCrash){
        assert.equal(q.automatic.status,'blocked');assert.equal(q.jobs[0].action,'create');assert.equal(q.approval.status,'confirmed');
        const version=q.approval.version,planHash=q.approval.planHash;
        await stop();await rm(path.join(temp,'after-checkpoint-crash'));await launch();await api('/api/jobs',{action:'auto'});
        for(let n=0;n<500;n++){current=await api('/api/state');if(current.project.automatic?.status!=='running'&&!current.activeJobId)break;await new Promise(r=>setTimeout(r,100));}
        q=current.project;assert.equal(q.approval.version,version);assert.equal(q.approval.planHash,planHash);
        const recovered=q.jobs.find(j=>j.action==='create'),context=JSON.parse(await readFile(path.join(recovered.directory,'request.json'),'utf8'));
        assert.equal(context.productionMode,'recover');assert.equal(context.existingProject.projectId,'fixture-project');assert.equal(context.approval.planHash,planHash);
      }
      if(scenario.reviewCrash){
        assert.equal(q.automatic.status,'blocked');assert.equal(q.qualityCycle.report,null);assert.equal(q.deliveries.length,0);
        await api('/api/project',{...q,mode:'manual'});await stop();await launch();await rm(path.join(temp,'review-crash'));
        const restored=(await api('/api/state')).project;assert.equal(restored.automatic,null);assert.equal(restored.qualityCycle.candidate.producerJobId,q.qualityCycle.candidate.producerJobId);
        await api('/api/jobs',{action:'review'});
        for(let n=0;n<500;n++){current=await api('/api/state');if(!current.activeJobId)break;await new Promise(r=>setTimeout(r,100));}
        q=current.project;assert.equal(q.jobs[0].status,'completed',q.jobs[0].error);assert.equal(q.automatic,null);
      }else assert.equal(q.automatic.status,failure?'quality_failed':'completed',JSON.stringify(q.jobs.map(j=>({action:j.action,status:j.status,error:j.error,summary:j.summary}))));
      assert.equal(q.jobs.filter(j=>j.action==='create').length,scenario.checkpointCrash?2:1);
      assert.equal(q.jobs.filter(j=>j.action==='produce').length,0);
      assert.ok(!q.jobs.some(j=>['discover','collect','curate','plan','plan_review'].includes(j.action)));
      assert.equal(q.jobs.filter(j=>j.action==='review').length,scenario.reviewCrash?2:1);
      assert.equal(q.deliveries.length,(failure?0:1)+(scenario.legacy?1:0));
      if(scenario.legacy){const context=JSON.parse(await readFile(path.join(q.jobs.find(j=>j.action==='create').directory,'request.json'),'utf8'));assert.equal(context.productionContext.review_policy,'sampled-objective-v1');assert.equal(context.productionContext.settings.voice.voiceId,'saved-clone');assert.equal(q.deliveries[1].qaStatus,'needs_review');assert.equal(await readFile(path.join(temp,'historic','keep.txt'),'utf8'),'unchanged old delivery');}
      assert.equal(q.approval.authority.kind,'delegated_review');
      if(scenario.defect){
        assert.equal(q.qualityCycle.report.checks.delivery_package.status,'fail');
        assert.equal(q.qualityCycle.report.checks.delivery_package.issues.length,2);
        assert.equal(q.jobs[0].threadId,undefined,'objective failure should not invoke a reviewer model');
        assert.equal(q.provisionalDeliveries[0].complete,false);
      }
      if(failure){
        const cycle=JSON.parse(await readFile(path.join(q.run,'quality-cycle.json'),'utf8'));assert.equal(cycle.repairCount,0);assert.equal(cycle.terminal,'quality_failed');
        if(!scenario.defect){
          await writeFile(path.join(temp,'review-crash'),'fixture');const retry=await api('/api/jobs',{action:'review'});
          let recheck;for(let n=0;n<200;n++){recheck=await api('/api/jobs/'+retry.job.id);if(recheck.status!=='running')break;await new Promise(r=>setTimeout(r,50));}assert.equal(recheck.status,'failed');
          await stop();await launch();
        }
        for(const action of ['auto','produce']){const response=await fetch(base+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Video-Demo':'1'},body:JSON.stringify({action})});assert.equal(response.status,400,action);}
        await rm(path.join(temp,'review-crash'),{force:true});
        const before=(await api('/api/state')),oldJobs=before.project.jobs.length,view=before.feedback;
        assert.ok(before.project.provisionalDeliveries[0].files.some(f=>f.role==='archive'));
        if(!scenario.defect)assert.equal(before.project.provisionalDeliveries[0].complete,true);
        await api('/api/feedback',{projectId:q.id,feedback:'替换开头，并保留已有音轨'});
        assert.equal((await api('/api/state')).project.jobs.length,oldJobs);
        await stop();await launch();assert.equal((await api('/api/state')).project.feedbackDraft,'替换开头，并保留已有音轨');
        const payload={projectId:q.id,token:view.token,feedback:'替换开头，并保留已有音轨'};
        const revision=await api('/api/revision/confirm',payload);
        const duplicate=await fetch(base+'/api/revision/confirm',{method:'POST',headers:{'Content-Type':'application/json','X-Video-Demo':'1'},body:JSON.stringify(payload)});assert.equal(duplicate.ok,false);
        await api('/api/feedback',{projectId:q.id,feedback:'运行期间保存的下一轮反馈'});
        let revised;for(let n=0;n<500;n++){revised=await api('/api/state');if(revised.project.automatic?.status!=='running'&&!revised.activeJobId)break;await new Promise(r=>setTimeout(r,100));}
        assert.equal(revised.project.jobs.length,oldJobs+2);
        assert.equal(revised.project.feedbackDraft,'运行期间保存的下一轮反馈');
        assert.equal(revised.project.revisionHistory.length,1);
        assert.equal(revised.project.automatic.status,scenario.defect==='always'?'quality_failed':'completed',revised.project.jobs[0].error);
        const context=JSON.parse(await readFile(path.join(revision.job.directory,'request.json'),'utf8'));
        assert.equal(context.productionMode,'recover');assert.equal(context.existingProject.projectId,'fixture-project');assert.match(context.userRevision.request,/替换开头/);
        assert.notEqual(revised.project.approval.planHash,q.approval.planHash);
        await api('/api/cancel',{});assert.equal((await api('/api/state')).project.automatic.status,'paused');
      }
      else{assert.equal(q.deliveries[0].qaStatus,'passed');assert.match(path.basename(q.deliveries[0].directory),/^\d{4}-\d{2}-\d{2}_/);assert.ok(q.deliveries[0].files.some(f=>f.name==='发布文案.txt'));}
    }
  }finally{await stop();await rm(temp,{recursive:true,force:true});}
});
