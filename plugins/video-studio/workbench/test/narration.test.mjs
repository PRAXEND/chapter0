import test from 'node:test';
import assert from 'node:assert/strict';
import {narrationArguments,submitNarration} from '../narration.mjs';
import {AppServerConnection} from '../desktop-rpc.mjs';

const voice={selected_by_user:true,voiceType:'custom',provider:'fish-audio',voiceId:'selected-custom',name:'已保存音色'};
const entry={type:'custom',customVoiceId:'selected-custom',voiceRef:'opaque-current-ref',available:true,supportedUses:['tts'],capabilities:{supportedControls:[]}};
const project={projectId:'existing-project',timelineId:'existing-timeline'};
const args=(v=voice,e=entry,request={text:'已确认旁白'})=>narrationArguments(v,{voices:[e]},request,project);

test('current custom directory resolves the saved stable ID without modifying it',()=>{
  const before=structuredClone(voice);
  assert.deepEqual(args(),{text:'已确认旁白',voiceRef:entry.voiceRef,...project});
  assert.deepEqual(voice,before);
  assert.equal(args(voice,{...entry,name:'改名后',voiceRef:'new-ref'}).voiceRef,'new-ref');
});

test('official entries use the fresh reference, with exact legacy fallback',()=>{
  const selected={...voice,voiceType:'official',provider:'doubao',voiceId:'official-id'};
  const official={...entry,type:'official',customVoiceId:undefined,provider:selected.provider,voiceId:selected.voiceId};
  assert.deepEqual(args(selected,official),{text:'已确认旁白',voiceRef:entry.voiceRef,...project});
  assert.deepEqual(args(selected,{...official,voiceRef:undefined}),{text:'已确认旁白',provider:selected.provider,voiceId:selected.voiceId,...project});
  assert.equal(args(voice,{...entry,customVoiceId:undefined,voiceRef:undefined,provider:voice.provider,voiceId:voice.voiceId}).voiceId,voice.voiceId);
});

test('same name, ID prefixes, conflicting namespaces and ambiguous identities cannot change the selection',()=>{
  for(const candidate of [
    {...entry,customVoiceId:'different',name:voice.name},
    {...entry,customVoiceId:'selected'},
    {...entry,type:'official'},
    {...entry,voiceType:'official'},
    {...entry,provider:'doubao'},
    {...entry,voiceId:'different'},
  ])assert.throws(()=>args(voice,candidate));
  for(const selected of [{...voice,provider:'doubao'},{...voice,voiceType:'official'},{...voice,selected_by_user:false}])assert.throws(()=>args(selected));
  assert.throws(()=>narrationArguments(voice,{voices:[entry,{...entry,voiceRef:'other-ref'}]},{text:'旁白'},project));
});

test('unavailable, non-TTS and incomplete current directory entries fail before submission',()=>{
  for(const candidate of [{...entry,available:false},{...entry,supportedUses:['avatar-video']},{...entry,voiceRef:undefined},{...entry,voiceRef:''}])assert.throws(()=>args(voice,candidate));
  assert.throws(()=>narrationArguments(voice,{voices:[]},{text:'旁白'},project));
});

test('caller cannot override the selected identity, project or retry key, or add unsupported controls',()=>{
  for(const extra of [{voiceRef:'other'},{voiceId:'other'},{customVoiceId:'other'},{provider:'other'},{projectId:'other'},{timelineId:'other'},{requestId:'new'},{speed:1.2}])assert.throws(()=>args(voice,entry,{text:'旁白',...extra}));
  assert.throws(()=>args(voice,entry,{text:' '}));
  assert.equal(args(voice,{...entry,capabilities:{supportedControls:['speed']}},{text:'旁白',speed:1}).speed,1);
});

for(const shape of ['structuredContent','content'])test('tool bridge resolves current directory and rechecks authority before spending: '+shape,async t=>{
  const calls=[];let checked=false,closed=false;
  t.mock.method(AppServerConnection.prototype,'open',async()=>{});
  t.mock.method(AppServerConnection.prototype,'close',()=>{closed=true;});
  t.mock.method(AppServerConnection.prototype,'send',async(method,params)=>{
    if(method==='thread/start')return {thread:{id:'tool-only'}};
    calls.push(params);
    if(params.tool==='manage_voice'){
      const catalog={voices:[entry]};
      return shape==='content'?{content:[{type:'text',text:JSON.stringify(catalog)}]}:{structuredContent:catalog};
    }
    assert.equal(checked,true);return {structuredContent:{jobId:'existing-job'}};
  });
  await submitNarration({codex:'unused',voice,request:{text:'旁白'},project,assertCurrent:async()=>{checked=true;}});
  assert.deepEqual(calls.map(c=>c.tool),['manage_voice','submit_voice']);
  assert.deepEqual(calls[1].arguments,{text:'旁白',voiceRef:entry.voiceRef,...project});
  assert.equal(closed,true);
});

for(const failure of ['cancelled','catalog','unknown-submit'])test('bridge fails safely without automatic paid retries: '+failure,async t=>{
  let submissions=0,closed=false;
  t.mock.method(AppServerConnection.prototype,'open',async()=>{});
  t.mock.method(AppServerConnection.prototype,'close',()=>{closed=true;});
  t.mock.method(AppServerConnection.prototype,'send',async(method,params)=>{
    if(method==='thread/start')return {thread:{id:'tool-only'}};
    if(params.tool==='manage_voice')return failure==='catalog'?{isError:true}:{structuredContent:{voices:[entry]}};
    submissions++;return {isError:true};
  });
  await assert.rejects(submitNarration({codex:'unused',voice,request:{text:'旁白'},project,assertCurrent:async()=>{if(failure==='cancelled')throw Error('paused');}}));
  assert.equal(submissions,failure==='unknown-submit'?1:0);assert.equal(closed,true);
});
