import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {requiredTool} from '../src/media-runtime.mjs';
import {portraitEnding,portraitGraph,portraitLayout,portraitScript} from '../src/presentation.mjs';

const project={profile:{width:120,height:216,fps:24},style:{id:'henry-hot-news',version:8},title:'动作与原声',
  timeline:{clips:[{id:'caption',track:'caption',start:0,duration:90,text:'全幅淡出'}]}};
const layout=portraitLayout(project);

// The previously shipped filter evaluated this expression on every sample of every frame.
function originalGraph(from,total){
  const {width,height,fps}=project.profile,{black,fade}=portraitEnding(total,fps);
  const t='clip((N-1+'+from+'-'+fade+')/'+Math.max(1,black-fade)+',0,1)';
  return 'color=c=0x030405:s='+width+'x'+height+':r='+fps+',settb=1/'+fps+',setpts=N+'+from+
    ',ass=portrait.ass:fontsdir=fonts,setpts=N[paper];[paper][0:v]overlay=x=0:y='+layout.top+
    ':shortest=1[stage];[stage]split[f][b];[b]drawbox=c=black:t=fill[black];[f][black]blend=all_expr=\''+
    'A*(1-('+t+')*('+t+')*(3-2*('+t+')))+B*('+t+')*('+t+')*(3-2*('+t+'))\':shortest=1[outportrait]';
}

test('portrait skips the pixel expression for unchanged windows and the final black hold',()=>{
  const total=90,{fade,black}=portraitEnding(total,project.profile.fps);
  const graph=(from,to)=>portraitGraph(project,layout,'[0:v]',from,total,to);
  assert.doesNotMatch(graph(0,fade+1),/blend=|drawbox=/);
  assert.doesNotMatch(graph(fade,fade+1),/blend=|drawbox=/);
  assert.doesNotMatch(graph(black,total),/blend=/);
  assert.match(graph(black,total),/drawbox=c=black:t=fill/);
  assert.match(graph(0,total),new RegExp("enable='between\\(n,"+(fade+1)+','+(black-1)+"\\)'"));
});

test('actual frame hashes match the shipped fade at both boundaries, during a window and across a full portrait',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-fade-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await symlink(fileURLToPath(new URL('../src/fonts/',import.meta.url)),path.join(dir,'fonts'));
  const ffmpeg=await requiredTool('ffmpeg'), {width,fps}=project.profile;
  function hashes(graph,from,to){
    const picture='testsrc2=size='+width+'x'+layout.contentHeight+':rate='+fps+
      ',trim=start_frame='+from+':end_frame='+to+',setpts=PTS-STARTPTS';
    const lines=execFileSync(ffmpeg,['-nostdin','-v','error','-filter_complex_threads','2','-f','lavfi','-i',picture,
      '-filter_complex',graph,'-map','[outportrait]','-frames:v',String(to-from),'-threads','1',
      '-pix_fmt','yuv420p','-f','framehash','pipe:1'],{cwd:dir,encoding:'utf8'});
    return lines.split('\n').filter(s=>s.startsWith('0,')).map(s=>s.split(',').at(-1).trim());
  }
  for(const total of [90,2,1]){
    await writeFile(path.join(dir,'portrait.ass'),portraitScript(project,layout,0,total,total));
    const reference=hashes(originalGraph(0,total),0,total);
    assert.equal(reference.length,total);
    const {fade,black}=portraitEnding(total,fps);
    const ranges=total>2?[[0,total],[0,fade+1],[fade,fade+1],[fade-2,fade+4],
      [fade+6,fade+11],[black-3,black+4],[black,total]]:[[0,total],[total-1,total]];
    for(const [from,to] of ranges){
      await writeFile(path.join(dir,'portrait.ass'),portraitScript(project,layout,from,to,total));
      const actual=hashes(portraitGraph(project,layout,'[0:v]',from,total,to),from,to);
      assert.deepEqual(actual,reference.slice(from,to),'frames ['+from+','+to+') of '+total);
    }
  }
});
