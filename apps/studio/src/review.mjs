import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileSha256} from './style.mjs';
import {reviewVisualEvidence} from './visual-review.mjs';
import {reviewStyleAudio} from './style-audio-review.mjs';
import {isMusicBed} from './music-evidence.mjs';
import {currentCutNotes} from './storyboard.mjs';
import {withinSegmentMessage} from './speech-alignment.mjs';
export {createBlindReview} from './blind-review.mjs';

const exec=promisify(execFile);
const outcomes={deliverable:'可交付',advisory:'可交付，有建议',unverified:'待复核',repair:'需修复'};
const ranks={minor:1,unknown:2,major:3,blocker:4};
const isActive=c=>c.hidden!==true&&c.enabled!==false;
const musicNote=n=>n?.kind==='music-required'||n?.type==='required'&&['本项目要求的配乐尚未加入，请选择相应的曲目。','所选配乐尚未加入'].includes(String(n.message||'').replace(/[！!]$/,''));
function musicRequirement(project,findings,last) {
  const s=project.settings||{};
  if(s.musicEnabled===false||s.musicMode==='none') return [];
  const required=s.requireMusic||s.musicAssetId||['original','asset'].includes(s.musicMode)||(project.directorNotes||[]).some(musicNote);
  if(!required) return [];
  const assets=new Map(project.assets.map(a=>[a.id,a]));
  const music=project.timeline.clips.filter(c=>isMusicBed(c,assets.get(c.assetId))&&!c.muted&&isActive(c)&&(c.gain??1)>0&&(!s.musicAssetId||c.assetId===s.musicAssetId));
  if(!music.length) {findings.push(issue('music-required','major','本期指定的配乐未出现在可听轨道上','把已选择的曲目加入音乐轨，检查音量。',0,last));return [];}
  if(s.musicMode==='original') {
    for(const id of new Set(music.map(c=>c.assetId))) {
      const source=project.assets.find(a=>a.id===id)?.source||{};
      const verified=source.kind==='generated-music'&&source.provider&&source.requestId || ['user-composed','local-composition'].includes(source.kind)&&source.rights;
      if(!verified) findings.push(issue('original-music-'+id,'unknown','配乐已上轨，原创来源还需核实','关联本次生成的任务记录或用户原创声明。',0,last));
    }
  }
  return music;
}
function issue(id,severity,message,fix,fromFrame=0,toFrame=fromFrame,reason=id) {
  return {id,severity,reason,message,fromFrame,toFrame,fix};
}
export function classifyReview(findings=[],meta={}) {
  const issues=new Map();
  for(const row of findings) {
    if(!row||['resolved','intended'].includes(row.status)) continue;
    const severity=Object.hasOwn(ranks,row.severity)?row.severity:'unknown';
    const message=String(row.message||row.symptom||row.observations||'此项尚待核实');
    const from=Number(row.fromFrame??row.from_frame??0),to=Number(row.toFrame??row.to_frame??from);
    const start=Number.isFinite(from)?Math.max(0,Math.floor(from)):0;
    const end=Number.isFinite(to)?Math.max(start,Math.floor(to)):start;
    const id=String(row.id||createHash('sha256').update([message,start,end].join('/')).digest('hex').slice(0,16));
    const normalized=issue(id,severity,message,row.fix||row.suggested_fix||'',start,end,row.reason||row.check||id);
    if(Array.isArray(row.locations)) {
      const frames=[...new Set(row.locations.map(p=>p?.frame).filter(f=>Number.isSafeInteger(f)&&f>=0))].sort((a,b)=>a-b);
      if(frames.length)normalized.locations=frames.map(frame=>({frame}));
    }
    if(!issues.has(id)||ranks[severity]>ranks[issues.get(id).severity]) issues.set(id,normalized);
  }
  const items=[...issues.values()].sort((a,b)=>ranks[b.severity]-ranks[a.severity]||a.fromFrame-b.fromFrame);
  const status=['blocker','major'].includes(items[0]?.severity)?'repair':items[0]?.severity==='unknown'?'unverified':items.length?'advisory':'deliverable';
  return {...meta,status,label:outcomes[status],deliverable:['deliverable','advisory'].includes(status),issues:items};
}
export function classifyLegacyReview(report) {
  const findings=[];
  if(report.decode_pass===false) findings.push(issue('decode','blocker','原报告确认成片解码失败','重新渲染后完整解码。'));
  let assessed=false;
  for(const [key,check] of Object.entries(report.checks||{})) {
    if(check.status==='not_applicable') continue;
    if(check.status==='pass') {assessed=true;continue;}
    if(!['fail','failed','unverified','pending'].includes(check.status)) continue;
    const rows=check.issues?.length?check.issues:[check.observations||key];
    for(const row of rows) {
      if(typeof row==='object') {findings.push(row);assessed=true;continue;}
      // A preflight report documents provider evidence. It did not review the finished audio.
      const msg=String(row);
      const severity=report.preflight||['pending','unverified'].includes(check.status)||/记录|证据|未验证|无法核实/i.test(msg)?'unknown':'major';
      findings.push(issue(key,severity,msg,severity==='unknown'?'补证后复核对应片段。':'修复并复查对应片段。'));
    }
  }
  if(!report.decode_pass&&!report.completed&&!report.preflight&&!assessed) findings.push(issue('legacy-verification','unknown','旧记录缺少成片解码与独立观测','试听并复核当前文件。'));
  return classifyReview(findings,{historical:true,originalCompleted:report.completed??null,originalDecode:report.decode_pass??null,
    artifactSha256:report.artifact_sha256||null,limitations:['历史报告只读重分类，保留原验收结论。']});
}
export const reviewLegacy=classifyLegacyReview;
async function defaultResolver(name) { return (await import('./media.mjs')).mediaTool(name); }
async function run(file,args,{signal,buffer=false}={}) {
  return exec(file,args,{signal,encoding:buffer?'buffer':'utf8',maxBuffer:6*1024*1024,timeout:20*60*1000});
}
function stampToMs(value) {
  const m=/^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value);
  if(!m||+m[2]>=60||+m[3]>=60) return NaN;
  return ((+m[1]*60 + +m[2])*60 + +m[3])*1000 + +m[4];
}
export function readSrt(text) {
  if(!text.trim()) return [];
  return text.replace(/^\uFEFF/,'').trim().split(/\r?\n\s*\r?\n/).map(block=>{
    const lines=block.split(/\r?\n/);
    if(!/^\d+$/.test(lines[0]?.trim())) throw Error('SRT 序号无效');
    const [from,to]=(lines[1]||'').trim().split(/\s*-->\s*/).map(stampToMs);
    if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||!lines[2]) throw Error('SRT 时码或文本无效');
    return {from,to,text:lines.slice(2).join('\n').trim()};
  });
}
function timelineChecks(project,findings) {
  const clips=project.timeline.clips.filter(isActive);
  const captions=clips.filter(c=>c.track==='caption' && c.hidden!==true).sort((a,b)=>a.start-b.start);
  const visible=clips.filter(c=>c.track==='video'&&c.hidden!==true);
  const narration=clips.filter(c=>c.track==='narration'&&c.hidden!==true);
  const mode=project.settings?.voiceMode;
  const original=mode==='original'&&narration.length===0;
  const dialogue=original?visible.filter(c=>!c.muted&&(c.gain??1)>0&&project.assets.some(a=>a.id===c.assetId&&a.hasAudio)):[];
  const last=Math.max(0,...clips.map(c=>c.start+c.duration-1));
  if(!visible.length) findings.push(issue('picture-missing','blocker','工程没有可见画面','补入可见镜头。'));
  if(original&&!dialogue.length) findings.push(issue('dialogue-missing','blocker','本期要求保留同期声，可见镜头的原声均缺失或静音','恢复人物原声音轨。',0,last));
  if(['system','preset','clone','import'].includes(mode)&&!narration.length) findings.push(issue('narration-missing','blocker','本期要求的旁白没有进入时间线','恢复已选择的旁白。',0,last));
  const music=musicRequirement(project,findings,last);
  if(project.settings?.requireCaptions&&!captions.length) findings.push(issue('captions-missing','major','本期要求字幕，时间线缺少字幕','从实际语音重新对齐字幕。'));
  for(const cue of clips.filter(c=>c.track==='graphic' && c.templateRole==='action' && c.hidden!==true)) {
    if(!Number.isInteger(cue.actionFrame)) {
      findings.push(issue(cue.id+'-anchor','unknown','动作花字没有对应的观察帧','在原片中标出实际动作。',cue.start,cue.start+cue.duration-1));continue;
    }
    let actual=cue.actionFrame;
    if(cue.anchorAssetId && Number.isInteger(cue.anchorSourceFrame)) {
      const candidates=visible.filter(c=>c.assetId===cue.anchorAssetId && cue.anchorSourceFrame>=(c.sourceIn||0) && cue.anchorSourceFrame<(c.sourceIn||0)+c.duration*(c.speed||1));
      const spans=candidates.map(c=>c.start+Math.round((cue.anchorSourceFrame-(c.sourceIn||0))/(c.speed||1)));
      if(!spans.length) {findings.push(issue(cue.id+'-anchor','unknown','锚定动作已被剪出视频','重新选择动作和可见镜头。',cue.start,cue.start+cue.duration-1));continue;}
      actual=spans.reduce((a,b)=>Math.abs(a-cue.start)<Math.abs(b-cue.start)?a:b);
    }
    const delta=Math.abs(cue.start-actual);
    if(delta>Math.max(1,Math.round(.12*project.profile.fps))) findings.push(issue(cue.id+'-timing',delta>=project.profile.fps*.5?'major':'minor',
      '动作花字和已标注的真实动作相差 '+delta+' 帧','把花字移动到动作发生的帧。',Math.min(cue.start,actual),Math.max(cue.start,actual)));
  }
  return {captions,narration:[...narration,...dialogue],music};
}
const normText=txt=>String(txt).replace(/\s+/gu,' ').trim();
function measuredSpeechEdge(project,caption,edge) {
  if(!caption?.speechGroup||!caption.speechAssetId||!Number.isInteger(caption.speechCue)) return false;
  const voice=project.timeline.clips.find(c=>c.track==='narration'&&c.id===caption.speechGroup&&c.assetId===caption.speechAssetId&&!c.hidden&&c.enabled!==false);
  if(!voice) return false;
  const hash=project.assets.find(a=>a.id===voice.assetId)?.sha256,alignment=hash&&project.speechAlignments?.[hash];
  const cue=alignment?.cues?.[caption.speechCue];
  if(!cue||alignment.audioHash!==hash||normText(cue.text)!==normText(caption.text)) return false;
  const fps=project.profile.fps,t=cue[edge],projected=Math.max(0,Math.min(voice.duration,Math.round((t*fps-(voice.sourceIn||0))/(voice.speed||1))));
  if(!Number.isFinite(t)||voice.start+projected!==(edge==='start'?caption.start:caption.start+caption.duration))return false;
  return Math.abs(t-alignment.audible?.[edge])<=.5/fps||alignment.method==='whisper.cpp'&&alignment.segments?.some(s=>Math.abs(t-s[edge])<=.5/fps);
}
function captionChecks(project,captions,cues,fps,findings) {
  if(captions.length!==cues.length) {findings.push(issue('srt-count','major','SRT 条数与可见字幕不一致','从当前时间线重新导出 SRT。'));return;}
  for(let i=0;i<captions.length;i++) {
    const c=captions[i],row=cues[i],from=c.start,to=c.start+c.duration;
    if(normText(c.text)!==normText(row.text)||Math.abs(from*1000/fps-row.from)>Math.max(2,500/fps)||Math.abs(to*1000/fps-row.to)>Math.max(2,500/fps)) {
      findings.push(issue('srt-'+c.id,'major','SRT 与工程中的字幕文字或时间码不一致','重新导出这段字幕。',from,to-1));
    }
    const gap=captions[i+1]?.start-to;
    if(gap>0&&gap<=2&&!(measuredSpeechEdge(project,c,'end')&&measuredSpeechEdge(project,captions[i+1],'start'))) findings.push(issue('caption-gap-'+to,'minor','相邻字幕之间空了 '+gap+' 帧，可在原速预览核对','可选延长前一条字幕到下一句。',to,to+gap-1));
  }
}
async function extractPcm(binary,file,start,duration,signal) {
  const {stdout}=await run(binary,['-v','error','-nostdin','-ss',String(Math.max(0,start)),'-protocol_whitelist','file','-i',file,'-t',String(duration),'-vn','-ac','1','-ar','4000','-f','f32le','pipe:1'],{signal,buffer:true});
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset,stdout.byteOffset+stdout.byteLength));
}
function correlation(source,mix,expected) {
  const n=source.length;
  if(n<400||mix.length<n) return null;
  let sourcePower=0,sourceSum=0;
  for(const v of source) {sourcePower+=v*v;sourceSum+=v;}
  const variance=sourcePower-sourceSum*sourceSum/n;
  if(variance/n<.00002) return null;
  const scan=(offset,step)=>{
    let ap=0,mp=0,sp=0,sm=0,as=0,count=0;
    for(let i=0;i<n;i+=step) { const a=source[i],b=mix[offset+i];ap+=a*a;mp+=b*b;sp+=a;sm+=b;as+=a*b;count++; }
    return (as-sp*sm/count)/Math.sqrt(Math.max(1e-12,(ap-sp*sp/count)*(mp-sm*sm/count)));
  };
  let best=-1,position=0;
  // Scan all sample offsets. Coarse source subsampling only shortlists candidates;
  // the selected offsets are measured against every sample before classification.
  const candidates=[];
  for(let offset=0;offset+n<=mix.length;offset++) {
    const similarity=scan(offset,16);
    if(similarity>.32) candidates.push({offset,similarity});
  }
  const scores=[];
  for(const {offset} of candidates.sort((a,b)=>b.similarity-a.similarity).slice(0,18)) {
    const score=scan(offset,1);
    scores.push({offset,score});
    if(score>best) {best=score;position=offset;}
  }
  const expectedSample=Math.round(expected*4000);
  if(expectedSample>=0&&expectedSample+n<=mix.length) {
    const nominal=scan(expectedSample,1);
    if(nominal>=.65 && nominal>=best-.055) return {score:nominal,offset:expected};
  }
  if(scores.some(s=>Math.abs(s.offset-position)>400 && s.score>.65 && s.score>=best-.04)) return null;
  return {score:best,offset:position/4000};
}
async function audioChecks(project,narration,{ffmpeg,videoPath,signal},findings,evidence) {
  const fps=project.profile.fps,mode=project.settings?.voiceMode;
  const assets=new Map(project.assets.map(a=>[a.id,a]));
  const sourceHashes=new Map();
  for(const clip of narration) {
    const asset=assets.get(clip.assetId);
    const from=clip.start,to=from+clip.duration-1;
    if(!asset?.path || clip.muted || !(clip.gain??1)) {
      findings.push(issue('muted-'+clip.id,'major','时间线旁白缺少音频或已静音','恢复旁白并复核混音。',from,to));continue;
    }
    if(mode==='clone') {
      const voiceId=project.settings?.voiceId,refId=project.settings?.voiceReferenceAssetId;
      const expectedHash=project.settings?.referenceHash||(refId && assets.get(refId)?.sha256);
      const actual=asset.source||{};
      if((!expectedHash&&!voiceId)||(expectedHash&&actual.referenceHash!==expectedHash)||(voiceId&&actual.voiceId!==voiceId)) findings.push(issue('voice-identity-'+clip.id,'unknown','指定音色与本地配音原件的关联需要核实','重新关联参考录音并试听该句。',from,to));
    }
    let sourceHash;
    try {sourceHash=sourceHashes.get(asset.path)||await fileSha256(asset.path);sourceHashes.set(asset.path,sourceHash);} catch(error) {if(error.code!=='ENOENT') throw error;}
    if(!sourceHash||!asset.sha256||sourceHash!==asset.sha256) {
      findings.push(issue('voice-source-'+clip.id,'unknown','本地旁白原件不存在或内容已变化','重新关联工程导入时的原件。',from,to));continue;
    }
    if((clip.speed??1)!==1 || clip.duration/fps<.45) {evidence.audio.push({clip:clip.id,method:'source-hash',sourceHash});continue;}
    const results=[],dropouts=[];
    const seconds=clip.duration/fps, length=Math.min(.38,seconds*.32);
    for(const fraction of [.16,.50,.78]) {
      const cursor=Math.min(seconds-length,seconds*fraction);
      const when=from/fps+cursor;
      const windowStart=Math.max(0,when-.5);
      const [source,mix]=await Promise.all([extractPcm(ffmpeg,asset.path,(clip.sourceIn||0)/fps+cursor,length,signal),extractPcm(ffmpeg,videoPath,windowStart,when-windowStart+length+.5,signal)]);
      const nominal=mix.subarray(Math.round((when-windowStart)*4000),Math.round((when-windowStart)*4000)+source.length);
      let active=0,longest=0;
      for(let i=0;i+80<=Math.min(source.length,nominal.length);i+=80) {
        let dry=0,wet=0;
        for(let j=i;j<i+80;j++) {dry+=source[j]*source[j];wet+=nominal[j]*nominal[j];}
        active=dry*(clip.gain??1)**2/80>.00015&&wet/80<.0000004?active+1:0;
        longest=Math.max(active,longest);
      }
      if(longest>=6) dropouts.push({at:when,until:when+length});
      const match=correlation(source,mix,when-windowStart);
      if(match) results.push({at:when,similarity:Number(match.score.toFixed(3)),offset:Number((match.offset-(when-windowStart)).toFixed(3))});
    }
    evidence.audio.push({clip:clip.id,method:'source-and-mix-windows',sourceHash,windows:results,dropouts});
    const matched=results.filter(w=>w.similarity>=.65);
    const late=matched.filter(w=>w.offset>.18),early=matched.filter(w=>w.offset<-.18);
    if(dropouts.length) findings.push(issue('voice-dropout-'+clip.id,'major','原件持续有声，对应成片混音出现连续静音','恢复该区间的原声并复查。',Math.floor(dropouts[0].at*fps),Math.ceil(dropouts.at(-1).until*fps)-1));
    else if(late.length>=2||early.length>=2) findings.push(issue('voice-drift-'+clip.id,'major','多个独立窗口确认混音旁白持续偏离时间线','重新对齐该段旁白与字幕。',from,to));
    else if(results.length>=2&&!matched.length) findings.push(issue('mix-match-'+clip.id,'unknown','当前混音窗口未能确认旁白原件，需试听对应段','核对音量、源窗口和最终混音。',from,to));
  }
}
function currentDirectorFindings(project) {
  const problems=[],estimated=new Set();
  const captions=project.timeline.clips.filter(c=>c.track==='caption'&&isActive(c)).sort((a,b)=>a.start-b.start);
  for(const note of currentCutNotes(project)) {
    if(!note?.message||!['suggestion','required'].includes(note.type)||musicNote(note)) continue;
    const start=Number.isInteger(note.frame)?note.frame:0;
    if(note.kind==='speech-alignment'&&note.message===withinSegmentMessage&&note.speechGroup) {
      const group=captions.filter(c=>c.speechGroup===note.speechGroup);
      for(let i=1;i<group.length;i++) {
        if(group[i].cueTiming==='within-segment'&&group[i-1].cueTiming==='within-segment')estimated.add(group[i].start);
      }
      if(group.length&&group.every(c=>!c.cueTiming))estimated.add(group[0].start);
      continue;
    }
    problems.push({severity:note.type==='required'?'unknown':'minor',reason:'director-observation',message:note.message,fromFrame:start,toFrame:note.toFrame??start,fix:'查看对应素材或试听此段后确认。'});
  }
  const locations=[...estimated].sort((a,b)=>a-b).map(frame=>({frame}));
  if(locations.length)problems.push({...issue('estimated-caption-switches','minor',withinSegmentMessage,'播放标记的换字位置，按听感微调字幕。',locations[0].frame,locations[0].frame),locations});
  return problems;
}
export async function reviewProject(project,{videoPath,srtPath,findings=[],signal,preview=false,comparePreview,styleSpec,styleMusicResource,resolveTool=defaultResolver}={}) {
  const problems=[...findings,...currentDirectorFindings(project)],evidence={audio:[],decode:false};
  const meta={revision:project.revision,frameRate:project.profile.fps,artifactSha256:null,subtitleSha256:null,candidatePlayable:false,evidence,
    limitations:['波形与抽帧提供技术证据。音色自然度、发音、节奏偏好和未标注的动作语义需要原速观看或试听。']};
  const {captions,narration,music}=timelineChecks(project,problems);
  try {meta.artifactSha256=await fileSha256(videoPath);}
  catch(error) {if(error.code!=='ENOENT' && error.code!=='ERR_INVALID_ARG_TYPE') throw error;problems.push(issue('output-missing','blocker','找不到最终视频文件','重新渲染。'));return classifyReview(problems,meta);}
  let ffprobe,ffmpeg;
  try { [ffprobe,ffmpeg]=await Promise.all([resolveTool('ffprobe'),resolveTool('ffmpeg')]); if(!ffprobe||!ffmpeg) throw Error(); }
  catch {problems.push(issue('probe-unavailable','unknown','本机媒体检查工具暂不可用','恢复本地媒体工具后重新检查。'));return classifyReview(problems,meta);}
  let probe;
  try {
    probe=JSON.parse((await run(ffprobe,['-v','error','-protocol_whitelist','file','-show_streams','-show_format','-of','json',videoPath],{signal})).stdout);
    const stream=probe.streams.find(s=>s.codec_type==='video');
    if(!stream) throw Error('no visible video stream');
    await run(ffmpeg,['-nostdin','-v','error','-xerror','-protocol_whitelist','file','-i',videoPath,'-map','0:v:0','-map','0:a:0?','-f','null','-'],{signal});
    evidence.decode=true;meta.candidatePlayable=true;
    const frameCount=Number(stream.nb_frames),duration=Number(stream.duration||probe.format.duration);
    evidence.duration=duration;
    const expected=Math.max(0,...project.timeline.clips.filter(isActive).map(c=>c.start+c.duration));
    if(!Number.isFinite(duration)||Math.abs((Number.isFinite(frameCount)&&frameCount>0?frameCount:Math.round(duration*project.profile.fps))-expected)>1 ||Math.abs(duration-expected/project.profile.fps)>1.5/project.profile.fps) {
      const end=Number.isFinite(duration)?Math.max(0,Math.round(duration*project.profile.fps)-1):0;
      problems.push(issue('output-duration','major','视频时长与当前工程不符','从当前版本重新渲染。',Math.min(end,Math.max(0,expected-1)),Math.max(end,expected-1)));
    }
    const wrongSize=preview?Math.abs(stream.width/stream.height-project.profile.width/project.profile.height)>.012:project.profile.width!==stream.width||project.profile.height!==stream.height;
    if(wrongSize) problems.push(issue('output-size','major','视频画幅与项目规格不同','按工程画幅重新渲染。'));
  } catch(error) {
    if(signal?.aborted) throw error;
    problems.push(issue('decode','blocker','最终视频缺少画面流或在完整解码时出错','重新渲染后复查。'));
    return classifyReview(problems,meta);
  }
  if(srtPath||captions.length||project.settings?.requireCaptions) {
    try {
      const text=await readFile(srtPath,'utf8');
      meta.subtitleSha256=createHash('sha256').update(text).digest('hex');
      captionChecks(project,captions,readSrt(text),project.profile.fps,problems);
    } catch {problems.push(issue('srt-invalid','major','字幕文件缺失或时码格式无法读取','从当前可见字幕重新导出。'));}
  }
  if(narration.length||music.length) {
    const required=[...narration,...music],audioStart=Math.min(...required.map(c=>c.start)),audioEnd=Math.max(...required.map(c=>c.start+c.duration-1));
    if(!probe.streams.some(s=>s.codec_type==='audio')) problems.push(issue('mix-missing','blocker','成片缺少应有的混音声轨','恢复混音并重新渲染。',audioStart,audioEnd));
    else {
      try {
        const level=await run(ffmpeg,['-nostdin','-nostats','-hide_banner','-protocol_whitelist','file','-i',videoPath,'-vn','-af','volumedetect','-f','null','-'],{signal});
        const peak=level.stderr.match(/max_volume:\s*([-\d.]+) dB/);
        if(peak && Number(peak[1])<=-72) problems.push(issue('mix-silent','blocker','成片混音全长接近静音，必需声轨无法听清','恢复混音。',audioStart,audioEnd));
        else await audioChecks(project,narration,{ffmpeg,videoPath,signal},problems,evidence);
      } catch(error) {
        if(signal?.aborted) throw error;
        problems.push(issue('mix-evidence','unknown','混音与旁白原件的测量未完成','重新检测后试听对应段。'));
      }
    }
  }
  if(meta.candidatePlayable) {
    const styleAudio=await reviewStyleAudio(project,styleSpec,{videoPath,signal,styleMusicResource,hasMix:probe.streams.some(s=>s.codec_type==='audio'),
      voiceWindows:evidence.audio,hashFile:fileSha256,probeDuration:async file=>{
        const {stdout}=await run(ffprobe,['-v','error','-protocol_whitelist','file','-show_entries','format=duration','-of','csv=p=0',file],{signal});
        return Number(stdout.trim());
      },readPcm:(file,t,d)=>extractPcm(ffmpeg,file,t,d,signal)});
    if(styleAudio){
      evidence.styleAudio=styleAudio.evidence;
      for(const item of styleAudio.findings){
        // Existing technical checks already identify a completely absent track.
        const sameMissing=item.id==='style-audio-music'?'music-required':'narration-missing';
        if(item.severity==='major'&&problems.some(p=>p.id===sameMissing))continue;
        problems.push(item);
      }
    }
    if(comparePreview && !preview){
      const parity=await comparePreview(project,{videoPath,ffmpeg,signal});
      if(parity){
        evidence.compositeParity=parity;
        for(const check of parity.checks.filter(c=>c.matches===false)){
          problems.push(issue('composite-parity-'+check.clipId,'unknown','预览与导出在此处可见差异','对照同版本草稿和导出文件，复核此图层。',check.frame,check.frame));
        }
      }
    }
    const visual=await reviewVisualEvidence(project,{videoPath,ffmpeg,signal,styleSpec,hashFile:fileSha256});
    evidence.visual=visual.evidence;
    const director=project.visualDirection;
    if(visual.evidence.styleExecution&&director?.motion?.gap){
      const duplicate=problems.findIndex(p=>p.reason==='director-observation'&&p.message.includes(director.motion.gap));
      if(duplicate>=0){
        const otherGap=director.gaps?.find(g=>typeof g==='string'&&g.trim()&&g!==director.motion.gap);
        if(otherGap)problems[duplicate]={...problems[duplicate],message:'候选已生成。'+otherGap};
        else problems.splice(duplicate,1);
      }
    }
    for(const check of project.visualDirection?.checks||[]) {
      if(!visual.findings.some(f=>f.id==='visual-witness-'+check.frame))continue;
      const duplicate=problems.findIndex(p=>p.reason==='director-observation'&&p.message.includes(check.observation));
      if(duplicate>=0)problems.splice(duplicate,1);
    }
    problems.push(...visual.findings);
  }
  const result=classifyReview(problems,meta);
  result.repairs=deterministicRepairs(project,result);
  return result;
}

