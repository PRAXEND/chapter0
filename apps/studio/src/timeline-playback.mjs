import path from 'node:path';
import {realpath,stat} from 'node:fs/promises';
import {fault} from './project.mjs';
import {draftPrefix} from './draft-preview.mjs';
import {playbackIdentity,timelineFrames} from './playback-identity.mjs';

const jobFile=/^cut-([a-zA-Z0-9_-]{1,128})\.mp4$/;
const draftFile=/^([a-f0-9]{16})-(\d+)-(\d+)-(\d+)\.(jpg|mp4)$/;
function current(store,p,expected){
  if(!Number.isSafeInteger(expected)||expected!==p.revision||store.get(p.id).revision!==expected)
    throw fault('工程版本已更新，请读取最新时间线。',409);
}
async function inside(file,root){
  const [target,parent]=await Promise.all([realpath(file),realpath(root)]);
  return target.startsWith(parent+path.sep)?target:null;
}
export function timelinePlayback(store,media,drafts){
  const verified=new Map();
  async function matchingCut(p,job,identity,signal){
    if(!job||job.projectId!==p.id||job.status!=='done'||!job.files?.video||job.qa?.candidatePlayable===false)return null;
    const expectedHash=job.qa?.artifactSha256||job.renderedSha256;
    if(!/^[a-f0-9]{64}$/.test(expectedHash||''))return null;
    const snapshot=job.snapshot||store.revision(p.id,job.revision);
    if(snapshot.id!==p.id||snapshot.revision!==job.revision||playbackIdentity(snapshot)!==identity)return null;
    const target=await inside(job.files.video,store.paths(p.id).outputs).catch(()=>null);
    if(!target||path.extname(target)!=='.mp4')return null;
    const info=await stat(target,{bigint:true}).catch(()=>null);
    if(!info?.isFile()||!info.size)return null;
    const key=[target,info.dev,info.ino,info.size,info.ctimeNs,info.mtimeNs,expectedHash,identity].join('/');
    if(verified.has(key))return verified.get(key)?target:null;
    const probed=await media.probeMedia(target,{signal});
    const {width,height,fps}=p.profile,count=timelineFrames(p);
    let valid=probed.kind==='video'&&probed.width===width&&probed.height===height&&probed.frames===count&&
      (!probed.frameRate||Math.abs(probed.frameRate-fps)<.001)&&Math.abs(probed.duration-count/fps)<=1.01/fps;
    if(valid)valid=await media.fileHash(target,{signal})===expectedHash;
    signal?.throwIfAborted();verified.set(key,valid);
    if(verified.size>64)verified.delete(verified.keys().next().value);
    return valid?target:null;
  }
  async function describe(p,{revision,frame,mode,signal}){
    current(store,p,revision);signal?.throwIfAborted();
    const fps=p.profile.fps,length=timelineFrames(p);
    if(!length)throw fault('时间线为空。',409);
    if(!Number.isSafeInteger(frame)||frame<0||frame>=length||!['play','still'].includes(mode))throw fault('播放帧或预览方式无效。',422);
    const identity=playbackIdentity(p);
    const jobs=store.listJobs(p.id).filter(j=>j.status==='done'&&j.files?.video)
      .sort((a,b)=>Number(a.kind==='preview')-Number(b.kind==='preview'));
    let descriptor;
    for(const job of jobs){
      try{
        if(await matchingCut(p,job,identity,signal)){
          descriptor={source:'cut',name:'cut-'+job.id+'.mp4',fromFrame:0,toFrame:length};break;
        }
      }catch{signal?.throwIfAborted();}
    }
    if(!descriptor){
      const still=mode==='still',existing=still&&await drafts.cachedSegment(p,frame);
      const file=existing||await (still?drafts.still:drafts.segment)(p,frame,signal);
      descriptor={source:still&&!existing?'frame':'window',...file};
    }
    current(store,p,revision);signal?.throwIfAborted();
    const url='/api/projects/'+encodeURIComponent(p.id)+'/playback/'+descriptor.name+'?revision='+revision+'&identity='+identity;
    return {...descriptor,revision,frame,fps,length,url};
  }
  async function file(p,name,{revision,identity,signal}){
    current(store,p,revision);
    if(!identity||identity!==playbackIdentity(p))throw fault('该预览已经过期。',409);
    const cut=jobFile.exec(name),draft=draftFile.exec(name);
    let file;
    if(cut){
      file=await matchingCut(p,store.getJob(cut[1]),identity,signal);
    }else if(draft&&name.startsWith(await draftPrefix(p))&&Number(draft[2])===revision){
      const folder=path.join(store.paths(p.id).cache,'drafts');
      file=await inside(path.join(folder,name),folder).catch(()=>null);
    }
    current(store,p,revision);signal?.throwIfAborted();
    if(!file)throw fault('当前时间线没有这份预览。',404);
    return file;
  }
  return {describe,file};
}
