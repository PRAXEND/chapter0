import {execFileSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initialStudio,brief,validatePlan,validateSettings,inputHash,updateSettings,taskPrompt,schemas} from '../studio-workflow.mjs';
import {productionLayout,validateProductionPlan,renderProductionPlan,renderSourceUses,readSourceUses} from '../public/production-plan.js';

function placement(settings){
  const p=productionLayout(settings);
  return p.mode==='unchanged'?{composition:'Original composition'}:{composition:'Centered contain footage; fixed below-frame captions',mediaBox:{...p.mediaBox},captionBox:settings.captions?{...p.captionBox}:null,captionStyle:settings.captions?{...p.captionStyle}:null,fit:'contain',titleText:'Test',titleBox:{...p.titleBox},emphasisBoxes:[]};
}

function fixture(ratio='9:16',captions=true){
  const project={...initialStudio(),duration:30,durationMin:null,topic:'Test',ratio,captions,selected:['a'],sources:[{id:'a',kind:'video',title:'Capture A',duration:10,sha256:'a'.repeat(64),url:'https://example.org/a',start:100,status:'ready'}]};
  const plan={title:'Test',script:'Test',stylePlan:null,gaps:[],productionPlan:{version:1,coverTitle:'Test',materialReview:'Synthetic observations',layout:productionLayout(brief(project).requirements)},shots:[{id:'s1',from:0,to:2,sourceIds:['a'],sourceUses:[{id:'u1',sourceId:'a',inSeconds:1,outSeconds:3,actionGroup:'capture-a-01',role:'primary',purpose:'Specific action',compatibility:'No conflicting claims'}],layout:placement(brief(project).requirements),narration:'Test',visual:'Test',screenText:'Test',transition:'Cut',design:[]}]};
  return {project,plan};
}

test('common contract is mandatory without a style and preserved in normalization',()=>{
  const {project,plan}=fixture();
  assert.deepEqual(validatePlan(plan,project).productionPlan,plan.productionPlan);
  assert.ok(schemas.plan.required.includes('productionPlan'));
  assert.ok(schemas.plan.properties.shots.items.required.includes('sourceUses'));
  const incomplete=structuredClone(plan);delete incomplete.productionPlan;
  assert.throws(()=>validatePlan(incomplete,project),/通用/);
  delete project.workflowVersion;delete incomplete.shots[0].sourceUses;delete incomplete.shots[0].layout;
  assert.doesNotThrow(()=>validatePlan(incomplete,project)); // old approved records can recover
});

test('portrait regions center media, separate fixed captions and render a cover-matched title',()=>{
  assert.deepEqual(productionLayout({width:null,height:1920}),{mode:'unchanged'});
  for(const [width,height] of [[1080,1920],[720,1280],[900,1200]]){
    const {project,plan}=fixture(),settings={...brief(project).requirements,width,height};
    plan.productionPlan.layout=productionLayout(settings);plan.shots[0].layout=placement(settings);
    validateProductionPlan(plan,settings,project.sources);
    const p=plan.productionPlan.layout;
    assert.equal((p.mediaBox.left+p.mediaBox.right)/2,.5);assert.equal((p.mediaBox.top+p.mediaBox.bottom)/2,.5);
    assert.ok(p.titleBox.bottom<p.mediaBox.top);assert.ok(p.captionBox.top>p.mediaBox.bottom);assert.ok(p.captionBox.bottom>.82);
    for(const change of [{mediaBox:{...p.mediaBox,top:.2}},{captionBox:{...p.captionBox,top:.6}},{titleText:'Different'},{fit:'cover'},{captionStyle:{...p.captionStyle,color:'#FFFF00'}}]){
      const bad=structuredClone(plan);Object.assign(bad.shots[0].layout,change);assert.throws(()=>validateProductionPlan(bad,settings,project.sources));
    }
  }
  for(const ratio of ['16:9','1:1']){const f=fixture(ratio);validatePlan(f.plan,f.project);assert.deepEqual(f.plan.productionPlan.layout,{mode:'unchanged'});}
  const silent=fixture('9:16',false);validatePlan(silent.plan,silent.project);
});