export function deterministicRepairs(project,report) {
  if(report.status!=='repair'||report.revision!==project.revision) return [];
  const clips=project.timeline.clips, repairs=[];
  for(const item of report.issues) {
    if(!['major','blocker'].includes(item.severity)) continue;
    if(item.id==='srt-count'||item.id==='srt-invalid'||item.id.startsWith('srt-')&&clips.some(c=>'srt-'+c.id===item.id)) {
      if(!repairs.some(r=>r.kind==='regenerate-subtitles')) repairs.push({kind:'regenerate-subtitles',reason:item.message});
      continue;
    }
    const cue=clips.find(c=>c.track==='graphic'&&c.templateRole==='action'&&c.id+'-timing'===item.id);
    if(!cue || cue.locked || !cue.anchorAssetId || !Number.isSafeInteger(cue.anchorSourceFrame)) continue;
    const sources=clips.filter(c=>c.track==='video'&&isActive(c)&&c.assetId===cue.anchorAssetId && cue.anchorSourceFrame>=(c.sourceIn||0)&&cue.anchorSourceFrame<(c.sourceIn||0)+c.duration*(c.speed||1));
    if(sources.length!==1) continue;
    const shot=sources[0], anchor=shot.start+Math.round((cue.anchorSourceFrame-(shot.sourceIn||0))/(shot.speed||1));
    const duration=cue.start+cue.duration-anchor;
    if(duration<Math.max(3,Math.round(project.profile.fps*.28))||clips.some(c=>c.locked&&c.track===cue.track&&c.start<anchor+duration&&anchor<c.start+c.duration)) continue;
    repairs.push({kind:'edit',reason:item.message,baseRevision:project.revision,commands:[{op:'update',id:cue.id,changes:{start:anchor,actionFrame:anchor,duration}}]});
  }
  return repairs;
}
