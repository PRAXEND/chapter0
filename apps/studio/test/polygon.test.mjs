import test from 'node:test';
import assert from 'node:assert/strict';
import {validateClip} from '../src/project.mjs';
import {createAss} from '../src/text-tracks.mjs';

test('an editable cross-section keeps its teeth in the shared preview and export composition', () => {
  const profile = {width: 400, height: 200, fps: 25};
  const points = [[0,0],[1,0],[1,.3],[.7,.3],[.65,1],[.3,1],[.25,.3],[0,.3]];
  const layer = {id:'tread',track:'graphic',text:'',shape:'polygon',start:0,duration:24,
    geometry:{x:.5,y:.5,width:.5,height:.5,points},
    keyframes:[{frame:12,y:.6}]};
  validateClip(layer,{profile});
  const ass = createAss([layer],profile);
  assert.match(ass,/m 0 0 l 200 0 200 30 140 30 130 100 60 100 50 30 0 30/);
  assert.match(ass,/move\(200,100,200,120/);
  for(const invalid of [[[0,0],[.5,.5],[1,1]],[[0,0],['1',0],[0,1]],[[0,0],[2,0],[0,1]]]){
    assert.throws(()=>validateClip({...layer,geometry:{...layer.geometry,points:invalid}},{profile}),/轮廓/);
  }
});