test('caption length cannot move its container and emphasis cannot use black padding',()=>{
  const {project,plan}=fixture(),shot=plan.shots[0];
  const e={footageBounds:{left:.3,top:.32,right:.7,bottom:.68},bounds:{left:.4,top:.4,right:.6,bottom:.5}};
  shot.layout.emphasisBoxes=[e];validatePlan(plan,project);
  shot.narration='A longer sentence with two caption lines';validatePlan(plan,project);
  shot.layout.captionBox.top+=.01;assert.throws(()=>validatePlan(plan,project),/固定/);shot.layout.captionBox.top-=.01;
  e.bounds.left=.1;assert.throws(()=>validatePlan(plan,project),/花字/);
});

test('removed inset has no effect; ratio changes revoke approval and old plans cannot be reused',()=>{
  const {project,plan}=fixture();project.plan=plan;project.approval={status:'confirmed'};
  const old=inputHash(project);
  for(const value of [.5,null,'',true]){
    const settings=validateSettings({...project,portraitBottomInset:value});assert.equal(settings.portraitBottomInset,undefined);
    updateSettings(project,settings);assert.equal(inputHash(project),old);
  }
  const settings=validateSettings({...project,ratio:'16:9'});updateSettings(project,settings);
  assert.notEqual(inputHash(project),old);assert.equal(project.approval,null);assert.throws(()=>validatePlan(plan,project),/布局/);
  const f=fixture();f.plan.productionPlan.layout={mode:'portrait-safe',bottomInset:.18};assert.throws(()=>validatePlan(f.plan,f.project),/旧竖版/);
  assert.throws(()=>validateSettings({...project,replayAuthorization:''}));
});

test('replay detection covers source loops, repost groups, hashes and original URL offsets',()=>{
  for(const mode of ['overlap','loop','hash','file','url','repost']){
    const {project,plan}=fixture(),original=plan.shots[0].sourceUses[0],second={...original,id:'u2',actionGroup:'distinct'};
    if(['hash','file','url','repost'].includes(mode)){
      const source={...project.sources[0],id:'b',sha256:'b'.repeat(64),url:'https://example.org/b'};
      if(mode==='hash')source.sha256=project.sources[0].sha256;
      if(mode==='file'){source.localPath='/tmp/same.mp4';project.sources[0].localPath=source.localPath;}
      if(mode==='url'){source.url=project.sources[0].url;source.start=101;second.inSeconds=0;second.outSeconds=2;}
      if(mode==='repost')second.actionGroup=original.actionGroup;
      project.sources.push(source);project.selected.push('b');plan.shots[0].sourceIds.push('b');second.sourceId='b';
    }
    if(mode==='loop')Object.assign(second,{inSeconds:6,outSeconds:8,actionGroup:original.actionGroup});
    plan.shots[0].sourceUses.push(second);
    assert.throws(()=>validatePlan(plan,project),/重复动作/,mode);
  }
});

test('distinct robots, sequential action segments and approved replay remain possible',()=>{
  const {project,plan}=fixture(),shot=plan.shots[0],first=shot.sourceUses[0];
  shot.sourceUses.push({...first,id:'u2',inSeconds:3,outSeconds:5,actionGroup:'next-subsegment'});
  project.sources.push({...project.sources[0],id:'b',url:'https://example.org/b',sha256:'b'.repeat(64)});project.selected.push('b');shot.sourceIds.push('b');
  shot.sourceUses.push({...first,id:'u3',sourceId:'b',actionGroup:'different-robot',role:'supplemental'});
  validatePlan(plan,project);
  shot.sourceUses.push({...first,id:'u4'});assert.throws(()=>validatePlan(plan,project));
  project.replayAuthorization='请重放一次作对照';validatePlan(plan,project);
  shot.sourceUses.at(-1).outSeconds=11;assert.throws(()=>validatePlan(plan,project),/时长/);
});

test('images, missing sources and malformed data are checked',()=>{
  const {project,plan}=fixture();project.sources[0].kind='image';
  assert.throws(()=>validatePlan(plan,project));
  Object.assign(plan.shots[0].sourceUses[0],{inSeconds:null,outSeconds:null,actionGroup:''});validatePlan(plan,project);
  for(const change of [{sourceIds:['missing']},{sourceUses:[null]},{sourceUses:[]},{layout:null}]){
    const p=structuredClone(plan);Object.assign(p.shots[0],change);assert.throws(()=>validatePlan(p,project));
  }
});

