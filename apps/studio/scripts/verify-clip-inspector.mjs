// Native interaction with a real copy of the supplied source. No default project or account is opened.
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createStore} from '../src/project.mjs';
import {frameAt,probeMedia,renderPreviewWindow,renderProjectFrame} from '../src/media.mjs';
const execute=promisify(execFile),tmp=await mkdtemp(path.join(os.tmpdir(),'studio-native-clip-'));
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url))),source=path.resolve(process.argv[2]||'');
if(!process.argv[2])throw Error('请提供一段至少两秒的本地录像路径。');
const store=createStore(path.join(tmp,'studio'),{probeMedia});
let service;
try{
  const profile={width:320,height:180,fps:24};let p=store.create({mode:'script',profile}),asset=await store.addAsset(p.id,source);
  assert.ok(asset.kind==='video'&&asset.duration>=2);p=store.get(p.id);
  p=store.apply(p.id,p.revision,[{op:'add',clip:{id:'footage',assetId:asset.id,track:'video',start:0,duration:48}},
    {op:'add',clip:{id:'label',track:'graphic',text:'取景',start:0,duration:48,geometry:{x:.45,y:.5}}}]);
  const thumb=path.join(tmp,'source.jpg');await frameAt(asset.path,.2,thumb,{maxWidth:320});
  const allowed=new Set(['advanced-inspector.js','clip-automation.js','motion-clock.js','advanced-inspector.css']);
  service=createServer(async(req,res)=>{
    const route=new URL(req.url,'http://localhost').pathname,name=route.slice(1);
    try{
      if(route==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/advanced-inspector.css"><div id="test" style="max-width:520px"></div>');}
      else if(allowed.has(name)){res.setHeader('Content-Type',name.endsWith('css')?'text/css':'text/javascript');res.end(await readFile(path.join(root,'www',name)));}
      else if(route==='/project'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(store.get(p.id)));}
      else if(route==='/edit'&&req.method==='POST'){let json='';for await(const chunk of req)json+=chunk;const {commands,revision}=JSON.parse(json);res.end(JSON.stringify(store.apply(p.id,revision,commands)));}
      else if(route.endsWith('/thumb')){res.setHeader('Content-Type','image/jpeg');res.end(await readFile(thumb));}
      else{res.writeHead(404).end();}
    }catch(error){res.writeHead(422).end(JSON.stringify({error:error.message}));}
  });
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
  const js=path.join(tmp,'probe.js'),bin=path.join(tmp,'webkit');
  await writeFile(js,`
    const send=v=>webkit.messageHandlers.transport.postMessage(v);
    try{
      const {mountClipInspector}=await import('/advanced-inspector.js'),element=document.getElementById('test');
      const project=()=>fetch('/project').then(r=>r.json()),wait=async check=>{for(let i=0;i<110;i++){if(await check())return;await new Promise(r=>setTimeout(r,35));}throw Error('等待交互反馈超时');};
      let p=await project(),inspector;
      function mount(id){inspector?.dispose();const clip=p.timeline.clips.find(c=>c.id===id);inspector=mountClipInspector({element,project:p,clip,frame:24,seek:f=>inspector.setFrame(f),
        commit:async commands=>{const r=await fetch('/edit',{method:'POST',body:JSON.stringify({revision:p.revision,commands})});if(!r.ok)throw Error(await r.text());p=await r.json();}});
        element.querySelector('details').open=true;}
      const click=a=>element.querySelector('[data-ae="'+a+'"]').click(),value=(k,v)=>{const el=element.querySelector('[data-ae-value="'+k+'"]');el.value=v;el.dispatchEvent(new Event('change',{bubbles:true}));};
      mount('footage');await wait(()=>element.querySelector('[data-ae="ellipse"]'));click('ellipse');value('feather',.08);
      click('mode-curve');click('slow');const svg=element.querySelector('.ae-pad');svg.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const r=svg.getBoundingClientRect(),xy=(x,y)=>[r.left+x*r.width,r.top+y*r.height];
      send({drag:[xy(.5,.75),xy(.51,.71),xy(.54,.65),xy(.57,.61),xy(.57,.61)]});
      await wait(()=>Math.abs(Number(element.querySelector('[data-ae-value="sourceFrame"]').value)-12)>2);
      const dragged=Number(element.querySelector('[data-ae-value="sourceFrame"]').value);
      click('mode-focus');click('add');value('zoom',1.6);value('x',.72);
      mount('label');await wait(()=>element.querySelector('[data-ae="add"]'));mount('footage');await wait(()=>element.querySelector('[data-ae="apply"]')&&!element.querySelector('[data-ae="apply"]').disabled);
      click('apply');await wait(async()=>{const c=(await project()).timeline.clips.find(c=>c.id==='footage');return c.mask?.feather===.08&&c.timeMap?.points.length===3&&c.framing?.keys.length===1;});
      p=await project();mount('label');await wait(()=>element.querySelector('[data-ae="add"]'));click('add');value('rotation',120);click('apply');
      await wait(async()=>(await project()).timeline.clips.find(c=>c.id==='label').keyframes?.some(k=>k.frame===24&&k.rotation===120));
      p=await project();mount('footage');await wait(()=>element.querySelector('output'));if(element.querySelector('output').textContent.includes('冲突'))throw Error('保存后错误显示外部冲突');
      inspector.dispose();send({revision:p.revision,dragged,rotation:120});
    }catch(error){send({error:String(error),stack:error.stack});}
  `);
  await execute('/usr/bin/xcrun',['swiftc',path.join(root,'test/timeline-player-webkit.swift'),'-o',bin],{timeout:120000});
  const run=await execute(bin,['http://127.0.0.1:'+service.address().port,js],{timeout:108000}).catch(e=>{throw Error(e.stdout||e.stderr||e.message);});
  const result=JSON.parse(run.stdout.trim());p=store.get(p.id);
  const out=process.argv[3]?path.resolve(process.argv[3]):tmp;await mkdir(out,{recursive:true});
  const window=await renderPreviewWindow(p,{directory:tmp,output:path.join(out,'advanced-preview.mp4'),window:{fromFrame:0,toFrame:48}});
  await renderProjectFrame(p,{directory:tmp,output:path.join(out,'advanced-frame.jpg'),frame:24,maxWidth:320});
  const info=await probeMedia(window.videoPath);
  console.log(JSON.stringify({native:result,source:asset.sha256,preview:window.sha256,frames:info.frames,size:[info.width,info.height],hasAudio:info.hasAudio},null,2));
}finally{if(service)await new Promise(resolve=>service.close(resolve));store.close();await rm(tmp,{recursive:true,force:true});}
