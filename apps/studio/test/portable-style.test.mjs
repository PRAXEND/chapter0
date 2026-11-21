import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStyleLibrary,fileSha256} from '../src/style.mjs';

test('a portable personal style survives a clean library, protects an existing version, and rejects changed or escaping media',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-style-transfer-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const options={packsRoot:path.join(root,'none'),legacyHome:false,media:{probeMedia:async()=>({kind:'image',width:1,height:1,duration:0})}};
  const from=createStyleLibrary(path.join(root,'from'),options),to=createStyleLibrary(path.join(root,'to'),options);
  const image=path.join(root,'picture.png');await writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==','base64'));
  const ref=await from.captureReference(image,{id:'frame',kind:'image'});
  const one=await from.learn({id:'my-observation',name:'观察',script:'先看帧。',references:[ref]});
  const dir=path.join(root,'archive'),selector=await from.exportPortable(one,dir);
  assert.equal(selector.sha256,one.sha256);assert.deepEqual(await from.exportPortable(one,dir),selector);
  const index=JSON.parse(await readFile(path.join(dir,'style/manifest.json'))),asset=path.join(dir,'style',index.references[0].path);
  assert.equal(index.references[0].path,'media/'+ref.sha256+'.png');assert.equal(index.references[0].status,'included');
  const results=await Promise.all([to.restorePortable(selector,dir),to.restorePortable(selector,dir)]);assert.equal(results[0].sha256,selector.sha256);
  const copy=await to.get(one.id,1);assert.equal(copy.sha256,one.sha256);assert.deepEqual(copy.rules,one.rules);
  const reloaded=await to.getReference(one.id,1,ref.id);assert.equal(await fileSha256(reloaded.path),ref.sha256);
  const later=await to.savePreference({id:one.id,version:1,instruction:'拉长半秒'});assert.equal(later.version,2);
  const conflict=createStyleLibrary(path.join(root,'conflict'),options);
  const different=await conflict.learn({id:one.id,name:'其他风格',script:'另一条原稿。'});
  await assert.rejects(conflict.restorePortable(selector,dir),/同编号/);assert.equal((await conflict.get(one.id,1)).sha256,different.sha256);
  await writeFile(asset,'mutated');await assert.rejects(to.restorePortable(selector,dir),/指纹/);
  await rm(asset);await symlink(image,asset);await assert.rejects(to.restorePortable(selector,dir),/越界/);
});

test('a privately registered pack retains its exact resource locators; bundled assets use the local installed copy',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-pack-transfer-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const packages=path.join(root,'packages'),pack=path.join(packages,'personal-pack'),media=path.join(pack,'media/benchmarks');
  await mkdir(media,{recursive:true});const clip=path.join(media,'benchmark.mp4');await writeFile(clip,'reference bytes');
  const spec={id:'private-method',version:7,name:'私有方法',reproduction_bundle:{baseline:{path:'resource:media/benchmarks/benchmark.mp4',sha256:await fileSha256(clip)}}};
  await writeFile(path.join(pack,'spec.json'),JSON.stringify(spec));await writeFile(path.join(pack,'manifest.json'),JSON.stringify({styles:['spec.json']}));
  const options={legacyHome:false,packsRoot:path.join(root,'none')};
  const ext=createStyleLibrary(path.join(root,'first'),{...options,packRoots:[pack]}),clean=createStyleLibrary(path.join(root,'second'),options);
  const archive=path.join(root,'private-project'),selector=await ext.exportPortable(spec,archive);
  const imported=await clean.restorePortable(selector,archive);const one=await clean.get(imported.id,7);
  assert.deepEqual(JSON.parse(await readFile(path.join(archive,'style/spec.json'))),spec);assert.equal(one.baseline.verified,true);
  const next=await clean.savePreference({id:spec.id,version:7,instruction:'以事件为准'});assert.equal(next.baseline.verified,true);
  const builtin=createStyleLibrary(path.join(root,'as-builtin'),{legacyHome:false,packsRoot:packages}),shipped=path.join(root,'bundled-project');
  const packaged=await builtin.exportPortable(spec,shipped),file=JSON.parse(await readFile(path.join(shipped,'style/manifest.json')));assert.equal(file.references[0].status,'bundled');
  const another=createStyleLibrary(path.join(root,'fresh-mac'),{legacyHome:false,packsRoot:packages});assert.equal((await another.restorePortable(packaged,shipped)).sha256,packaged.sha256);
  const bare=createStyleLibrary(path.join(root,'no-pack'),options);await assert.rejects(bare.restorePortable(packaged,shipped),/发行包缺少/);
});

test('legacy installed pack paths and modern relative paths identify the same frozen style',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'style-pack-path-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const old=path.join(root,'legacy'),shipped=path.join(root,'installed'),pkg=path.join(shipped,'my-pack'),directory=path.join(root,'output');
  const ext=path.join(old,'user-packs','my-pack','2'),evidence='evidence/notes.txt';
  for(const home of [ext,pkg]){await mkdir(path.join(home,'evidence'),{recursive:true});await writeFile(path.join(home,evidence),'可验证的参考');}
  const fingerprint=await fileSha256(path.join(ext,evidence));
  const version=prefix=>({id:'portable-method',name:'方法',version:4,distribution:{pack:'my-pack@2',resources:prefix+'resources.json',text_evidence:[prefix+evidence]},references:[{id:'notes',kind:'script',title:'规则',locator:prefix+evidence,sha256:fingerprint}]});
  const legacy=version(ext+'/'),source=version('pack:');const loc=path.join(old,'styles',legacy.id,'4');await mkdir(loc,{recursive:true});await writeFile(path.join(loc,'style.json'),JSON.stringify(legacy));
  await writeFile(path.join(pkg,'spec.json'),JSON.stringify(source));await writeFile(path.join(pkg,'manifest.json'),JSON.stringify({styles:['spec.json']}));
  const a=createStyleLibrary(path.join(root,'a'),{legacyHome:old,packsRoot:shipped}),b=createStyleLibrary(path.join(root,'b'),{legacyHome:false,packsRoot:shipped});
  assert.equal((await a.get(legacy.id,4)).sha256,(await b.get(legacy.id,4)).sha256);
  const pointer=await a.exportPortable(legacy,directory);const restored=await b.restorePortable(pointer,directory);assert.equal(pointer.sha256,restored.sha256);
  const verified=await b.getReference(source.id,4,'notes');assert.equal(verified.verified,true);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory,'style/spec.json'))),legacy);
});