test('review UI escapes notes, presents bounds and retains identity when editing windows',()=>{
  const {project,plan}=fixture();plan.productionPlan.materialReview='<script>bad()</script>';
  const html=renderProductionPlan(plan);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|style=/);
  assert.match(html,/Test/);assert.match(html,/封面标题/);assert.doesNotMatch(html,/18%|上移/);assert.match(html,/viewBox=/);
  const shot=plan.shots[0],fields=[{dataset:{useField:'inSeconds'},value:'1.5'},{dataset:{useField:'purpose'},value:'Natural bridge'}];
  const node={dataset:{useId:'u1'},querySelectorAll:()=>fields};
  const read=readSourceUses({querySelectorAll:s=>s==='[data-use-id]'?[node]:[{dataset:{layoutField:'composition'},value:'素材居中'}]},shot);
  assert.equal(read.sourceUses[0].id,'u1');assert.equal(read.sourceUses[0].inSeconds,1.5);assert.equal(read.layout.composition,'素材居中');
  assert.equal(shot.sourceUses[0].inSeconds,1);
  const sourceHtml=renderSourceUses(shot,project.sources);assert.match(sourceHtml,/data-add-use/);assert.match(sourceHtml,/data-remove-use/);
});

test('all three workflow stages include common source and layout instructions',()=>{
  assert.match(taskPrompt('discover',{}),/beyond the same news/);
  assert.match(taskPrompt('plan',{}),/LOCAL-file seconds/);
  assert.match(taskPrompt('produce',{}),/material_continuity/);
  assert.match(taskPrompt('produce',{}),/context\.productionContext\.review_methods/);
  assert.doesNotMatch(taskPrompt('produce',{}),/Actual playback is required|listen to the final export/);
});

test('automatic request changes with the layout policy, never with the removed inset',async()=>{
  const {requestHash,beginAutomatic}=await import('../automatic.mjs');
  const {project}=fixture();project.styleSelector='example@1';
  const before=requestHash(project);project.portraitBottomInset=.4;assert.equal(requestHash(project),before);
  project.automatic={id:'legacy',requestHash:'legacy-hash',status:'running',stage:'delivery'};
  project.approval={status:'confirmed',planHash:'old',inputHash:'old'};
  beginAutomatic(project);assert.notEqual(project.automatic.id,'legacy');assert.equal(project.approval,null);
});

test('web.35 non-portrait fingerprints and passed-candidate delivery recovery are preserved',async()=>{
  // Captured by running the unchanged 76aac51 modules with this exact project fixture.
  const baselines=[['16:9','ba41185bb89286d425438c204715f1ef7cae0270347189887c0e078f9d85b1b0','7d26e717336fee29444b269858722e1eaf2d6d0a4298542c402c3d0bac141d51'],['1:1','964e98b4d351076fda16f9b40aff2e0104d6c086af69086b3c7b48dbbe43d06b','981302b9fc02f95b4b59347dbeabc7d94ebe2d448bfefc4d764bc45a370a96c9']];
  const {requestHash,beginAutomatic,nextAutomatic}=await import('../automatic.mjs');
  for(const [ratio,oldInput,oldRequest] of baselines){
    const p={...initialStudio(),ratio,topic:'legacy fixture',styleSelector:'sample@1',narration:false,portraitBottomInset:.18};delete p.layoutPolicy;
    assert.equal(inputHash(p),oldInput);assert.equal(requestHash(p),oldRequest);
    if(ratio==='16:9'){
      p.plan={stale:false,gaps:[]};p.approval={status:'confirmed',planHash:'approved-plan',inputHash:oldInput};
      p.qualityCycle={candidate:{planHash:'approved-plan',inputHash:oldInput},report:{completed:true}};
      p.automatic={id:'old-cycle',requestHash:oldRequest,status:'blocked',stage:'delivery'};
      assert.equal(beginAutomatic(p).id,'old-cycle');assert.equal(p.plan.stale,false);assert.equal(p.approval.inputHash,oldInput);
      assert.deepEqual(nextAutomatic(p),{action:'delivery'});
    }
  }
  const p={...initialStudio(),ratio:'9:16',topic:'legacy fixture',styleSelector:'sample@1',narration:false,portraitBottomInset:.18};delete p.layoutPolicy;
  assert.notEqual(inputHash(p),'9f424e419c522c3853ac12b3e736f2ba8c86a578f444faca51177d88cfb291d2');
  assert.notEqual(requestHash(p),'6b28634fcd192df4308fc517c7c5b279a43f2b576a0fb3c9fe1e63d457f85fd1');
});

