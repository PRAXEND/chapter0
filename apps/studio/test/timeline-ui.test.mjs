import test from 'node:test';
import assert from 'node:assert/strict';
import {snapPosition, trackRows, timecode, parseTimecode} from '../www/timeline.js';

test('moving either edge snaps in project frames at any zoom, bounded by the source window',()=>{
  const held=snapPosition(21,[0,18],[4,40],2,0,55);
  assert.deepEqual(held,{value:22,guide:40});
  assert.deepEqual(snapPosition(24.5,[0,18],[4,40],2,0,55,held),held);
  assert.deepEqual(snapPosition(25.5,[0,18],[4,40],2,0,55,held),{value:26,guide:null});
  assert.deepEqual(snapPosition(-3,[0],[1],8,4,20),{value:4,guide:null});
});
test('overlapping effects stay individually selectable, touching intervals share a row',()=>{
  const a=[{id:'long',start:0,duration:8},{id:'above',start:3,duration:2},{id:'next',start:5,duration:4}];
  const {count,rows}=trackRows(a);
  assert.equal(count,2);assert.deepEqual([...rows.values()],[0,1,1]);
});
test('frame entry and timecodes round-trip across hour boundaries at supported frame rates',()=>{
  for(const fps of [24,25,30,60])for(const n of [0,fps-1,fps,3601*fps+1])assert.equal(parseTimecode(timecode(n,fps),fps),n);
  assert.equal(parseTimecode('103',30),103);assert.equal(parseTimecode('00:00:06:30',30),null);
  assert.equal(parseTimecode('garbage',30),null);
});
