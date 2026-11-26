import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStyleLibrary,fileSha256} from '../src/style.mjs';
import {createStore} from '../src/project.mjs';
import {createQueue} from '../src/jobs.mjs';
import {specDigest} from '../src/style-portable.mjs';
import {portableProject} from '../src/library.mjs';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-archive-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),target=path.join(root,'target'),a=createStyleLibrary(source),b=createStyleLibrary(target);
  const mediaDir=path.join(source,'style-library/media'),versionDir=path.join(source,'style-library/versions/my-observation/2');
  await mkdir(mediaDir,{recursive:true});await mkdir(versionDir,{recursive:true});
  const pic=path.join(root,'original.png');await writeFile(pic,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==','base64'));
  const hash=await fileSha256(pic);await copyFile(pic,path.join(mediaDir,hash+'.png'));
  const pin={id:'my-observation',version:2,name:'试验风格'};
  const spec={...pin,rules:[],references:[{id:'frame',kind:'image',title:'观察片段',locator:'library:'+hash+'.png',sha256:hash}]};
  const specFile=path.join(versionDir,'style.json');await writeFile(specFile,JSON.stringify(spec));
  const box=path.join(root,'archive');const selector=await a.exportPortable({...pin,sha256:specDigest(spec),manifest:'style/manifest.json'},box);
  const input=path.join(box,'project.vstudio.json');const p={schema:1,mode:'interview',title:'以前的采访',spec:'',style:{...pin,...selector},
    profile:{fps:25,width:1280,height:720},assets:[],timeline:{clips:[{id:'archived-caption',track:'caption',start:0,duration:25,text:'一句旧字幕'}]}};
  await writeFile(input,JSON.stringify(p));return {root,source,target,a,b,pin,p,hash,box,selector,input,pic,specFile};
}

test('a retired style and its private reference travel only with the editable project, including a second export and reopen',async t=>{
  const f=await fixture(t),before=await fileSha256(f.specFile),store=createStore(f.target);t.after(()=>store.close());
  const imported=await store.importSnapshot(f.input,f.b);
  const queue=createQueue({store});assert.throws(()=>queue.enqueue(imported.id,'produce'),/历史风格/);
  assert.deepEqual(store.listJobs(imported.id),[]);await queue.close();
  assert.deepEqual(imported.style,f.p.style);assert.deepEqual(imported.timeline,f.p.timeline);assert.equal(imported.settings.voiceMode,'original');
  const privateMedia=path.join(store.paths(imported.id).directory,'style/media',f.hash+'.png');
  assert.equal(await fileSha256(privateMedia),f.hash);
  assert.ok(!(await f.b.list()).some(s=>s.id===f.pin.id));await assert.rejects(f.b.get(f.pin.id,2),/退出/);
  await assert.rejects(readFile(path.join(f.target,'style-library/versions/my-observation/2/style.json')),e=>e.code==='ENOENT');
  const edited=store.apply(imported.id,imported.revision,[{op:'update',id:'archived-caption',changes:{text:'编辑旧字幕'}}]);
  const out=await portableProject(edited,path.join(f.root,'again'),f.b);const reopened=await store.importSnapshot(out,f.b);
  assert.equal(reopened.timeline.clips[0].text,'编辑旧字幕');assert.equal(reopened.style.sha256,f.selector.sha256);
  assert.equal(await fileSha256(f.specFile),before);
});

test('retired archives reject changed bytes, traversing links and selectors with the wrong digest before they become projects',async t=>{
  const f=await fixture(t),store=createStore(f.target);t.after(()=>store.close());
  const asset=path.join(f.box,'style/media',f.hash+'.png');
  await writeFile(asset,'altered');await assert.rejects(store.importSnapshot(f.input,f.b),/指纹/);
  await rm(asset);await symlink(f.pic,asset);await assert.rejects(store.importSnapshot(f.input,f.b),/越界/);
  await rm(asset);await copyFile(f.pic,asset);await writeFile(f.input,JSON.stringify({...f.p,style:{...f.p.style,sha256:'0'.repeat(64)}}));
  await assert.rejects(store.importSnapshot(f.input,f.b),/不一致/);assert.equal(store.list().length,0);
});

test('current portable specs must match the shipped release and an older snapshot with no separate style file stays editable',async t=>{
  const f=await fixture(t);
  const published=await f.b.get('henry-hot-news',8),dir=path.join(f.root,'current');
  const pin=await f.b.exportPortable(published,dir);
  assert.equal((await f.a.restorePortable(pin,dir)).sha256,published.sha256);
  const legacy={id:'neutral',version:1,name:'自然剪辑'},dest=path.join(f.root,'old-no-spec');
  await mkdir(dest);await writeFile(path.join(dest,'project.vstudio.json'),JSON.stringify({...f.p,style:legacy}));
  const store=createStore(f.target);t.after(()=>store.close());const old=await store.importSnapshot(path.join(dest,'project.vstudio.json'),f.b);
  const out=await portableProject(old,path.join(f.root,'copy-no-spec'),f.b);assert.deepEqual(JSON.parse(await readFile(out,'utf8')).style,legacy);
  await assert.rejects(readFile(path.join(path.dirname(out),'style','manifest.json')),e=>e.code==='ENOENT');
});

test('importing a historical selector alone cannot borrow a same-named private reference from this computer',async t=>{
  const f=await fixture(t),sourceStore=createStore(f.source);t.after(()=>sourceStore.close());
  for(const claimed of [f.pin,{...f.pin,sha256:f.selector.sha256}]) {
    await writeFile(f.input,JSON.stringify({...f.p,style:claimed}));
    const loaded=await sourceStore.importSnapshot(f.input,f.a),dest=path.join(f.root,'public-'+loaded.id);
    await portableProject(loaded,dest,f.a);
    assert.deepEqual(JSON.parse(await readFile(path.join(dest,'project.vstudio.json'),'utf8')).style,claimed);
    await assert.rejects(readFile(path.join(dest,'style/manifest.json')),e=>e.code==='ENOENT');
  }
});
