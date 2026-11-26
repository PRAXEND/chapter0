import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStyleLibrary} from '../src/style.mjs';
import {currentStyles} from '../src/style-catalog.mjs';

const packs=fileURLToPath(new URL('../../../user-packs/',import.meta.url));
const pack='henry-video-styles';
async function scratch(t) {
  const root=await mkdtemp(path.join(tmpdir(),'studio-style-catalog-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;
}

test('only the two shipped v8 releases and their own verified benchmarks/components are production choices',async t=>{
  const dir=await scratch(t),library=createStyleLibrary(dir,{packsRoot:packs});
  const choices=await library.list();assert.deepEqual(choices.map(s=>[s.id,s.versions,s.available]),currentStyles.map(s=>[s.id,[8],true]));
  const [news,science]=await Promise.all(currentStyles.map(({id})=>library.get(id,8)));
  for(const s of [news,science]){
    assert.ok(s.baseline?.verified);assert.equal((await library.getReference(s.id,8,s.baseline.id)).sha256,s.baseline.sha256);
    assert.ok(s.components.length>=6);assert.equal(s.sha256,currentStyles.find(p=>p.id===s.id).sha256);
  }
  assert.notEqual(news.baseline.sha256,science.baseline.sha256);
  const scene={start:100,duration:120,actionFrame:175,text:'点着了',followup:'灯芯开始燃烧',anchorAssetId:'shot',anchorSourceFrame:175};
  const profile={width:1280,height:720,fps:25};
  assert.deepEqual(library.compileScene({...scene,style:news},profile).map(c=>[c.templateRole,c.start]),[['action',175],['result',195]]);
  assert.deepEqual(library.compileScene({...scene,style:science},profile).map(c=>[c.templateRole,c.start]),[['question',100],['explanation',175]]);
  assert.throws(()=>library.compileScene({...scene,style:news,actionFrame:undefined},profile),/动作帧/);
  assert.throws(()=>library.compileScene({...scene,style:news,text:'字'.repeat(70)},profile),/容量/);
  assert.equal(library.learn,undefined);assert.equal(library.savePreference,undefined);
});

test('missing or modified official files do not load an alternate version or inspect the personal catalogue',async t=>{
  const dir=await scratch(t),dist=path.join(dir,'packs'),pkg=path.join(dist,pack),legacy=path.join(dir,'legacy');
  await mkdir(path.join(pkg,'styles'),{recursive:true});await mkdir(path.join(legacy,'user-packs'),{recursive:true});
  // This invalid registry would throw if consulted. Earlier installs may contain newer or private versions.
  await writeFile(path.join(legacy,'user-packs','locations.json'),'unreadable registered catalogs');
  const future=path.join(dir,'style-library/versions/henry-hot-news/9');await mkdir(future,{recursive:true});
  await writeFile(path.join(future,'style.json'),JSON.stringify({id:'henry-hot-news',version:9,name:'私人新版'}));
  const lib=createStyleLibrary(dir,{packsRoot:dist,legacyHome:legacy,packRoots:[path.join(packs,pack)]});
  assert.ok((await lib.list()).every(item=>item.version===8&&!item.available));
  await assert.rejects(lib.get('henry-hot-news'),e=>e.status===503);
  for(const [id,v] of [['henry-hot-news',7],['henry-hot-news',9],['original-dialogue',1],['neutral',1],['my-style',1]])
    await assert.rejects(lib.get(id,v),e=>e.status===422);
  await copyFile(path.join(packs,pack,'manifest.json'),path.join(pkg,'manifest.json'));
  for(const pin of currentStyles){
    const file=path.join('styles',pin.id+'-v8.json');
    if(pin.id==='henry-hot-news')await copyFile(path.join(packs,pack,file),path.join(pkg,file));
    else {const spec=JSON.parse(await readFile(path.join(packs,pack,file),'utf8'));spec.rules=[];await writeFile(path.join(pkg,file),JSON.stringify(spec));}
  }
  assert.deepEqual((await lib.list()).map(x=>x.available),[true,false]);await assert.rejects(lib.get('henry-technical-explainer'),/指纹/);
  await writeFile(path.join(pkg,'styles/henry-technical-explainer-v8.json'),'{incomplete');
  assert.deepEqual((await lib.list()).map(x=>x.available),[true,false]);
});

test('HTTP selects the two latest styles, keeps the interview voice, and refuses out-of-catalogue changes without applying other edits',async t=>{
  const root=await scratch(t);
  const {startStudio}=await import('../src/server.mjs');
  const service=await startStudio({root,dependencies:{director:{close(){}}}});t.after(()=>service.close());
  const origin=new URL(service.url).origin,entry=await fetch(service.url,{redirect:'manual'});
  const headers={cookie:entry.headers.get('set-cookie').split(';')[0],origin,'content-type':'application/json'};
  const api=(route,body)=>fetch(origin+'/api/'+route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  assert.deepEqual((await (await api('styles')).json()).map(s=>[s.id,s.versions]),currentStyles.map(s=>[s.id,[8]]));
  for(const route of ['styles/neutral/1','styles/henry-hot-news/7','styles/my-private-style/1'])assert.equal((await api(route)).status,422);
  const project=await (await api('projects',{title:'历史回归',mode:'interview'})).json();
  assert.equal(project.style.id,'henry-hot-news');assert.equal(project.style.version,8);assert.equal(project.settings.voiceMode,'original');
  const route='projects/'+project.id;
  assert.equal((await api('styles/preferences',{id:'henry-hot-news',version:8,instruction:'另存测试'})).status,410);
  assert.equal((await api('styles/learn',{id:'new-style'})).status,410);assert.equal((await api(route+'/learn-style',{})).status,410);
  const configure=(baseRevision,changes)=>api(route+'/configure',{baseRevision,changes});
  assert.equal((await configure(project.revision,{title:'应回滚',style:{id:'neutral',version:1}})).status,422);
  assert.equal((await (await api(route)).json()).title,project.title);
  const next=await (await configure(project.revision,{style:{id:'henry-technical-explainer',version:8}})).json();
  assert.equal(next.style.id,'henry-technical-explainer');assert.equal(next.settings.voiceMode,'original');
  assert.equal((await api('projects',{mode:'script',style:{id:'henry-technical-explainer',version:9}})).status,422);
  assert.equal((await api('projects',{mode:'script',style:{id:'henry-hot-news',version:8,sha256:'0'.repeat(64)}})).status,422);
  const pkg=await scratch(t),missing=createStyleLibrary(root,{packsRoot:pkg});
  await assert.rejects(missing.get('henry-technical-explainer',8),e=>e.status===503);
});