test('Python chat and JavaScript workbench accept and reject the same portrait contracts',()=>{
  const cases=[];
  for(const ratio of ['9:16','16:9','1:1'])for(const captions of [true,false]){
    const f=fixture(ratio,captions);cases.push({plan:f.plan,settings:brief(f.project).requirements,sources:f.project.sources});
    if(ratio==='9:16')for(const change of [{titleText:'Different'},{fit:'cover'},{mediaBox:{left:0,top:.2,right:1,bottom:.68}},{captionStyle:null},{emphasisBoxes:[{bounds:{left:.1,top:.7,right:.2,bottom:.8},footageBounds:{left:0,top:.32,right:1,bottom:.68}}]}]){
      const c=structuredClone(cases[cases.length-1]);c.plan=structuredClone(f.plan);Object.assign(c.plan.shots[0].layout,change);cases.push(c);
    }
  }
  const js=cases.map(c=>{try{validateProductionPlan(c.plan,c.settings,c.sources);return true;}catch{return false;}});
  const script="import json,sys; sys.path.insert(0,sys.argv[1]); import production_plan as p\ncases=json.load(sys.stdin); out=[]\nfor c in cases:\n try: p.validate(c['plan'],c); out.append(True)\n except (ValueError,TypeError,KeyError): out.append(False)\nprint(json.dumps({'accepted':out,'layouts':[p.layout(c['settings']) for c in cases]}))";
  const result=JSON.parse(execFileSync(process.env.VIDEO_STUDIO_PYTHON||'python3',['-c',script,new URL('../../scripts',import.meta.url).pathname],{input:JSON.stringify(cases),encoding:'utf8'}));
  assert.deepEqual(result.accepted,js);assert.deepEqual(result.layouts,cases.map(c=>productionLayout(c.settings)));
});


test('top title remains required with captions off and only wrapping may differ from covers',()=>{
  for(const captions of [true,false]){
    const {project,plan}=fixture('9:16',captions);plan.shots[0].layout.titleText='Te\nst';validatePlan(plan,project);
    for(const titleText of ['',null,'Other','T\ne\nst','Test\n']){
      const bad=structuredClone(plan);bad.shots[0].layout.titleText=titleText;assert.throws(()=>validatePlan(bad,project));
    }
    for(const coverTitle of ['',null,'Other','Te\nst']){
      const bad=structuredClone(plan);bad.productionPlan.coverTitle=coverTitle;assert.throws(()=>validatePlan(bad,project));
    }
    const previous=structuredClone(plan);previous.productionPlan.layout.version=1;assert.throws(()=>validatePlan(previous,project));
    plan.shots[0].layout.titleText='<script>bad()</script>';plan.productionPlan.coverTitle=plan.shots[0].layout.titleText;
    assert.doesNotMatch(renderProductionPlan(plan),/<script>/);
  }
});

test('unreleased v1 non-portrait identities stay stable while v1 portraits must replan',async()=>{
  const {requestHash}=await import('../automatic.mjs');
  const frozen=[['16:9','e29d4747765f78acc69ed6bb80b2cadcd06dc3275fa37a3588c6ada760242638','36ea52bb5e9ab6b678afac5953a38b76d547719040bcfbbb52d143c953e7275f'],['1:1','7b98b91c994fe13f78ed07146085f780c237934e4aae505cc18bf55162474330','6faeb4d4e5712941da11efd4251cc96c58ff01c8a4f0b48aa67a5fa9b9d04977']];
  for(const [ratio,expectedInput,expectedRequest] of frozen){
    const project={...initialStudio(),ratio,topic:'v1 fixture',styleSelector:'sample@1',narration:false,layoutPolicy:'customer-portrait-v1'};
    assert.equal(inputHash(project),expectedInput);assert.equal(requestHash(project),expectedRequest);
    assert.equal(brief(project).requirements.layout_policy,'customer-portrait-v1');
    const input=inputHash(project),request=requestHash(project);project.layoutPolicy='customer-portrait-v2';
    assert.notEqual(inputHash(project),input);assert.notEqual(requestHash(project),request);
  }
  const f=fixture();f.project.layoutPolicy='customer-portrait-v1';assert.equal(brief(f.project).requirements.layout_policy,'customer-portrait-v2');
});
