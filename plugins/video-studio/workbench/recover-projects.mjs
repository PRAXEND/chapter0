import {readFile,readdir,stat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {initialStudio,inputHash,validatePlan,taskNames} from './studio-workflow.mjs';
import {contained,fileHash} from './media.mjs';

const key=value=>createHash('sha256').update(value).digest('hex').slice(0,32);
async function read(file){try{return JSON.parse(await readFile(file,'utf8'));}catch{return null;}}
async function directories(folder){try{return (await readdir(folder,{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>path.join(folder,e.name));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
function editorUrl(raw){try{const url=new URL(raw);if(url.protocol!=='https:'||url.hostname!=='app.chatcut.io')return '';url.search='';return url.href;}catch{return '';}}

async function recoverDeliveries(project,record){
  const found=[];if(!record.project?.projectId||!record.project?.timelineId)return found;
  for(const directory of await directories(project.outputRoot)){
    if(path.basename(directory).startsWith('.'))continue;
    const [identity,report]=await Promise.all([read(path.join(directory,'project.json')),read(path.join(directory,'delivery-report.json'))]);
    if(identity?.projectId!==record.project.projectId||identity?.timelineId!==record.project.timelineId||!report?.video?.decodeVerified||!/^[a-f0-9]{64}$/.test(report.video.sha256||''))continue;
    try{
      await contained(report.video.path,project.run);
      const video=await contained(path.join(directory,'final.mp4'),directory),info=await stat(video);
      if(info.size!==report.video.bytes||await fileHash(video)!==report.video.sha256)continue;
      const files=[];
      for(const entry of await readdir(directory,{withFileTypes:true})){
        if(!entry.isFile()||!['.mp4','.json','.md','.srt','.txt'].includes(path.extname(entry.name).toLowerCase()))continue;
        const file=await contained(path.join(directory,entry.name),directory);
        const role=entry.name==='final.mp4'?'video':entry.name.endsWith('.srt')?'subtitles':/qa|report/.test(entry.name)?'qa':/project/.test(entry.name)?'project':/sources/.test(entry.name)?'sources':entry.name.endsWith('.md')?'plan':'other';
        files.push({id:'restored-'+key(file),name:entry.name,role,path:file,bytes:(await stat(file)).size,sha256:await fileHash(file)});
      }
      found.push({id:'restored-'+key(directory),directory,createdAt:info.birthtime.toISOString(),jobId:project.jobs.find(j=>j.action==='produce')?.id||null,editorUrl:editorUrl(identity.editorUrl),projectId:identity.projectId,timelineId:identity.timelineId,files,videoId:files.find(f=>f.name==='final.mp4').id,qaStatus:'needs_review',notes:report.notes||[],verified:{...report.video,path:video},recovered:true});
    }catch{}
  }
  return found.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}

// Legacy workbench versions saved one current project. Recover only their explicit
// request/run records and validated deliveries; never launch a task or infer a new approval.
export async function recoverLegacyProjects(dataDir,current,store){
  const groups=new Map(),represented=new Set();
  for(const project of store.records.values())if(project.run){try{represented.add(await realpath(project.run));}catch{represented.add(project.run);}}
  for(const folder of await directories(path.join(dataDir,'jobs'))){
    const file=path.join(folder,'request.json'),context=await read(file);
    if(!context?.run||!context.brief?.topic||context.brief.topic==='工作台连接检查')continue;
    let run;try{run=await contained(context.run,path.join(dataDir,'runs'));}catch{continue;}
    if(represented.has(run))continue;
    const schema=await read(path.join(folder,'output.schema.json')),properties=schema?.properties||{};
    const action=properties.connected?'connect':properties.status?'produce':properties.script?'plan':properties.review?'discover':properties.sources?'collect':null;
    if(!action)continue;
    const rows=groups.get(run)||[];rows.push({context,action,id:path.basename(folder),at:(await stat(file)).mtime.toISOString()});groups.set(run,rows);
  }
  let count=0;
  for(const [run,unsorted] of groups){
    try{
      const rows=unsorted.sort((a,b)=>a.at.localeCompare(b.at)),latest=rows.at(-1).context,record=await read(path.join(run,'run.json'));
      if(!record||!rows.some(r=>r.action!=='connect'))continue;
      const p=initialStudio(),r=latest.brief.requirements||{};
      // Preserve the approval input format of the recorded run, not today's new-project defaults.
      if(record.production_policy_version!==1)delete p.workflowVersion;
      p.portraitBottomInset=r.portrait_bottom_inset??.18;p.replayAuthorization=r.replay_authorization??null;
      Object.assign(p,{id:'restored-'+key(run),title:latest.brief.topic,topic:latest.brief.topic,purpose:latest.brief.purpose||'',duration:r.max_seconds||r.target_seconds||30,ratio:r.width===r.height?'1:1':r.width>r.height?'16:9':'9:16',fps:r.fps||30,language:r.language||'zh-CN',narration:!!r.narration,captions:!!r.captions,music:latest.settings?.music||'none',voiceDirection:latest.settings?.voiceDirection||'',styleSelector:latest.brief.style||null,styleDescription:latest.settings?.styleDescription||'',outputRoot:path.isAbsolute(latest.outputDirectory||'')?latest.outputDirectory:current.outputRoot,run,createdAt:record.created_at||rows[0].at,updatedAt:record.updated_at||rows.at(-1).at,recovery:{kind:'legacy_workbench',recoveredAt:new Date().toISOString(),note:'从现存任务请求、方案与制作文件恢复。未保存的旧网页编辑和完整执行日志无法还原。'}});
      const sources=new Map();for(const row of rows)for(const source of [...(row.context.knownSources||[]),...(row.context.source?[row.context.source]:[]),...(row.context.selectedSources||[])])if(source?.id)sources.set(source.id,source);
      p.sources=[...sources.values()];
      for(const source of p.sources)if(source.status==='ready'){
        try{const file=await contained(source.localPath,run);if(await fileHash(file)!==source.sha256)throw new Error();}
        catch{source.status='candidate';source.localPath='';source.thumbnailPath=null;source.cacheError='旧素材文件缺失或变化，请重新采集。';}
      }
      const selection=await read(path.join(run,'material-selection.json'));
      p.selected=(selection?.topic===p.topic?selection.selected_source_ids||[]:(latest.selectedSources||[]).map(s=>s.id)).filter(id=>p.sources.some(s=>s.id===id&&s.status==='ready'));
      p.sourceReview=latest.sourceReview||null;
      const approval=await read(path.join(run,'script-storyboard-approval.json')),plan=await read(path.join(run,'workbench-plan.json'));
      if(plan)try{
        p.plan={...validatePlan(plan,p),version:approval?.version||1,planHash:approval?.file_sha256,inputHash:approval?.input_hash,file:approval?.file};
        if(approval?.status==='confirmed'&&approval.input_hash===inputHash(p)&&await fileHash(await contained(approval.file,run))===approval.file_sha256)p.approval={status:'confirmed',planHash:approval.file_sha256,inputHash:approval.input_hash,version:approval.version,confirmedAt:approval.confirmed_at,authority:approval.authority||{kind:'user_click'}};
        else p.plan.stale=true;
      }catch{p.recovery.planUnavailable=true;}
      p.jobs=rows.slice().reverse().map(row=>({id:row.id,action:row.action,label:taskNames[row.action],status:'interrupted',startedAt:row.at,inputHash:row.context.inputHash,planHash:row.context.planHash,events:[],toolCalls:[],summary:'已恢复原请求；旧本地会话已结束，完整执行日志不可还原。',editorUrl:editorUrl(record.project?.editorUrl),sourceReport:undefined}));
      for(const job of p.jobs)if(await read(path.join(run,'source-searches',job.id+'.json')))job.sourceReport=path.join(run,'source-searches',job.id+'.json');
      p.deliveries=await recoverDeliveries(p,record);
      const production=p.jobs.find(j=>j.action==='produce');if(production&&p.deliveries.length){production.status='completed';production.summary='实际成片和交付记录已恢复，文件大小与哈希已重新核对。';production.deliveryId=p.deliveries[0].id;}
      await store.save(p);represented.add(run);count++;
    }catch(e){store.errors.push({file:path.basename(run),error:'恢复旧项目失败：'+e.message});}
  }
  return count;
}
