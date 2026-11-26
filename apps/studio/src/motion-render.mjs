import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access, copyFile, link, mkdir, open, readFile, rename, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaultMotionGeometry, motionCatalog, motionSample, validateMotionClip} from './motion-components.mjs';
import {serialize} from './motion-dom.mjs';
import {verifyMotionFont} from './motion-font.mjs';
import {components, sourceHashes} from './motion-jsx.generated.mjs';
import {mediaCache, run, scratch} from './media-runtime.mjs';
import {createAss} from './text-tracks.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const swiftSource=fileURLToPath(new URL('../scripts/motion-webkit.swift',import.meta.url));
const nativeVersion=Promise.all(['./motion-dom.mjs','../scripts/motion-webkit.swift','./motion-jsx.generated.mjs'].map(file=>readFile(new URL(file,import.meta.url))))
  .then(parts=>digest(parts.map(digest).join('/')+'/'+os.release()));
const pngSignature=Buffer.from('89504e470d0a1a0a','hex');
const pngEnding=Buffer.from('0000000049454e44ae426082','hex');

async function runtimeHelper(signal) {
  const resources=process.env.VIDEO_STUDIO_RESOURCE_DIR;
  if(resources){
    const binary=path.join(resources,'bin','motion-webkit');
    try{await access(binary,constants.X_OK);}catch{throw Error('工作台的本机动效组件缺失，请重新安装完整的 Mac 发行包。');}
    return binary;
  }
  const directory=path.join(mediaCache(),'bin');
  const target=path.join(directory,'motion-webkit-'+process.arch+'-'+digest(await readFile(swiftSource)).slice(0,16));
  try{await access(target,constants.X_OK);return target;}catch{}
  if(process.platform!=='darwin')throw Error('当前动效组件需要 macOS WebKit。');
  await scratch(directory,async work=>{
    const binary=path.join(work,'motion-webkit');
    await run('/usr/bin/xcrun',['swiftc','-parse-as-library','-O',swiftSource,'-o',binary],{signal,env:{MACOSX_DEPLOYMENT_TARGET:'13.5'}});
    await rename(binary,target);
  });
  return target;
}

// Cache publication is atomic. Check both ends of PNGs before reusing an interrupted or damaged cache.
async function cachedPng(file,width,height) {
  let opened;
  try{
    opened=await open(file,'r');
    const {size}=await opened.stat();
    if(size<45)return false;
    const head=Buffer.alloc(24),end=Buffer.alloc(12);
    await opened.read(head,0,head.length,0);await opened.read(end,0,end.length,size-end.length);
    return pngSignature.equals(head.subarray(0,8)) && head.readUInt32BE(16)===width && head.readUInt32BE(20)===height && pngEnding.equals(end);
  }catch(error){if(error.code!=='ENOENT')throw error;return false;}
  finally{await opened?.close();}
}

async function linkOrCopy(from,to){
  try{await link(from,to);}
  catch(error){if(!['EXDEV','ENOTSUP','EPERM'].includes(error.code))throw error;await copyFile(from,to,constants.COPYFILE_FICLONE);}
}

async function prepareFrames(states,cache,work,signal,font){
  await mkdir(cache,{recursive:true,mode:0o700});
  const pngs=path.join(work,'motion-png');await mkdir(pngs);
  const missing=[];
  for(const state of states.values()){
    signal?.throwIfAborted();
    const name=state.key+'.png';
    if(await cachedPng(path.join(cache,name),state.width,state.height))await linkOrCopy(path.join(cache,name),path.join(pngs,name));
    else missing.push(state);
  }
  let receipt;
  if(missing.length){
    const helper=await runtimeHelper(signal);
    const batch=path.join(work,'motion-batch.json');
    // A batch shares one nonpersistent WKWebView. Limit resident DOM/bitmap memory on 8 GB Macs.
    for(let start=0; start<missing.length;start+=96){
      const chunk=missing.slice(start,start+96);
      await scratch(cache,async staging=>{
        await writeFile(batch,JSON.stringify({directory:staging,states:chunk,font:{path:font.path,sha256:font.sha256}}),{mode:0o600});
        const timeout=AbortSignal.timeout(180_000);
        const result=await run(helper,[batch],{signal:signal?AbortSignal.any([signal,timeout]):timeout});
        receipt=JSON.parse(result);
        if(receipt.family!==font.family || receipt.status!=='loaded')throw Error('WebKit 未确认风格包的中文字体。');
        for(const state of chunk){
          const name=state.key+'.png',from=path.join(staging,name),to=path.join(cache,name);
          if(!await cachedPng(from,state.width,state.height))throw Error('本机动效栅格化未产生完整透明帧。');
          await rename(from,to);await linkOrCopy(to,path.join(pngs,name));
        }
      });
    }
  }
  return {rasterized:missing.length,font:{family:font.family,sha256:font.sha256,...(receipt??{status:'cached'})}};
}

