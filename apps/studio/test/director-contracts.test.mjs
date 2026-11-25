import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStyleLibrary} from '../src/style.mjs';
import {createStore} from '../src/project.mjs';
import {compileSequenceEdit,sequenceRange} from '../src/sequence-edit.mjs';

test('original bundle and blueprint can be paged to the last character for the pinned version',async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'studio-style-pages-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const packs=fileURLToPath(new URL('../../../user-packs/',import.meta.url));
  const styles=createStyleLibrary(folder,{legacyHome:false,packsRoot:packs});
  const read=async(id,section)=>{
    let idx=0,content='',pages=0;
    do{const x=await styles.readDirectorSection(id,8,section,idx);pages++;assert.equal(x.offset,idx);
      content+=x.text;idx=x.nextOffset;
      if(idx===null)assert.equal(content.length,x.chars);
    }while(idx!==null);return {value:JSON.parse(content),pages};
  };
  const hot=await read('henry-hot-news','reproduction_bundle.documents');
  const tech=await read('henry-technical-explainer','reproduction_blueprint.graphic_placements');
  const edit=await read('henry-hot-news','reproduction_bundle.native_items');
  assert.ok(hot.value.reproduction_recipe.includes('复现'));assert.ok(tech.value.length>5);
  assert.ok(edit.pages>1&&edit.value.length>40);
  await assert.rejects(styles.readDirectorSection('henry-hot-news',8,'../../auth.json'),/已登记/);
  await assert.rejects(styles.readDirectorSection('henry-hot-news',2,'rules'),/版本/);
});

test('deleting a block keeps independent music source offsets, locked prefix, and moves downstream facts with their camera shots',()=>{
  const p={settings:{},timeline:{clips:[{id:'lock',track:'graphic',start:0,duration:10,locked:true},
    {id:'mid',track:'video',start:10,duration:10},{id:'last',track:'video',start:20,duration:10,actionFrame:24},
    {id:'bed',track:'music',start:0,duration:30,sourceIn:100,speed:1}]},
    storyboard:[{start:10,videoClipId:'mid'},{start:20,videoClipId:'last',visualSteps:[{atFrame:24,sourceFrame:44}]}],
    facts:[{start:10,url:'a'},{start:20,url:'b'}],directorNotes:[]};
  const edit=compileSequenceEdit(p,sequenceRange(p,{operation:'replace-range',fromFrame:10,toFrame:20}),{clips:[],board:[],notes:[],facts:[],frames:0});
  assert.equal(edit.clips.find(c=>c.id==='lock').locked,true);
  assert.deepEqual(edit.clips.filter(c=>c.track==='music').map(c=>[c.start,c.duration,c.sourceIn]),[[0,10,100],[10,10,120]]);
  assert.deepEqual(edit.facts,[{start:10,url:'b'}]);assert.deepEqual(edit.storyboard[0].visualSteps,[{atFrame:14,sourceFrame:44}]);
  assert.equal(edit.clips.find(c=>c.id==='last').actionFrame,14);
  assert.throws(()=>compileSequenceEdit({...p,timeline:{clips:p.timeline.clips.map(c=>c.id==='last'?{...c,locked:true}:c)}},
    {mode:'replace-range',from:10,to:20},{clips:[],board:[],notes:[],facts:[],frames:0}),/后方锁定/);
});

test('normal SQLite scene writes store the metadata in the same immutable revision and roll back invalid edits',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'studio-director-db-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createStore(root);t.after(()=>store.close());
  const p=store.create({mode:'script'}),clip={id:'g1',track:'graphic',text:'first',start:0,duration:10};
  const meta={storyboard:[{start:0,duration:10}],facts:[{start:0,url:'https://example.org'}],directorNotes:[]};
  const saved=store.applySceneEdit(p.id,p.revision,[{op:'add',clip}],meta);
  assert.deepEqual(store.revision(p.id,saved.revision).facts,meta.facts);
  assert.equal(store.revision(p.id,p.revision).facts,undefined);
  assert.throws(()=>store.applySceneEdit(p.id,saved.revision,[{op:'update',id:clip.id,changes:{text:'wrong'}},{op:'remove',id:'missing'}],{facts:[]}),/已改变/);
  assert.equal(store.get(p.id).timeline.clips[0].text,'first');assert.deepEqual(store.get(p.id).facts,meta.facts);
  assert.throws(()=>store.applySceneEdit(p.id,saved.revision,[{op:'remove',id:clip.id}],{settings:{shareFrames:true}}),/元数据/);
});
