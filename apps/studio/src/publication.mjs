import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createAss} from './text-tracks.mjs';
const execute=promisify(execFile);

function coverType(title,width,height) {
  const chars=[...title.trim().replace(/\s+/g,' ')];
  const weight=c=>c.codePointAt(0)<256?.58:1;
  const total=chars.reduce((s,c)=>s+weight(c),0);
  const usable=width*.85;
  let font=Math.round(Math.min(width*.09,height*.094));
  const rows=()=>Math.max(1,Math.ceil(total*font/usable));
  while(font>16&&rows()*font*1.25>height*.25)font--;
  const goal=total/rows(),lines=[];
  let line='',units=0;
  for(const c of chars){
    if(line.trim()&&units+weight(c)>goal+.5){lines.push(line.trim());line='';units=0;}
    line+=c;units+=weight(c);
  }
  if(line.trim())lines.push(line.trim());
  return {text:lines.join('\n'),fontSize:font};
}

export async function makePublicationPackage(p,{videoPath,directory,media,signal}){
  const ff=await media.mediaTool('ffmpeg');
  const stem=path.join(directory,'cover-frame.png');
  const clips=p.timeline.clips.filter(c=>!c.hidden&&c.enabled!==false);
  const total=Math.max(...clips.map(c=>c.start+c.duration),1);
  const at=Math.min(total-1,Math.floor(total*.32));
  const shot=clips.filter(c=>c.track==='video'&&c.start<=at&&c.start+c.duration>at).at(-1);
  const asset=shot&&p.assets.find(a=>a.id===shot.assetId);
  const cue=asset?.kind==='image'?0:shot?((shot.sourceIn||0)+(at-shot.start)*(shot.speed||1))/p.profile.fps:0;
  if(asset)await media.frameAt(asset.path,cue,stem,{signal});
  else await media.frameAt(videoPath,at/p.profile.fps,stem,{signal});
  const headline=p.publication?.title||p.title;
  const outputs={};
  for(const [name,width,height] of [['cover34',900,1200],['cover43',1200,900]]){
    const {text,fontSize}=coverType(headline,width,height);
    const layer={track:'graphic',text,start:0,duration:24,geometry:{x:.5,y:.82},style:{fontSize,color:'#FFF9E8',outlineWidth:0}};
    const typeFile=name+'.ass';await writeFile(path.join(directory,typeFile),createAss([layer],{width,height,fps:24}));
    const panel=Math.round(height*.37),top=height-panel;
    const filter=`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,drawbox=x=0:y=${top}:w=${width}:h=${panel}:color=0x16241d@0.90:t=fill,ass=${typeFile}`;
    const file=path.join(directory,name+'.jpg');
    await execute(ff,['-loglevel','error','-y','-i',stem,'-vf',filter,'-frames:v','1','-q:v','2',file],{cwd:directory,signal});
    outputs[name]=file;
  }
  const spoken=clips.filter(c=>c.track==='caption').sort((a,b)=>a.start-b.start).slice(0,4).map(c=>c.text).join('');
  const body=p.publication?.body||spoken||p.script?.slice(0,550);
  const tags=(p.publication?.tags?.length?p.publication.tags:[headline.replace(/\s/g,'')]).map(t=>'#'+t).join(' ');
  const draft=[headline,body,tags].filter(Boolean).join('\n\n');
  const copy=path.join(directory,'发布文案.txt');
  await writeFile(copy,(p.publication?draft:p.publishCopy||draft)+'\n');
  return {...outputs,copy};
}
