import test from 'node:test';
import assert from 'node:assert/strict';
import {initialStudio,validateSettings,updateSettings,validatePlan,inputHash,assertReady,brief,taskPrompt,approvalAuthority} from '../studio-workflow.mjs';
import {privateAddress,publicUrl} from '../media.mjs';

function project(){const p=initialStudio();Object.assign(p,{topic:'测试内容',sources:[{id:'a',sha256:'a'.repeat(64),status:'ready',localPath:'/tmp/a.mp4'}],selected:['a']});return p;}
function settings(p){const {topic,purpose,duration,ratio,fps,language,narration,captions,music,voiceDirection,styleSelector,styleDescription,outputRoot,selected}=p;return {topic,purpose,duration,ratio,fps,language,narration,captions,music,voiceDirection,styleSelector,styleDescription,outputRoot,selected};}
function plan(){return {title:'方案',script:'文案',shots:[{id:'1',from:0,to:30,sourceIds:['a'],narration:'文案',visual:'画面',screenText:'标题',transition:'硬切'}],gaps:[],notes:[]};}
test('sound choices reach the production brief and changes revoke approval',()=>{
  const p=project();assert.equal(p.narration,true);assert.equal(brief(p).requirements.audio_required,true);
  for(const choice of [{narration:false,music:'source'},{narration:false,music:'instrumental'},{narration:false,music:'none'},{narration:true,music:'none'}]){
    p.plan=validatePlan(plan(),p);p.approval={status:'confirmed',inputHash:inputHash(p)};
    updateSettings(p,{...settings(p),...choice});assert.equal(p.approval,null);
    assert.equal(brief(p).requirements.audio_required,choice.narration||choice.music!=='none');
  }
});
test('uncollected and nonexistent sources cannot be selected',()=>{const p=project();assert.throws(()=>updateSettings(p,{...settings(p),selected:['missing']}));p.sources[0].status='candidate';assert.throws(()=>updateSettings(p,settings(p)));});
test('only exact approved input is producible; destination changes preserve creative approval',()=>{const p=project();p.plan=validatePlan(plan(),p);assert.throws(()=>assertReady(p,'produce'));p.approval={status:'confirmed',inputHash:inputHash(p)};assert.doesNotThrow(()=>assertReady(p,'produce'));updateSettings(p,{...settings(p),outputRoot:'/tmp/new-destination'});assert.ok(p.approval);updateSettings(p,{...settings(p),styleDescription:'新表达'});assert.equal(p.approval,null);assert.equal(p.plan.stale,true);assert.throws(()=>assertReady(p,'produce'));});
test('source bytes, narration and voice changes invalidate the approved input',()=>{const p=project();const first=inputHash(p);p.sources[0].sha256='b'.repeat(64);assert.notEqual(inputHash(p),first);const second=inputHash(p);p.voiceDirection='明亮';assert.notEqual(inputHash(p),second);});
test('plan must be continuous and use selected source IDs',()=>{const p=project();assert.doesNotThrow(()=>validatePlan(plan(),p));assert.throws(()=>validatePlan({...plan(),shots:[{...plan().shots[0],from:1}]},p));assert.throws(()=>validatePlan({...plan(),shots:[{...plan().shots[0],sourceIds:['other']}]},p));assert.throws(()=>validatePlan({...plan(),shots:[{...plan().shots[0],to:31}]},p));});
test('acknowledged limitations remain in the plan while real missing inputs still block production',()=>{
  const p=project();p.plan=validatePlan({...plan(),limitations:['只描述可见动作，不宣称缺少证据的完整工序']},p);p.approval={status:'confirmed',inputHash:inputHash(p)};
  assert.deepEqual(p.plan.limitations,['只描述可见动作，不宣称缺少证据的完整工序']);assert.doesNotThrow(()=>assertReady(p,'produce'));
  p.plan.gaps=['本镜头必须使用的源文件尚未取得'];assert.throws(()=>assertReady(p,'produce'),/缺口/);
});
test('style selectors must come from the real library and media generation choices are explicit',()=>{const p=project();assert.throws(()=>validateSettings({...settings(p),styleSelector:'fake@1'},[]));assert.equal(validateSettings(settings(p),[]).narration,true);assert.deepEqual(brief({...p,styleDescription:'本次自由描述'}).style_overrides,{});assert.equal(brief(p).creative_direction,'');});
test('private network source URLs are rejected before fetching',async()=>{for(const ip of ['127.0.0.1','10.1.2.3','192.168.1.5','172.20.0.1','169.254.169.254','::1','fc00::1','::ffff:127.0.0.1'])assert.ok(privateAddress(ip));assert.equal(privateAddress('8.8.8.8'),false);await assert.rejects(()=>publicUrl('http://127.0.0.1/admin'));await assert.rejects(()=>publicUrl('file:///etc/passwd'));});
test('production prompt requires actual plugin export and respects approved script; discovery cannot mutate a project',()=>{const production=taskPrompt('produce',{planHash:'approved',inputHash:'inputs'});assert.match(production,/script-storyboard-approval/);assert.match(production,/No further stage approval/);assert.match(production,/Never persist editor-boot-token/);assert.match(taskPrompt('discover',{}),/Do not download anything/);});

test('delegated review records explicit authority and rejects missing or fabricated confirmation kinds',()=>{
  assert.deepEqual(approvalAuthority(),{kind:'user_click'});
  assert.throws(()=>approvalAuthority({kind:'delegated_review',authorizedByUser:true,userRequest:''}));
  assert.throws(()=>approvalAuthority({kind:'delegated_review',userRequest:'请审阅并完成全流程'}));
  assert.throws(()=>approvalAuthority({kind:'model_assumed_approval'}));
  const explicit={kind:'delegated_review',authorizedByUser:true,userRequest:'请 review 整体并完成实际制作、检查和修复'};
  assert.deepEqual(approvalAuthority(explicit),explicit);
});
test('a confirmation expressed in chat keeps the actual user words and prior reviewed version',()=>{
  const authority={kind:'user_message',userRequest:'我已经点击确认，请继续到下一步',priorReviewedPlanHash:'a'.repeat(64)};
  assert.deepEqual(approvalAuthority(authority),authority);
  assert.throws(()=>approvalAuthority({kind:'user_message'}));assert.throws(()=>approvalAuthority({...authority,priorReviewedPlanHash:'not-a-hash'}));
});

test('choosing media supplies the project topic without a separate topic field',()=>{
  const p=initialStudio();p.sources=[{id:'clip',title:'机器人动作演示',status:'ready',sha256:'a'.repeat(64)}];
  assert.throws(()=>assertReady(p,'plan'),/至少采集并选择/);
  updateSettings(p,{...settings(p),selected:['clip']});
  assert.equal(p.topic,'机器人动作演示');assert.equal(p.title,p.topic);assert.doesNotThrow(()=>assertReady(p,'plan'));
  p.approval={status:'confirmed',inputHash:inputHash(p)};
  updateSettings(p,{...settings(p),outputRoot:'/tmp/another-output'});
  assert.equal(p.topic,'机器人动作演示');assert.ok(p.approval);
  p.sources.push({id:'next',title:'另一个素材',status:'ready',sha256:'b'.repeat(64)});
  updateSettings(p,{...settings(p),selected:['clip','next']});
  assert.equal(p.topic,'机器人动作演示');assert.equal(p.approval,null);
});
