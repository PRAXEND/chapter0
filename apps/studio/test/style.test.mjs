import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createStyleLibrary,fileSha256} from '../src/style.mjs';
const profile={width:1080,height:1920,fps:30};

test('legacy pack formats verify their own benchmark, components and renderable template',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-style-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const packs=path.join(dir,'packs'), pack=path.join(packs,'known'),media=path.join(pack,'media/benchmarks');
  await mkdir(media,{recursive:true});await mkdir(path.join(pack,'styles'));
  const pathA=path.join(media,'a.mp4'),pathB=path.join(media,'b.mp4');
  await writeFile(pathA,'reference-one');await writeFile(pathB,'reference-two');
  const A={path:'resource:media/benchmarks/a.mp4',sha256:await fileSha256(pathA)},B={id:'benchmark',kind:'video',title:'测试',locator:'resource:media/benchmarks/b.mp4',sha256:await fileSha256(pathB)};
  const rows=[{id:'henry-hot-news',version:8,name:'热点',reproduction_bundle:{baseline:A,motion_graphics:[{id:'a',name:'反应'}]}},
    {id:'henry-technical-explainer',version:8,name:'科普',references:[B],reproduction_blueprint:{components:[{id:'b',role:'解释'}],effect_recipes:[{name:'放大'}]}}];
  for(const r of rows)await writeFile(path.join(pack,'styles',r.id+'.json'),JSON.stringify(r));
  await writeFile(path.join(pack,'manifest.json'),JSON.stringify({styles:rows.map(r=>'styles/'+r.id+'.json')}));
  const library=createStyleLibrary(dir,{packsRoot:packs,legacyHome:false});
  for(const r of rows){const s=await library.get(r.id,8);assert.ok(s.baseline.verified);assert.equal(s.components.length,1);}
  const a=await library.get(rows[0].id,8),b=await library.get(rows[1].id,8);
  const setup={start:100,duration:120,actionFrame:175,text:'点着了',followup:'灯芯开始燃烧',anchorAssetId:'shot',anchorSourceFrame:175};
  const news=library.compileScene({...setup,style:a},profile), science=library.compileScene({...setup,style:b},profile);
  assert.deepEqual(news.map(c=>c.templateRole),['action','result']);assert.equal(news[0].start,175);
  assert.deepEqual(science.map(c=>c.templateRole),['question','explanation']);assert.equal(science[0].start,100);assert.equal(science[1].start,175);
  assert.throws(()=>library.compileScene({...setup,style:a,actionFrame:undefined},profile),/动作帧/);
  assert.throws(()=>library.compileScene({...setup,style:a,text:'字'.repeat(70)},profile),/容量/);
  await writeFile(pathB,'changed');
  assert.equal((await library.get(rows[1].id,8)).baseline.available,false);
});
test('script-only learning, explicit evidence, immutable concurrent preferences and media confinement',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-learn-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const lib=createStyleLibrary(dir,{legacyHome:false,packsRoot:path.join(dir,'none')});
  const v1=await lib.learn({id:'talk',name:'教学',script:'先观察。\n\n再解释原因。'});
  assert.ok(v1.unknownDimensions.includes('visual'));assert.ok(v1.unknownDimensions.includes('audio'));
  assert.equal(v1.baseline,null);
  const req={id:'talk',version:1,instruction:'字幕多停留两帧。',source:'用户本次改稿'};
  const outcomes=await Promise.allSettled([lib.savePreference(req),lib.savePreference(req)]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  assert.equal((await lib.get('talk',1)).preferences.length,0);assert.equal((await lib.get('talk')).preferences.length,1);
  const footage=path.join(dir,'example.mp4');await writeFile(footage,'sample');
  const ref=await lib.captureReference(footage,{id:'sample',kind:'video'});
  const v=await lib.learn({id:'sample-style',name:'观察',observations:[{instruction:'证据后出现文字',evidence:'sample 0–1s',dimension:'visual'}],references:[ref]});
  assert.equal(v.baseline.available,true);assert.equal(v.unknownDimensions.includes('visual'),false);
  await assert.rejects(lib.learn({id:'bad',name:'越界',script:'x',references:[{...ref,locator:'/etc/passwd'}]}),/导入/);
});
