import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {capturePreference,renderTimelineWindow} from '../src/style-preference.mjs';
import {createStyleLibrary,fileSha256} from '../src/style.mjs';

test('preference replays each original revision at its own moved or deleted clip position',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-stored-preference-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const style=createStyleLibrary(root,{legacyHome:false,packsRoot:path.join(root,'empty')});
  await style.learn({id:'reader',name:'阅读',script:'先看原片。'});
  const shot=(id,start,duration)=>({id,start,duration,sourceIn:0,assetId:id,track:'video',gain:1,speed:1});
  const frame=(rev,rows)=>({id:'project',revision:rev,profile:{width:160,height:90,fps:10},timeline:{clips:rows}});
  const sequence=[frame(1,[]),frame(2,[shot('lead',0,20),shot('walk',20,24),shot('end',100,60)]),
    frame(3,[shot('lead',0,20),shot('walk',70,24),shot('end',100,60)]),frame(4,[shot('lead',0,20),shot('walk',70,24),shot('end',100,60)]),
    frame(5,[shot('lead',0,20),shot('end',57,60)])];
  const store={paths:()=>({cache:path.join(root,'cache')}),revision:(_id,n)=>sequence[n-1]};
  const captures=[],media={async renderProject(p,{window,output}){
    captures.push({revision:p.revision,...window});await writeFile(output,JSON.stringify({revision:p.revision,...window}));
    return {sha256:await fileSha256(output),frames:window.toFrame-window.fromFrame,duration:(window.toFrame-window.fromFrame)/p.profile.fps};
  }};
  const scope=(revision,fromFrame,toFrame)=>({projectId:'project',revision,clipId:'walk',fromFrame,toFrame});
  const v2=await capturePreference(style,store,{id:'reader',version:1,instruction:'移动到人走入画面时',findEdit:true,before:scope(3,70,94),after:scope(4,70,94)},{media});
  assert.deepEqual(captures,[{revision:2,fromFrame:11,toFrame:61},{revision:4,fromFrame:61,toFrame:111}]);
  const move=v2.preferences[0];assert.equal((await style.get('reader',1)).references.length,0);
  assert.ok((await style.getReference('reader',2,move.before.referenceId)).verified);assert.equal(v2.references[1].derivedFrom.fromFrame,61);
  const v3=await capturePreference(style,store,{id:'reader',version:2,instruction:'删掉走神的一遍',before:scope(4,70,94),after:scope(5,57,80)},{media});
  const removed=v3.preferences.at(-1);assert.equal(removed.before.clipPresent,true);assert.equal(removed.after.clipPresent,false);
  assert.equal(removed.before.fromFrame,61);assert.equal(removed.after.fromFrame,48);
  assert.equal((await style.getReference('reader',3,removed.after.referenceId)).sha256,removed.after.sha256);
  const v4=await capturePreference(style,store,{id:'reader',version:3,instruction:'开头留白',before:scope(1,0,10),after:scope(2,0,10)},{media});
  assert.equal(v4.preferences.at(-1).before.status,'empty-timeline');assert.equal(v4.references.length,5);
  const v5=await capturePreference(style,store,{id:'reader',version:4,instruction:'留意发音',before:scope(3,0,50),after:scope(4,0,50)},{media});
  assert.equal(v5.preferences.at(-1).after.status,'no-timeline-change');assert.equal(v5.references.length,5);
  await assert.rejects(renderTimelineWindow(sequence[1],{fromFrame:12,toFrame:999,media}),/区间/);
});
