import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {compileSceneWithSound} from '../src/scene-sound.mjs';
import {archiveSound} from '../src/style-sounds.mjs';
import {createStyleLibrary,fileSha256} from '../src/style.mjs';

test('observed event cues are editable, deduplicate physical PCM, and preserve the caller revision',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-anchor-sound-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const styles=createStyleLibrary(dir);
  const p={id:'p',revision:3,mode:'topic',profile:{width:640,height:360,fps:25},assets:[{id:'shot',kind:'video',duration:10}]};
  let imports=0;const store={get:()=>structuredClone(p),paths:()=>({cache:dir}),addAsset:async(_id,file,source)=>{
    const original=archiveSound({id:'henry-hot-news',version:8},'tiny-pop');assert.deepEqual(await readFile(file),original.data);
    const asset={id:'sound-'+(++imports),kind:'audio',hasAudio:true,sha256:await fileSha256(file),duration:original.spec.seconds,source};p.assets.push(asset);p.revision++;return asset;
  }};
  const scene={style:await styles.get('henry-hot-news'),start:0,duration:100,actionFrame:45,anchorAssetId:'shot',anchorSourceFrame:170,text:'触水了',followup:'舱体浮在海面'};
  const first=await compileSceneWithSound(styles,store,store.get(),scene),cue=first.clips.at(-1);assert.equal(first.baseRevision,4);assert.equal(cue.track,'music');assert.equal(cue.role,'sfx');assert.equal(cue.start,44);assert.equal(cue.locked,false);
  assert.equal((await compileSceneWithSound(styles,store,store.get(),scene)).baseRevision,4);assert.equal(imports,1);
  const silent=await compileSceneWithSound(styles,store,{...store.get(),mode:'interview'},scene);assert.equal(silent.clips.length,2);
  assert.equal((await compileSceneWithSound(styles,store,store.get(),{...scene,anchorSourceFrame:undefined})).clips.length,2);
  await assert.rejects(compileSceneWithSound(styles,store,{...store.get(),revision:3},scene),/工程版本/);
  const technical=await compileSceneWithSound(styles,store,store.get(),{...scene,style:await styles.get('henry-technical-explainer')});
  assert.equal(technical.clips.at(-1).templateRole,'reveal-sound');assert.equal(technical.baseRevision,4);assert.equal(technical.clips.at(-1).assetId,cue.assetId);
  p.assets.push({id:'alternate',kind:'audio',hasAudio:true,duration:1});
  const custom=await compileSceneWithSound(styles,store,store.get(),{...scene,soundAssetId:p.assets[2].id,soundGain:.11});assert.equal(custom.clips.at(-1).assetId,p.assets[2].id);assert.equal(custom.clips.at(-1).gain,.11);assert.equal(imports,1);
});
