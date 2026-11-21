import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const execute=promisify(execFile);
const rounded=number=>Math.round(number*1000)/1000;

export async function measureReference(ref, {directory, media} = {}) {
  const {probeMedia,frameAt,mediaTool}=media||await import('./media.mjs');
  const file=ref.path, meta=await probeMedia(file);
  if(ref.kind!==meta.kind) throw Error('参考文件与所选的媒体类型不一致');
  const evidence={referenceId:ref.id,sha256:ref.sha256};
  const facts={...evidence,kind:meta.kind,durationSeconds:rounded(meta.duration)};
  const rules=[],frames=[];
  if(meta.kind==='image'||meta.kind==='video') {
    facts.width=meta.width;facts.height=meta.height;
    const orientation=meta.width===meta.height?'方形':meta.width>meta.height?'横版':'竖版';
    rules.push({dimension:'visual',basis:'observed',evidence,instruction:`参考采用 ${meta.width} × ${meta.height} 的${orientation}画面。制作同画幅时可按代表帧安排视线与留白。`});
  }
  if(!['video','audio'].includes(meta.kind)||meta.duration<=0) return {facts,rules,frames};
  const ffmpeg=await mediaTool('ffmpeg');
  if(!ffmpeg) throw Error('读取参考片的可见变化需要本机 FFmpeg');
  const sampled=rounded(Math.min(45,meta.duration));
  const input=['-hide_banner','-nostdin','-nostats','-v','info','-t',String(sampled),'-protocol_whitelist','file','-i',file];
  const run=async args=>(await execute(ffmpeg,[...input,...args,'-f','null','-'],{timeout:65000,maxBuffer:2*1024*1024})).stderr;
  facts.sampledInterval={start:0,end:sampled};
  if(meta.kind==='video') {
    const log=await run(['-an','-vf',"setpts=PTS-STARTPTS,fps=4,scale=256:-2,select='gt(scene,0.32)',showinfo"]);
    facts.strongChangeSeconds=Array.from(log.matchAll(/\bpts_time:\s*([\d.]+)/g),m=>Number(m[1])).filter(t=>t>0&&t<sampled);
    const changes=facts.strongChangeSeconds;
    if(changes.length>=2) {
      const gaps=changes.slice(1).map((v,i)=>v-changes[i]).sort((a,b)=>a-b);
      facts.medianChangeIntervalSeconds=rounded((gaps[Math.floor((gaps.length-1)/2)]+gaps[Math.floor(gaps.length/2)])/2);
      rules.push({dimension:'motion',basis:'measured',evidence:{...evidence,interval:facts.sampledInterval,changeSeconds:changes},instruction:`在开头 ${sampled} 秒内观察到 ${changes.length} 处较大的画面变化，其间隔中位数为 ${facts.medianChangeIntervalSeconds} 秒。排节奏时先对照这些时间点核实切镜、动作或闪光。`});
    }
    const lastSafe=Math.max(0,meta.duration-(meta.frames?2*meta.duration/meta.frames:.2));
    for(const time of new Set([0,rounded(Math.min(lastSafe,meta.duration*.48)),rounded(Math.min(lastSafe,meta.duration*.82))])) {
      const output=path.join(directory,'frame-'+frames.length+'.jpg');
      await frameAt(file,time,output,{maxWidth:960});
      frames.push({file:output,time});
    }
  }
  if(meta.hasAudio) {
    const levels=await run(['-vn','-af','volumedetect']);
    const value=name=>{const m=levels.match(new RegExp(name+'\\s*:\\s*(-?[\\d.]+) dB'));return m?Number(m[1]):null;};
    facts.soundLevel={meanDb:value('mean_volume'),peakDb:value('max_volume')};
  }
  return {facts,rules,frames};
}
