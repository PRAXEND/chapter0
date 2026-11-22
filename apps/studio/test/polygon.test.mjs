import test from 'node:test';
import assert from 'node:assert/strict';
import {validateClip} from '../src/project.mjs';
import {createAss} from '../src/text-tracks.mjs';
import {execFile} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {promisify} from 'node:util';
import {mediaCapabilities,renderProject} from '../src/media.mjs';

test('an editable cross-section keeps its teeth in the shared preview and export composition', () => {
  const profile = {width: 400, height: 200, fps: 25};
  const points = [[0,0],[1,0],[1,.3],[.7,.3],[.65,1],[.3,1],[.25,.3],[0,.3]];
  const layer = {id:'tread',track:'graphic',text:'',shape:'polygon',start:0,duration:24,
    geometry:{x:.5,y:.5,width:.5,height:.5,points},
    keyframes:[{frame:12,y:.6}]};
  validateClip(layer,{profile});
  const ass = createAss([layer],profile);
  assert.match(ass,/m 0 0 l 200 0 200 30 140 30 130 100 60 100 50 30 0 30/);
  assert.match(ass,/move\(100,50,100,70/);
  for(const invalid of [[[0,0],[.0004,0],[0,.0004]], [[0,0],[.003,0],[0,.004]], [[0,0],[.5,.5],[1,1]],[[0,0],['1',0],[0,1]],[[0,0],[2,0],[0,1]]]){
    assert.throws(()=>validateClip({...layer,geometry:{...layer.geometry,points:invalid}},{profile}),/轮廓/);
  }
});

test('inset polygon pixels follow their full local box through movement, scaling and a preview window',async t=>{
  const {ffmpeg,ready}=await mediaCapabilities();
  if(!ready)return t.skip('requires FFmpeg and ffprobe');
  const directory=await mkdtemp(path.join(os.tmpdir(),'studio-inset-polygon-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const profile={width:320,height:160,fps:24}, project={profile,assets:[],revision:1,timeline:{clips:[{
    id:'inset',track:'graphic',shape:'polygon',text:'',start:0,duration:12,style:{color:'#ffffff'},
    geometry:{x:.5,y:.5,width:.5,height:.5,points:[[.6,.2],[1,.2],[1,.8],[.6,.8]]},
    keyframes:[{frame:0,scale:1},{frame:10,x:.6,y:.5,scale:1.5}],
  }]}};
  const expected=new Map([[0,[176,239,56,103]],[5,[196,275,50,109]],[11,[216,311,44,115]]]);
  for(const preview of [false,true]){
    const first=preview?5:0, output=path.join(directory,preview?'window.mp4':'whole.mp4');
    await renderProject(project,{directory,output,preview,...(preview&&{window:{fromFrame:first,toFrame:12}})});
    const {stdout}=await promisify(execFile)(ffmpeg,['-v','error','-i',output,'-f','rawvideo','-pix_fmt','gray','pipe:1'],{encoding:'buffer',maxBuffer:1024*1024});
    const {width,height}=profile;
    assert.equal(stdout.length,(12-first)*width*height);
    for(const [frame,wanted] of expected){
      if(frame<first)continue;
      let left=width,right=-1,top=height,bottom=-1;
      const offset=(frame-first)*width*height;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(stdout[offset+y*width+x]>210){
        left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      }
      const observed=[left,right,top,bottom];
      assert.ok(observed.every((v,i)=>Math.abs(v-wanted[i])<=1),
        'frame '+frame+' bounds '+observed+' expected '+wanted+' (preview '+preview+')');
    }
  }
});
