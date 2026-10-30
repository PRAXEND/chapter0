import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {collectRepository,canCollectRepository,scopedCollectionContext,downloadRepositoryMedia} from '../collection.mjs';
import {nativeMediaTool} from '../media.mjs';

function fixture(run){
  const bytes=Buffer.from('isolated acquisition fixture; not a production video'),sha256=createHash('sha256').update(bytes).digest('hex'),commit='a'.repeat(40);
  const source={id:'clicked',title:'测试原片',url:'https://x.com/example/status/1',sourceType:'x_repository',repositoryCommit:commit,
    repositoryPath:'2026/2026-10-28/001/videos/01.mp4',expectedSha256:sha256,expectedBytes:bytes.length,start:1,end:3};
  const manifest={schema_version:2,date:'2026-10-28',status:'ready',items:[{id:'001'},{id:'002'}]};
  const meta={schema_version:2,id:'001',date:'2026-10-28',source_url:source.url,media:[{file:'videos/01.mp4',sha256,bytes:bytes.length,type:'video',w:160,h:90,duration:4}]};
  const pointer=`version https://git-lfs.github.com/spec/v1\noid sha256:${sha256}\nsize ${bytes.length}\n`;
  const calls=[],downloads=[];
  const readText=async url=>{calls.push(url);assert.ok(url.includes('/'+commit+'/'));assert.ok(!url.includes('/002/'));return url.endsWith('manifest.json')?JSON.stringify(manifest):url.endsWith('meta.json')?JSON.stringify(meta):pointer;};
  const download=async(url,file)=>{downloads.push(url);await writeFile(file,bytes);};
  const inspect=async file=>({path:file,sha256,bytes:bytes.length,width:160,height:90,duration:4,hasVideo:true});
  let decodes=0;
  return {context:{run,source,brief:{topic:'测试',requirements:{max_download_seconds:300}}},options:{readText,download,inspect,decode:async()=>{decodes++;}},
    source,manifest,meta,calls,downloads,bytes,get decodes(){return decodes;}};
}

test('media commands honour the configured tool directory instead of a broken PATH binary',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'media-tool-test-'));
  try{
    await writeFile(path.join(directory,'ffmpeg'),'isolated path fixture');
    assert.equal(await nativeMediaTool('ffmpeg',{VIDEO_STUDIO_FFMPEG_DIR:directory}),await realpath(path.join(directory,'ffmpeg')));
    await assert.rejects(()=>nativeMediaTool('ffprobe',{VIDEO_STUDIO_FFMPEG_DIR:directory}),/缺少 ffprobe/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('pinned single-item collection reads only three records, downloads once, preserves offsets and reuses verified bytes',async()=>{
  const run=await mkdtemp(path.join(os.tmpdir(),'collection-test-'));
  try{
    const f=fixture(run);assert.equal(canCollectRepository(f.source),true);
    const result=await collectRepository(f.context,f.options),source=result.sources[0];
    assert.equal(f.calls.length,3);assert.equal(f.downloads.length,1);assert.equal(f.decodes,1);
    assert.equal(source.start,1);assert.equal(source.end,3);assert.deepEqual(await readFile(source.localPath),f.bytes);
    const report=JSON.parse(await readFile(source.acquisitionReport));assert.equal(report.originalFilePreserved,true);assert.equal(report.visualReview,'unverified');
    await collectRepository(f.context,f.options);assert.equal(f.downloads.length,1);
    await writeFile(source.localPath,'changed');await assert.rejects(()=>collectRepository(f.context,f.options),/已变化/);assert.equal(f.downloads.length,1);
  }finally{await rm(run,{recursive:true,force:true});}
});

test('collection checks ready status, meta, pointer, duration and byte identity; failures never register media',async()=>{
  for(const mode of ['pending','meta','pointer','oversize','duration','total-budget','hash','cancel','range']){
    const run=await mkdtemp(path.join(os.tmpdir(),'collection-reject-'));
    try{
      const f=fixture(run),abort=new AbortController();f.options.signal=abort.signal;
      if(mode==='pending')f.manifest.status='pending';
      if(mode==='meta')f.meta.source_url='https://x.com/other/status/1';
      if(mode==='pointer'){const read=f.options.readText;f.options.readText=async url=>url.endsWith('.mp4')?'invalid pointer':read(url);}
      if(mode==='oversize')f.source.expectedBytes=351*1024*1024;
      if(mode==='duration')f.meta.media[0].duration=301;
      if(mode==='total-budget')f.context.acquisitionUsage={videoSeconds:298,videoSources:1};
      if(mode==='range')f.source.end=6;
      if(['hash','cancel'].includes(mode))f.options.download=async(url,file)=>{await writeFile(file,mode==='hash'?'bad':f.bytes);if(mode==='cancel')abort.abort();};
      await assert.rejects(()=>collectRepository(f.context,f.options),undefined,mode);
      assert.equal(f.decodes,0);assert.ok(!(await readdir(run,{recursive:true})).some(name=>name.endsWith('.part')||name.endsWith('.json')));
    }finally{await rm(run,{recursive:true,force:true});}
  }
});

test('verified media-library bytes avoid a network transfer',async()=>{
  const run=await mkdtemp(path.join(os.tmpdir(),'collection-cache-'));
  try{
    const f=fixture(run),cache=path.join(run,'cached.mp4');await writeFile(cache,f.bytes);
    f.options.reuse=async()=>cache;
    const result=await collectRepository(f.context,f.options);assert.equal(f.downloads.length,0);
    assert.equal(JSON.parse(await readFile(result.sources[0].acquisitionReport)).method,'verified_cache');
  }finally{await rm(run,{recursive:true,force:true});}
});

test('single-source context excludes unrelated candidates and plans while discovery input remains unchanged',()=>{
  const source={id:'chosen',url:'https://example.org/chosen'};
  const context={source,knownSources:[source,...Array.from({length:80},(_,i)=>({id:'unrelated-'+i,url:'https://example.org/'+i,postText:'x'.repeat(16000)}))],selectedSources:[{id:'unrelated'}],plan:{script:'unrelated'},sourceReview:{events:[{source_ids:['chosen']},{source_ids:['unrelated']}]}};
  const result=scopedCollectionContext(context);
  assert.deepEqual(result.knownSources,[source]);assert.deepEqual(result.selectedSources,[]);assert.equal(result.plan,null);assert.equal(result.sourceReview.events.length,1);
  assert.equal(context.knownSources.length,81);assert.ok(JSON.stringify(result).length<JSON.stringify(context).length/100);
});

test('bounded transport rejects excessive responses and aborts stalled downloads',async()=>{
  const run=await mkdtemp(path.join(os.tmpdir(),'collection-transport-'));
  const server=http.createServer((req,res)=>{if(req.url==='/oversize')res.end(Buffer.alloc(12));else if(req.url==='/missing'){res.writeHead(404);res.end();}else{res.writeHead(200);res.write(Buffer.from([1]));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  try{
    await assert.rejects(()=>downloadRepositoryMedia(base+'/oversize',path.join(run,'oversize.part'),{bytes:4}),/超过预期|预期大小/);
    await assert.rejects(()=>downloadRepositoryMedia(base+'/missing',path.join(run,'missing.part'),{bytes:4}),/下载失败/);
    const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),30);
    await assert.rejects(()=>downloadRepositoryMedia(base+'/stalled',path.join(run,'cancel.part'),{bytes:4,signal:abort.signal}),/abort/i);clearTimeout(timer);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(run,{recursive:true,force:true});}
});