function segmentsFor(clip,profile,from,to,version,states){
  const component=motionCatalog.find(c=>c.id===clip.motion.componentId);
  validateMotionClip(clip,profile);
  const start=Math.max(clip.start,from),end=Math.min(clip.start+clip.duration,to);
  const runs=[];
  let previous;
  for(let at=start;at<end;at++){
    const sample=motionSample(clip,profile,at);
    const markup=serialize(components[sample.index-1]({props:sample.props},sample.frame,sample.duration));
    if(markup===previous){runs.at(-1).frames++;continue;}
    previous=markup;
    const key=digest([version,sourceHashes[sample.index-1],sample.width,sample.height,markup].join('/'));
    if(!states.has(key))states.set(key,{key,html:markup,width:sample.width,height:sample.height});
    runs.push({key,frames:1});
  }
  return {geometry:clip.geometry??defaultMotionGeometry(component,profile),start:start-from,frames:end-start,runs};
}

async function sequenceFile(work,name,runs,fps){
  const lines=['ffconcat version 1.0'];
  const pushFile=key=>lines.push('file motion-png/'+key+'.png','option framerate '+fps);
  let count=0;
  for(const run of runs){
    pushFile(run.key);
    const next=count+run.frames;
    const micros=Math.round(next*1_000_000/fps)-Math.round(count*1_000_000/fps);
    lines.push('duration '+(micros/1_000_000).toFixed(6));
    count=next;
  }
  pushFile(runs.at(-1).key);
  await writeFile(path.join(work,name),lines.join('\n')+'\n');
}

export async function prepareMotionOverlay(layers,profile,{work,directory,projectId,fromFrame,toFrame,signal,firstInput=2}){
  const {width,height,fps}=profile;
  const font=await verifyMotionFont();
  const version=(await nativeVersion)+'/'+font.sha256;
  const states=new Map(),presets=new Map();
  const graphics=layers.filter(c=>c.track==='graphic');
  for(const clip of graphics.filter(c=>c.motion)){
    presets.set(clip,segmentsFor(clip,profile,fromFrame,toFrame,version,states));
  }
  const projectCache=path.join(process.env.VIDEO_STUDIO_MOTION_CACHE||path.join(mediaCache(),'motion-frames-v1'),digest(String(projectId||path.resolve(directory))));
  const raster=await prepareFrames(states,projectCache,work,signal,font);
  const inputs=[],filters=[];
  let current='0:v',serial=0,inputIndex=firstInput;
  const next=()=> 'motionlayer'+(++serial);
  const narrowClock='settb=1/'+fps+',setpts=N';
  async function paintAss(ordinary){
    if(!ordinary.length)return;
    const out=next(),name=out+'.ass';
    await writeFile(path.join(work,name),createAss(ordinary,profile));
    filters.push('['+current+']'+narrowClock+'+'+fromFrame+',ass='+name+',setpts=N['+out+']');current=out;
  }
  const ordinary=[];
  for(const clip of graphics){
    const preset=presets.get(clip);
    if(!preset){ordinary.push(clip);continue;}
    await paintAss(ordinary.splice(0));
    const {geometry,start,frames,runs}=preset;
    const out=next(),ink='ink'+serial,name=out+'.ffconcat';
    await sequenceFile(work,name,runs,fps);
    inputs.push('-protocol_whitelist','file','-f','concat','-safe','0','-threads','1','-i',name);
    const w=Math.max(1,Math.round(width*geometry.width)),h=Math.max(1,Math.round(height*geometry.height));
    const x=Math.round(width*geometry.x-w/2),y=Math.round(height*geometry.y-h/2);
    // fps expands the duration-bearing PNG entries; trim discards the concat demuxer's terminal sentinel.
    filters.push('['+(inputIndex++)+':v]fps='+fps+',trim=end_frame='+frames+','+narrowClock+'+'+start+
      ',format=rgba,scale='+w+':'+h+':flags=lanczos,setsar=1['+ink+']');
    filters.push('['+current+']['+ink+']overlay=x='+x+':y='+y+':eof_action=pass:repeatlast=0:alpha=straight:format=yuv444'+
      ":enable='between(n,"+start+','+(start+frames-1)+")'["+out+']');current=out;
  }
  // Captions retain their higher track regardless of the order in which timeline edits inserted them.
  await paintAss([...ordinary,...layers.filter(c=>c.track==='caption')]);
  return {inputs,filter:filters.join(';'),map:'['+current+']',info:{clips:presets.size,uniqueFrames:states.size,...raster}};
}
