import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile } from 'node:fs/promises';
import { ffBase, inputArgs, requiredTool, run } from './media-runtime.mjs';
import { fileHash, probeMedia } from './media.mjs';
const execute=promisify(execFile);

export async function paceNarration(base,output,speed,generated,{signal}={}) {
  if(!Number.isFinite(speed)||speed<.5||speed>2)throw Error('旁白语速超出本地保音高范围。');
  const baseInfo=await probeMedia(base,{signal});
  const prior=Number(generated?.speechRate||1);
  if(prior!==1&&Math.abs(prior-speed)>.0001)throw Error('语音生成器已应用不同速率，无法核实原始时长。');
  const change=prior===1 && speed!==1;
  if(change) await run(await requiredTool('ffmpeg'),[...ffBase,...inputArgs(base),'-map','0:a:0','-af','atempo='+speed,'-c:a','pcm_s16le',output],{signal});
  else await copyFile(base,output);
  const final=await probeMedia(output,{signal});
  if(!final.hasAudio||!(final.duration>0))throw Error('保音高变速后旁白为空。');
  return {...generated,sha256:await fileHash(output),baseSha256:await fileHash(base),duration:final.duration,
    baseDuration:prior===1?baseInfo.duration:(generated?.baseDuration??null),speechRate:speed,
    tempoMethod:change?'ffmpeg-atempo-once':(generated?.tempoMethod||'native')};
}

export async function measureLoudness(file,{start=0,duration=30,signal}={}) {
  if(!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<=0)return null;
  const ffmpeg=await requiredTool('ffmpeg');
  const {stderr}=await execute(ffmpeg,['-hide_banner','-nostdin','-nostats','-loglevel','info','-ss',String(start),
    ...inputArgs(file),'-t',String(Math.min(90,duration)),'-map','0:a:0','-vn','-af','aformat=channel_layouts=stereo,ebur128=framelog=verbose',
    '-f','null','-'],{signal,timeout:25000,maxBuffer:768*1024});
  const matches=[...stderr.matchAll(/\bI:\s*(-?[0-9]+(?:\.[0-9]+)?) LUFS/g)];
  const level=Number(matches.at(-1)?.[1]);
  return Number.isFinite(level)&&level>-69?level:null;
}
