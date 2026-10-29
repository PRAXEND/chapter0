import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {MediaLibrary,candidateId} from '../library.mjs';
import {findPlugin,createPluginBridge} from '../plugin.mjs';
import {fileHash} from '../media.mjs';

const execute=promisify(execFile),app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('cache survives original-run removal, deduplicates real media and refuses tampered or escaped files',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'media-library-test-'));
  try{
    const plugin=await findPlugin(app),bridge=createPluginBridge(plugin,path.join(temp,'requests'));
    const inspect=file=>bridge('inspect-media',{file});
    const run=path.join(temp,'run');await mkdir(run);const file=path.join(run,'real-diagnostic-fixture.mp4');
    await execute('ffmpeg',['-v','error','-f','lavfi','-i','color=c=green:s=160x90:r=30','-t','1','-c:v','libx264','-pix_fmt','yuv420p',file]);
    const source={id:'actual-source',title:'Diagnostic fixture only',localPath:file,sha256:await fileHash(file),url:'https://example.org/original',rights:'unknown'};
    const library=await new MediaLibrary(path.join(temp,'library'),inspect).init();
    const saved=await library.remember(source,run);await library.remember({...source,id:'same-content'},run);
    assert.equal((await library.list()).length,1);assert.equal(saved.origins.length,2);
    await rm(run,{recursive:true});
    const reopened=await new MediaLibrary(library.directory,inspect).init();const cached=await reopened.resolve(saved.id);
    assert.equal(await fileHash(cached.file),source.sha256);assert.equal((await reopened.list())[0].availability,'available');
    const escaped=path.join(temp,'external.mp4');await writeFile(escaped,'outside');await symlink(escaped,path.join(library.directory,'escape.mp4'));
    reopened.entries[0].localPath=path.join(library.directory,'escape.mp4');await assert.rejects(()=>reopened.resolve(saved.id));
    reopened.entries[0].localPath=cached.file;
    const bytes=await readFile(cached.file);bytes[bytes.length-1]^=1;await writeFile(cached.file,bytes);
    await assert.rejects(()=>reopened.resolve(saved.id),/变化/);assert.equal((await reopened.list())[0].availability,'changed');
    await rm(cached.file);assert.equal((await reopened.list())[0].availability,'missing');
  }finally{await rm(temp,{recursive:true,force:true});}
});

test('candidate metadata survives restart and repeated searches without inspecting or downloading media',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'candidate-cache-test-'));
  try{
    let mediaCalls=0;const inspect=async()=>{mediaCalls++;throw new Error('metadata-only cache must not inspect media');};
    const library=await new MediaLibrary(temp,inspect).init();
    const source={id:'a',kind:'video',title:'Actual source record',url:'https://example.org/video#chapter',thumbnailUrl:'https://example.org/thumbnail.jpg',localPath:'/not-a-local-asset.mp4',description:'Known source facts',rights:'unknown'};
    const contexts=[{jobId:'first',topic:'第一期',query:'任务动作',reviewedAt:'2026-10-27T01:00:00Z',events:[{event_id:'event',source_ids:['a'],decision:'top5',reason:'具体理由'}]},
      {jobId:'second',topic:'第二期',query:'比较案例',reviewedAt:'2026-10-28T01:00:00Z'}];
    await library.rememberCandidates([source],contexts[0]);await library.rememberCandidates([{...source,url:'https://example.org/video'}],contexts[1]);
    assert.equal(library.candidates.length,1);assert.equal(library.candidates[0].origins.length,2);assert.equal(library.candidates[0].localPath,'');assert.equal(library.candidates[0].status,'candidate');assert.equal(mediaCalls,0);
    const reopened=await new MediaLibrary(temp,inspect).init();assert.equal((await reopened.candidateList())[0].localCacheIds.length,0);assert.equal(reopened.entries.length,0);
    assert.equal(reopened.candidates[0].origins.find(o=>o.jobId==='first').reason,'具体理由');
    await reopened.rememberCandidates([{...source,url:'file:///private/file'},{...source,url:'http://127.0.0.1/private'}]);assert.equal(reopened.candidates.length,1);
    assert.equal(candidateId(source),candidateId({...source,url:'https://example.org/video'}));
  }finally{await rm(temp,{recursive:true,force:true});}
});

test('historical search reports backfill candidates without resurrecting unreturned research probes',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'candidate-history-test-'));
  try{
    const run=path.join(temp,'runs','old-run');await mkdir(path.join(run,'source-searches'),{recursive:true});
    await writeFile(path.join(run,'run.json'),JSON.stringify({brief:{topic:'旧题材',style:null},sources:[{id:'probe',kind:'video',title:'Internal probe',url:'https://example.org/probe'}]}));
    const source={id:'returned',kind:'article',title:'Returned candidate',url:'https://example.org/returned',description:'未采集的真实候选'};
    await writeFile(path.join(run,'source-searches','job.json'),JSON.stringify({topic:'旧题材',query:'实际检索',reviewed_at:'2026-10-27T01:00:00Z',sources:[source]}));
    const library=await new MediaLibrary(path.join(temp,'cache'),()=>{throw new Error('must not download');}).init();
    await library.backfill(path.join(temp,'runs'));await library.backfill(path.join(temp,'runs'));
    assert.equal(library.candidates.length,1);assert.equal(library.candidates[0].title,source.title);assert.equal(library.candidates[0].origins.length,1);assert.equal(library.candidates[0].lastSeenAt,'2026-10-27T01:00:00.000Z');
    await library.markAcquisition(library.candidates[0].id,{id:'collect-one',status:'failed',error:'源链接不可用'});
    const reopened=await new MediaLibrary(library.directory,()=>{}).init();assert.equal(reopened.candidates[0].acquisition.status,'failed');assert.equal(reopened.candidates[0].acquisition.error,'源链接不可用');
  }finally{await rm(temp,{recursive:true,force:true});}
});

test('scoped search preserves full catalog media only within the same repository snapshot',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'candidate-detail-test-'));
  try{
    const library=await new MediaLibrary(temp,()=>{}).init();
    const full={id:'entry',title:'Recorded candidate',kind:'video',url:'https://x.com/example/status/1',repositoryCommit:'a'.repeat(40),batchDate:'2026-10-28',collectedAt:'2026-10-28T09:00:00+08:00',postText:'Original full post',repositoryMedia:[{file:'2026/2026-10-28/001/videos/01.mp4',type:'video',sha256:'b'.repeat(64),bytes:100}]};
    await library.rememberCandidates([full],{reviewedAt:'2026-10-28T01:00:00Z'});
    const scoped={id:'entry',title:full.title,kind:'video',url:full.url,repositoryCommit:full.repositoryCommit,repositoryMedia:[],postText:''};
    await library.rememberCandidates([scoped],{reviewedAt:'2026-10-28T02:00:00Z'});
    assert.equal(library.candidates[0].repositoryMedia.length,1);assert.equal(library.candidates[0].postText,full.postText);assert.equal(library.candidates[0].batchDate,full.batchDate);
    await library.rememberCandidates([{...scoped,repositoryCommit:'c'.repeat(40)}],{reviewedAt:'2026-10-28T03:00:00Z'});
    assert.equal(library.candidates[0].repositoryMedia.length,0);assert.equal(library.candidates[0].postText,'');
  }finally{await rm(temp,{recursive:true,force:true});}
});
