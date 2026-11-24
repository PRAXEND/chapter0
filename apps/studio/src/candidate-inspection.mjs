import {realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileHash} from './media.mjs';

// Feedback is technical data. Keep local files, credentials and user utterances
// out of the model projection unless the project explicitly shares transcripts.
export function candidateFeedback(input,shareTranscript) {
  let remaining=36000;
  function clean(value,depth=0) {
    if(value==null||depth>7||remaining<=0)return undefined;
    if(typeof value==='number')return Number.isFinite(value)?value:undefined;
    if(typeof value==='boolean')return value;
    if(typeof value==='string'){
      if(!shareTranscript&&!/^[a-zA-Z0-9_.:-]{1,100}$/.test(value))return undefined;
      const s=value.replace(/(?:file:\/\/)?\/(?:Users|private|Volumes|tmp|var|home)\/[^\s，。；]+/gu,'[本地文件]').slice(0,Math.min(1000,remaining));
      remaining-=s.length;return s;
    }
    if(Array.isArray(value))return value.slice(0,48).map(v=>clean(v,depth+1)).filter(v=>v!==undefined);
    if(typeof value!=='object')return undefined;
    const out={};
    for(const [k,v] of Object.entries(value)){
      if(!/^[A-Za-z][A-Za-z0-9_-]{0,50}$/.test(k)||/path|url|fileName|locator|credential|base64|token/i.test(k))continue;
      if(!shareTranscript&&/transcript|words|text|message|observation|label|description|title|reason|name|limitations|voiceId|identity/i.test(k))continue;
      const z=clean(v,depth+1);if(z!==undefined)out[k]=z;
    }
    return out;
  }
  return clean({audio:input?.audio,review:input?.review,picture:input?.picture,graphics:input?.graphics,
    durationSeconds:input?.durationSeconds,targetSeconds:input?.targetSeconds});
}

export function reviewFrameSamples(project,feedback,frames) {
  const fps=project.profile.fps,last=frames-1,selections=new Map();
  function add(n,label) {
    if(!Number.isFinite(n)||last<0)return;
    const f=Math.min(last,Math.max(0,Math.round(n)));
    if(!selections.has(f))selections.set(f,label);
  }
  add(0,'开场');add(Math.min(fps,last/9),'开场后续');add(last*.25,'前段');add(last*.5,'中段');add(last*.75,'后段');
  add(last-Math.min(fps,last/9),'结尾前');add(last,'末帧');
  const issues=feedback?.review?.issues||[];
  for(const issue of issues.slice(0,2)) {
    add(issue.fromFrame,'检测区间起点');if(issue.toFrame>issue.fromFrame)add(issue.toFrame-1,'检测区间末端');
  }
  const cuts=project.timeline.clips.filter(c=>c.track==='video'&&c.enabled!==false&&!c.hidden&&c.start>0&&c.start<frames);
  const cut=cuts.reduce((best,c)=>!best||Math.abs(c.start-last/2)<Math.abs(best.start-last/2)?c:best,null);
  if(cut){add(cut.start-1,'剪接前');add(cut.start,'剪接后');}
  return [...selections].sort((a,b)=>a[0]-b[0]).map(([frame,reason])=>({frame,reason}));
}

const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
export async function openCandidate(deps,project,ref,signal) {
  if(project.settings?.shareFrames!==true)throw Error('工程已关闭成片帧分享，首版保留在本机。');
  if(!ref?.jobId||!Number.isSafeInteger(ref.revision)||!/^([a-f0-9]{64})$/.test(ref.sha256)||typeof ref.videoPath!=='string')throw Error('缺少首版导出身份。');
  const first=await deps.store.getJob(ref.jobId);
  if(first.projectId!==project.id||first.revision!==ref.revision||first.qa?.artifactSha256!==ref.sha256||!first.files?.video)
    throw Error('首版导出与当前工程记录不一致。');
  const root=await realpath((await deps.store.paths(project.id)).outputs);
  const file=await realpath(ref.videoPath);
  if(!file.startsWith(root+path.sep)||file!==await realpath(first.files.video)||path.extname(file).toLowerCase()!=='.mp4')throw Error('首版必须是当前工程中已登记的 MP4。');
  const signature=stamp(await stat(file,{bigint:true}));
  async function assertFrozen(){
    signal?.throwIfAborted();
    if(stamp(await stat(file,{bigint:true}))!==signature)throw Error('已登记的首版导出发生改变，已停止读取。');
  }
  if(await (deps.media.fileHash||fileHash)(file)!==ref.sha256)throw Error('首版 MP4 与验收指纹不同，已停止读取。');
  const info=await deps.media.probeMedia(file,{signal}), frozen=first.snapshot||await deps.store.revision(project.id,ref.revision);
  if(frozen.id!==project.id||frozen.revision!==ref.revision||info.kind!=='video'||!(info.duration>0))throw Error('首版文件或工程快照不可用。');
  const fps=frozen.profile.fps,frames=info.frames||Math.round(info.duration*fps);
  if(!Number.isSafeInteger(frames)||frames<=0||Math.abs(frames/fps-info.duration)>1.5/fps)throw Error('冻结首版的视频帧数与工程时钟不符。');
  await assertFrozen();
  return {file,assertFrozen,fps,frames,jobId:ref.jobId,revision:ref.revision,sha256:ref.sha256,
    samples:reviewFrameSamples(frozen,ref.feedback,frames),feedback:candidateFeedback(ref.feedback,project.settings?.shareTranscript!==false)};
}
