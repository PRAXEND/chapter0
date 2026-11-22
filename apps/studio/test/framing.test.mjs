import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mediaCapabilities,renderProject} from '../src/media.mjs';
import {validFraming} from '../src/framing.mjs';

const exec=promisify(execFile);
test('source focus rejects out-of-range coordinates and zoom',()=>{
  assert.ok(validFraming({from:{x:0,y:1,zoom:4}}));
  assert.equal(validFraming({from:{x:0,y:1,zoom:0}}),false);
  assert.equal(validFraming({from:{x:.5,y:.5,zoom:2},to:{x:2,y:.5,zoom:2}}),false);
});

test('registered before and after plates can be compared at the same wipe position in a preview',async t=>{
  const {ffmpeg,ready}=await mediaCapabilities();
  if(!ready)return t.skip('ffmpeg and ffprobe required');
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-compare-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const profile={width:96,height:64,fps:12};
  const assets=[];
  for(const color of ['red','blue']){
    const file=path.join(dir,color+'.png');
    await exec(ffmpeg,['-loglevel','error','-f','lavfi','-i','color='+color+':s=96x64','-frames:v','1',file]);
    assets.push({id:color,path:file});
  }
  const clips=[{id:'before',track:'video',assetId:'red',start:0,duration:14},
    {id:'after',track:'video',assetId:'blue',start:2,duration:12,transition:{type:'wipe-right',duration:10}}];
  const project={profile,assets,revision:1,timeline:{clips}};
  for(const preview of [false,true]){
    const out=path.join(dir,preview?'excerpt.mp4':'full.mp4');
    await renderProject(project,{directory:dir,output:out,...(preview&&{window:{fromFrame:6,toFrame:9}})});
    const {stdout}=await exec(ffmpeg,['-loglevel','error','-ss',String((preview?0:6)/12),'-i',out,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer'});
    const pixel=x=>stdout.subarray(3*(32*96+x),3*(32*96+x)+3);
    assert.ok(pixel(15)[2]>200 && pixel(15)[0]<40,'changed side shows blue');
    assert.ok(pixel(80)[0]>200 && pixel(80)[2]<40,'original side stays red');
  }
});

test('an offset source detail stays behind a hollow evidence marker in full and excerpt renders',async t=>{
  const {ffmpeg,ready}=await mediaCapabilities();
  if(!ready)return t.skip('ffmpeg and ffprobe required');
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-focus-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.png');
  await exec(ffmpeg,['-v','error','-f','lavfi','-i','color=black:s=320x160',
    '-vf','drawbox=x=39:y=64:w=36:h=32:c=red:t=fill,drawbox=x=226:y=64:w=28:h=32:c=lime:t=fill',
    '-frames:v','1',source]);
  const profile={width:96,height:96,fps:12};
  const focus={from:{x:.18,y:.5,zoom:1.5},to:{x:.75,y:.5,zoom:2.5}};
  const project={profile,revision:1,assets:[{id:'source',path:source}],timeline:{clips:[
    {track:'video',id:'detail',start:0,duration:10,assetId:'source',framing:focus},
    {track:'graphic',id:'look',start:0,duration:10,text:'',shape:'outline',geometry:{x:.5,y:.5,width:.5,height:.5},style:{color:'#ffffff',strokeWidth:4}},
    {track:'graphic',id:'tiny',start:8,duration:2,text:'',shape:'outline',geometry:{x:.5,y:.5,width:.1,height:.1},style:{color:'#ffffff',strokeWidth:32}}
  ]}};
  const full=await renderProject(project,{directory:dir,output:path.join(dir,'full.mp4')});
  const part=await renderProject(project,{directory:dir,output:path.join(dir,'part.mp4'),window:{fromFrame:5,toFrame:10}});
  async function pixels(file,n){
    const {stdout}=await exec(ffmpeg,['-v','error','-i',file,'-vf',`select=eq(n\\,${n})`,'-frames:v','1','-an','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer'});
    return stdout;
  }
  const [first,last,excerpt,mid,excerptStart]=await Promise.all([
    pixels(full.videoPath,0),pixels(full.videoPath,9),pixels(part.videoPath,4),pixels(full.videoPath,5),pixels(part.videoPath,0)]);
  const at=(frame,x,y)=>[...frame.subarray(3*(y*96+x),3*(y*96+x)+3)];
  assert.ok(at(first,48,48)[0]>200 && at(first,48,48)[1]<35,'opening focus shows the red source feature');
  for(const frame of [last,excerpt]) {
    assert.ok(at(frame,48,48)[1]>205 && at(frame,48,48)[0]<40,'closing focus shows the green feature through the marker');
    assert.ok(at(frame,26,48).every(v=>v>185),'white outline surrounds the feature');
  }
  const mae=mid.reduce((sum,v,i)=>sum+Math.abs(v-excerptStart[i]),0)/mid.length;
  assert.ok(mae<5,`excerpt uses the same animation clock (mean pixel error ${mae})`);
});
