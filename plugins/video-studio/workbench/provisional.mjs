import {mkdir,mkdtemp,writeFile,copyFile,rename,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {contained,fileHash} from './media.mjs';
import {verifyCandidate,validateDeliveryFiles} from './quality.mjs';

export async function provisionalPackage(p,candidate,report,bridge){
  await verifyCandidate(candidate,p.run);
  const key=createHash('sha256').update(JSON.stringify({files:candidate.files,report})).digest('hex');
  const found=(p.provisionalDeliveries||[]).find(d=>d.key===key);
  if(found){for(const f of found.files)if(await fileHash(await contained(f.path,found.directory))!==f.sha256)throw Error('临时交付文件已变化。');return found;}
  const missing=[];
  const video=candidate.files.find(f=>f.role==='video');
  const verified=await bridge('inspect-media',{file:video.path});
  try{await validateDeliveryFiles(candidate,p.run,file=>bridge('inspect-media',{file}));}catch(e){missing.push(e.message);}
  if(p.captions&&!candidate.files.some(f=>f.role==='subtitles'))missing.push('缺少实际 SRT 字幕。');
  let outputRoot=p.outputRoot,fallback='';try{await mkdir(outputRoot,{recursive:true});}catch{outputRoot=path.join(p.run,'temporary-deliveries');await mkdir(outputRoot,{recursive:true});fallback='指定交付目录不可用，临时文件已保存在本期工作目录。';}const temp=await mkdtemp(path.join(outputRoot,'.preview-'));
  const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
  const directory=path.join(outputRoot,date+'_临时交付_'+(p.topic||'视频').replace(/[\/\\\x00-\x1f]/g,'-').slice(0,50)+'_'+randomUUID().slice(0,8));
  try{
    const files=[];
    const add=async(name,role,source,value)=>{
      const file=path.join(temp,name);if(source){await copyFile(source,file);const expected=candidate.files.find(f=>f.path===source)?.sha256;if(expected&&await fileHash(file)!==expected)throw Error('临时交付复制校验失败。');}
      else await writeFile(file,typeof value==='string'?value:JSON.stringify(value,null,2));
      files.push({id:randomUUID(),name,role,path:file,bytes:(await stat(file)).size,sha256:await fileHash(file)});
    };
    const names={video:'完整视频_未验收通过.mp4',subtitles:'字幕.srt',cover_portrait:'封面_竖版_3x4.png',cover_landscape:'封面_横版_4x3.png',copy:'发布文案.txt'};
    for(const [role,name] of Object.entries(names)){
      const f=candidate.files.find(f=>f.role===role);if(f)await add(name,role,await contained(f.path,p.run));
    }
    await add('工程与方案.json','project',null,{projectId:candidate.projectId,timelineId:candidate.timelineId,editorUrl:candidate.editorUrl,plan:p.plan,approval:p.approval});
    await add('来源.json','sources',null,p.sources.filter(s=>p.selected.includes(s.id)));
    await add('验收报告.json','qa',null,report||{completed:false,status:'awaiting_review'});
    await add('修订建议.json','qa',null,{notes:candidate.notes||[],unresolvedIssues:candidate.unresolvedIssues||[],summary:candidate.summary,missing});
    const captionCheck=report?.checks?.caption_flow,captionSync=report?.checks?.caption_sync;
    let captionsStatus='等待最终验收';
    if(!p.captions)captionsStatus='本期已关闭';
    else if(report){
      if(captionCheck?.status==='fail'||captionSync?.status==='fail')captionsStatus='字幕验收未通过';
      else if(captionCheck?.status==='pass'&&captionSync?.status==='pass')captionsStatus='已确认画面字幕和同步';
      else captionsStatus='本轮尚未确认画面字幕和同步';
    }
    await add('请先阅读.txt','other',null,fallback+'\n临时交付 · 尚未通过最终验收\n这是实际候选文件，供预览、下载或决定继续/停止制作，不能当作已通过验收的成片。\n视频内字幕：'+captionsStatus+'。\n'+(missing.length?'交付包仍有缺项：'+missing.join('；'):'已包含视频、封面、文案、方案、来源、验收报告及启用时的字幕。')+'\n');
    const archive=await bridge('archive-package',{directory:temp});
    files.push({id:randomUUID(),name:'完整临时交付.zip',role:'archive',path:archive.file,bytes:(await stat(archive.file)).size,sha256:await fileHash(archive.file)});
    await rename(temp,directory);for(const f of files)f.path=path.join(directory,f.name);
    const delivery={id:randomUUID(),key,directory,createdAt:new Date().toISOString(),jobId:candidate.producerJobId,projectId:candidate.projectId,timelineId:candidate.timelineId,editorUrl:candidate.editorUrl,files,videoId:files.find(f=>f.role==='video')?.id,qaStatus:'provisional',captionsEnabled:p.captions,captionsStatus,complete:!missing.length,missing,review:report||null,notes:fallback?[fallback]:[],verified:{duration:verified.duration,width:verified.width,height:verified.height}};
    p.provisionalDeliveries=[delivery,...(p.provisionalDeliveries||[])];return delivery;
  }finally{await rm(temp,{recursive:true,force:true});}
}
