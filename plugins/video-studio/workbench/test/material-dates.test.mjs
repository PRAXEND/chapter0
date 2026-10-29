import test from 'node:test';
import assert from 'node:assert/strict';
import {dateKey,inDateWindow,sortMaterials,dayLabel} from '../public/material-dates.js';

test('recent calendar windows use publication date in Singapore, never cache or batch date',()=>{
  const now=Date.parse('2026-10-28T04:00:00Z');
  assert.equal(dateKey('2026-10-27T18:00:00Z'),'2026-10-28');
  assert.equal(dateKey('2026-02-30'),'');assert.equal(dateKey('yesterday'),'');
  assert.equal(inDateWindow({publishedAt:'2026-10-26'},'3',now),true);
  assert.equal(inDateWindow({publishedAt:'2026-10-25',cachedAt:'2026-10-28',batchDate:'2026-10-28'},'3',now),false);
  assert.equal(inDateWindow({publishedAt:'2026-10-22'},'7',now),true);
  assert.equal(inDateWindow({publishedAt:'2026-10-21'},'7',now),false);
  assert.equal(inDateWindow({publishedAt:'2026-10-29'},'7',now),false);
  assert.equal(inDateWindow({publishedAt:'',batchDate:'2026-10-28'},'unknown',now),true);
  assert.equal(inDateWindow({publishedAt:'',batchDate:'2026-10-28'},'7',now),false);
  assert.equal(dayLabel('2026-10-28',now),'2026-10-28 · 今天');
  assert.deepEqual(sortMaterials([{publishedAt:''},{publishedAt:'2026-10-21'},{publishedAt:'2026-10-28'}]).map(s=>s.publishedAt),['2026-10-28','2026-10-21','']);
});
