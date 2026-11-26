import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {audioDecode,buildVisualInput,mediaTool,probeMedia} from '../src/media.mjs';
import {ffBase,inputArgs} from '../src/media-runtime.mjs';
import {timelineCommands} from '../src/clip-edit.mjs';

// Use the existing reference if it is installed. Output consists solely of
// frame checksums and raw audio in memory; no footage is generated or saved.
async function referenceFile(){
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  const file=path.join(root,'user-packs/henry-video-styles/media/benchmarks/technical-explainer.mp4');
  if((await stat(file)).size>256)return file;
  const hash=(await readFile(file,'utf8')).match(/oid sha256:([a-f0-9]{64})/)?.[1];
  if(!hash)return null;
  const git=execFileSync('git',['-C',root,'rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim();
  const object=path.join(git,'lfs','objects',hash.slice(0,2),hash.slice(2,4),hash);
  return await stat(object).then(()=>object,()=>null);
}

test('existing Atlas footage: a 1.25× split yields identical decoded pictures and 48 kHz audio across the cut',async t=>{
  const file=await referenceFile(),exe=await mediaTool('ffmpeg');
  if(!file||!exe||!await mediaTool('ffprobe')){t.skip('需要本机已安装的 Atlas 基准片及 FFmpeg');return;}
  const asset={id:'atlas',path:file,...await probeMedia(file)},profile={width:160,height:90,fps:30};
  const original={id:'part',track:'video',assetId:'atlas',sourceIn:242,start:12,speed:1.25,duration:44,gain:.6};
  const project={assets:[asset],profile,timeline:{clips:[original]}};
  const [leftCommand,rightCommand]=[...timelineCommands([{op:'split',id:'part',atFrame:25,newId:'tail'}],project)];
  const left={...original,...leftCommand.changes},right=rightCommand.clip;
  assert.equal(right.sourceIn,258.25);assert.ok(asset.hasAudio);
  const ff=(args)=>execFileSync(exe,[...ffBase,...args],{maxBuffer:8*1024*1024});
  function pictures(clip){
    const {args,chain}=buildVisualInput(clip,{start:clip.start,duration:clip.duration},asset,profile,0);
    return ff([...args,'-filter_complex',chain,'-map','[v0]','-an','-f','framemd5','pipe:1'])
      .toString().split('\n').filter(line=>/^0,/.test(line)).map(line=>line.split(',').at(-1).trim());
  }
  function sound(clip){
    const {source,filter}=audioDecode(clip,profile.fps,clip.start,clip.start+clip.duration);
    return ff(['-ss',String(Number(source.toFixed(7))),...inputArgs(file),'-map','0:a:0','-vn','-af',filter,
      '-ar','48000','-ac','2','-c:a','pcm_f32le','-f','f32le','pipe:1']);
  }
  const frames=pictures(original),pcm=sound(original);
  assert.equal(frames.length,44);assert.ok(new Set(frames).size>5);
  assert.deepEqual([...pictures(left),...pictures(right)],frames);
  assert.equal(pcm.length,70400*2*4);assert.ok(pcm.some(n=>n!==0));
  assert.ok(Buffer.concat([sound(left),sound(right)]).equals(pcm));
  t.diagnostic('44 decoded frame checksums and 70,400 stereo sample pairs match across the cut.');
});
