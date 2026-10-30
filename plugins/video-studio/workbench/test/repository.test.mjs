import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {repositoryCatalog} from '../repository.mjs';
import {MediaLibrary,candidateMatchesMedia} from '../library.mjs';

test('full repository catalog reads all ready metadata beyond 12, pins one commit and skips pending media',async()=>{
  const commit='a'.repeat(40),files=new Map(),calls=[];
  for(const name of ['README.md','AGENTS.md'])files.set(name,'Reference data only.');
  for(const name of ['manifest','meta'])files.set(`schema/${name}.schema.json`,JSON.stringify({type:'object'}));
  const folder='2026/2026-10-28',items=Array.from({length:15},(_,i)=>({id:String(i+1).padStart(3,'0')}));
  files.set(folder+'/manifest.json',JSON.stringify({schema_version:2,date:'2026-10-28',status:'ready',items}));
  files.set('2026/2026-10-29/manifest.json',JSON.stringify({schema_version:2,date:'2026-10-29',status:'pending',items:[{id:'001'}]}));
  for(const item of items){
    const base=folder+'/'+item.id;files.set(base+'/post.md','原帖内容及限制');
    files.set(base+'/meta.json',JSON.stringify({schema_version:2,id:item.id,date:'2026-10-28',title:'待核实原帖 '+item.id,summary:'原始摘要',source:'账号',source_url:'https://x.com/example/status/'+item.id,published_at:item.id==='001'?null:'2026-10-27T23:00:00+08:00',collected_at:'2026-10-28T09:00:00+08:00',verify_status:'unverified',verification:['事实未复核'],media:[{file:'videos/01.mp4',type:'video',bytes:123,sha256:'b'.repeat(64),w:1080,h:1920,duration:8}]}));
    files.set(base+'/videos/01.mp4','not read');
  }
  const read=async endpoint=>{
    calls.push(endpoint);if(endpoint==='commits/HEAD')return {sha:commit};
    if(endpoint===`git/trees/${commit}?recursive=1`)return {truncated:false,tree:[...files.keys()].map(p=>({type:'blob',path:p}))};
    assert.ok(endpoint.endsWith('?ref='+commit));const p=endpoint.slice(9,-('?ref='+commit).length);assert.ok(!p.endsWith('.mp4'));assert.ok(!p.includes('2026-10-29/001'));
    return {encoding:'base64',content:Buffer.from(files.get(p)).toString('base64')};
  };
  const {sources,coverage}=await repositoryCatalog(read,new Date('2026-10-28T04:00:00Z'));
  assert.equal(sources.length,15);assert.equal(coverage.batches.length,2);assert.equal(coverage.errors.length,0);
  assert.equal(sources[0].publishedAt,'');assert.equal(sources[0].batchDate,'2026-10-28');assert.equal(sources[1].publishedAt,'2026-10-27T23:00:00+08:00');
  assert.equal(sources[0].expectedBytes,123);assert.equal(sources[0].postText,'原帖内容及限制');assert.equal(sources[0].repositoryCommit,commit);
  const temp=await mkdtemp(path.join(os.tmpdir(),'catalog-test-'));
  try{
    const library=await new MediaLibrary(temp,()=>{throw new Error('must not inspect media');}).init();
    await library.rememberCandidates(sources,{query:'每日仓库完整目录',reviewedAt:coverage.checkedAt});library.repositorySync=coverage;await library.persist();
    await library.rememberCandidates(sources,{query:'每日仓库完整目录',reviewedAt:coverage.checkedAt});
    const reopened=await new MediaLibrary(temp,()=>{}).init();assert.equal(reopened.candidates.length,15);assert.equal(reopened.entries.length,0);assert.equal(reopened.repositorySync.sourceCount,15);assert.equal(reopened.candidates[0].repositoryMedia.length,1);
    assert.equal(candidateMatchesMedia(reopened.candidates[0],{url:sources[0].url,sha256:'b'.repeat(64),bytes:123,repositoryCommit:'c'.repeat(40)}),true);
    assert.equal(candidateMatchesMedia(reopened.candidates[0],{candidateIds:[reopened.candidates[0].id],url:sources[0].url,sha256:'d'.repeat(64),bytes:123}),false);
  }finally{await rm(temp,{recursive:true,force:true});}
  assert.ok(calls.some(p=>p.includes('015/post.md')));
  await assert.rejects(()=>repositoryCatalog(async p=>p==='commits/HEAD'?{sha:commit}:{truncated:true}),/目录不完整/);
});
