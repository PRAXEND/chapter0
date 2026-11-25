import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {symlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {balancedRows,coloredTitle,headline,typeLine} from './presentation.mjs';
import {createAss} from './text-tracks.mjs';
const execute=promisify(execFile);

export function coverComposition(project,key) {
  const portrait=key==='cover34';
  const [width,height]=portrait?[1440,1920]:[1920,1440];
  const shots=project.timeline.clips.filter(c=>c.track==='video'&&c.enabled!==false&&!c.hidden).sort((a,b)=>a.start-b.start);
  const total=project.timeline.clips.filter(c=>c.enabled!==false&&!c.hidden).reduce((t,c)=>Math.max(t,c.start+c.duration),1);
  const selected=project.publication?.[key];
  if(selected && selected.frame>=total)throw Error('发布封面所选帧已超出本版工程。');
  const anchor=portrait?shots.find(c=>Number.isInteger(c.actionFrame)):shots.findLast(c=>Number.isInteger(c.actionFrame));
  const pick=portrait?shots[0]:shots.at(-1);
  const frame=selected?.frame??anchor?.actionFrame??(pick?pick.start+Math.floor((pick.duration-1)/2):0);
  const shot=shots.findLast(c=>c.start<=frame&&frame<c.start+c.duration);
  const x=selected?.x??shot?.framing?.from?.x??.5,y=selected?.y??shot?.framing?.from?.y??.5;
  const {title,emphasis}=headline(project);
  const size=Math.round(width*(portrait?.075:.065)),rows=balancedRows(title,width*.88/size);
  const type=typeLine({text:coloredTitle(rows,emphasis),x:width*.5,y:height*.94,size});
  const ass=createAss([],{width,height,fps:1})+'Dialogue: 3,0:00:00.00,0:00:01.00,Caption,,0,0,0,,'+type+'\n';
  const filter='scale='+width+':'+height+':force_original_aspect_ratio=increase,crop='+width+':'+height+':'+x+'*(iw-ow):'+y+'*(ih-oh),setsar=1,drawbox=x=0:y='+Math.round(height*.73)+':w=iw:h=ih:color=black@0.55:t=fill,ass='+key+'.ass:fontsdir=cover-fonts';
  return {width,height,frame,shot,ass,filter};
}
export async function makePublicationPackage(p,{videoPath,directory,media,signal}){
  const ff=await media.mediaTool('ffmpeg');
  await symlink(fileURLToPath(new URL('./fonts',import.meta.url)),path.join(directory,'cover-fonts')).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const clips=p.timeline.clips.filter(c=>!c.hidden&&c.enabled!==false);
  const outputs={};
  for(const name of ['cover34','cover43']){
    const {frame,shot,ass,filter}=coverComposition(p,name);
    const asset=shot&&p.assets.find(a=>a.id===shot.assetId);
    const cue=asset?.kind==='image'?0:shot?((shot.sourceIn||0)+(frame-shot.start)*(shot.speed||1))/p.profile.fps:frame/p.profile.fps;
    const stem=path.join(directory,name+'-frame.png');
    await media.frameAt(asset?.path||videoPath,cue,stem,{signal});
    await writeFile(path.join(directory,name+'.ass'),ass);
    const file=path.join(directory,name+'.png');
    await execute(ff,['-loglevel','error','-y','-i',stem,'-vf',filter,'-frames:v','1',file],{cwd:directory,signal});
    outputs[name]=file;
  }
  const headline=p.publication?.title||p.title;
  const spoken=clips.filter(c=>c.track==='caption').sort((a,b)=>a.start-b.start).slice(0,4).map(c=>c.text).join('');
  const body=p.publication?.body||spoken||p.script?.slice(0,550);
  const tags=(p.publication?.tags?.length?p.publication.tags:[headline.replace(/\s/g,'')]).map(t=>'#'+t).join(' ');
  const draft=[headline,body,tags].filter(Boolean).join('\n\n');
  const copy=path.join(directory,'发布文案.txt');
  await writeFile(copy,(p.publication?draft:p.publishCopy||draft)+'\n');
  return {...outputs,copy};
}
