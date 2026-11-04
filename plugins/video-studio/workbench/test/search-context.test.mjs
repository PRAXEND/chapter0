import test from 'node:test';
import assert from 'node:assert/strict';
import {searchContext} from '../search-context.mjs';
import {initialStudio,validateSettings,updateSettings,inputHash,taskPrompt} from '../studio-workflow.mjs';

test('topic fallback trims blanks; explicit query preserves topic, limit and date context',()=>{
 const p={...initialStudio(),topic:'最近一周机器人落地困难',searchLimit:7};
 const a=searchContext(p,{query:'  '},{},new Date('2026-11-01T18:00:00Z'));
 assert.equal(a.query,p.topic);assert.equal(a.searchLimit,7);assert.equal(a.searchClock.localDate,'2026-11-02');
 assert.equal(searchContext(p,{query:'  灵巧手  ',searchLimit:3},{}).query,'灵巧手');
 assert.equal(p.topic,'最近一周机器人落地困难');
});
test('search count validates integer bounds and persists without invalidating creative approval',()=>{
 const p=initialStudio();const before=inputHash(p);p.approval={confirmed:true};
 updateSettings(p,validateSettings({...p,searchLimit:8}));assert.equal(p.searchLimit,8);assert.equal(inputHash(p),before);assert.ok(p.approval);
 for(const searchLimit of ['',0,-1,1.5,81,'abc'])assert.throws(()=>validateSettings({...p,searchLimit}),/搜索数量/);
 updateSettings(p,validateSettings({...p,topic:'新的观点'}));assert.equal(p.approval,null);
});
test('cache is bounded, deduplicated, date-bearing and explicitly possibly stale',()=>{
 const rows=Array.from({length:100},(_,i)=>({url:'https://example.org/'+i,title:'item '+i,publishedAt:'2026-10-30',collectedAt:'2026-11-01',localPath:'/private/irrelevant',postText:'x'.repeat(16000)}));
 const c=searchContext({topic:'今天',searchLimit:5},{},{candidates:rows,entries:[rows[0]],repositorySync:{checkedAt:'2026-10-30'}});
 assert.equal(c.cachedCandidates.length,80);assert.equal(new Set(c.cachedCandidates.map(x=>x.url)).size,80);assert.equal(c.cacheCoverage.mayBeStale,true);
 assert.equal(c.cachedCandidates[0].localPath,undefined);assert.equal(c.cachedCandidates[0].collectedAt,'2026-11-01');
 const prompt=taskPrompt('discover',{brief:{topic:'今天'},...c});
 assert.match(prompt,/online search/);assert.match(prompt,/NOT event\/publication dates/);assert.match(prompt,/context.searchLimit/);
});
