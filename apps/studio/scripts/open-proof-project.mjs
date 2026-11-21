import fs from 'node:fs/promises';
import path from 'node:path';
import {startStudio} from '../src/server.mjs';

const file=process.argv[2];if(!file)throw Error('用法：node open-proof-project.mjs <media-proof 产出的 media-project.json>');
const seed=JSON.parse(await fs.readFile(file));const sourceRoot=path.dirname(path.resolve(file));
const app=await startStudio();
try {
  const store=app.store;
  const projects=store.list().map(row=>store.get(row.id));
  let p=projects.find(row=>row.mediaProof===sourceRoot)||projects.find(row=>row.title===seed.title&&!row.timeline.clips.length&&row.assets.some(a=>a.sha256===seed.assets[0].sha256));
  if(!p || !p.timeline.clips.length){
    p ||= store.create({mode:'script',title:seed.title,brief:seed.brief,profile:seed.profile,style:{id:'neutral',version:1},settings:{voiceMode:'clone',voiceConsent:true,publishPackage:true}});
    store.setMeta(p.id,{mediaProof:sourceRoot});
    const ids=new Map();
    for(const a of seed.assets){
      const imported=await store.addAsset(p.id,a.path,{...a.source,name:a.name});
      if(a.sha256&&a.sha256!==imported.sha256)throw Error('样片源文件指纹不符：'+a.name);
      ids.set(a.id,imported.id);
    }
    const receipt=seed.assets.find(a=>a.source?.referenceHash)?.source;
    const ref=await store.addAsset(p.id,path.join(sourceRoot,'assets','synthetic-reference.wav'),{name:'系统中文合成的授权测试参考.wav',consent:true});
    if(ref.sha256!==receipt.referenceHash)throw Error('参考录音指纹与合成回执不符。');
    p=store.configure(p.id,store.get(p.id).revision,{settings:{voiceReferenceAssetId:ref.id,voiceReferenceText:receipt.referenceText,referenceHash:ref.sha256}});
    const cmds=[];for(const c of seed.timeline.clips){const clip={...c,assetId:ids.get(c.assetId)};cmds.push({op:'add',clip});if(c.locked)cmds.push({op:'lock',id:c.id,locked:true});}
    p=store.apply(p.id,p.revision,cmds,'user');p=store.setMeta(p.id,{mediaProof:sourceRoot});
  }
  const videos=p.timeline.clips.filter(c=>c.track==='video'&&c.locked);
  const cues=p.timeline.clips.filter(c=>c.track==='caption');
  if(!videos.length||!cues[1])throw Error('样片缺少锁定镜头或第二条字幕');
  const edit=cues[1];const newText=edit.text.replace(/[。！]?$/,'！');
  store.setMeta(p.id,{selection:{clipId:edit.id,fromFrame:edit.start,toFrame:edit.start+edit.duration}});
  const available=store.listJobs(p.id).find(j=>j.status==='done'&&j.revision===p.revision&&j.kind==='revise');
  if(available){console.log(JSON.stringify({projectId:p.id,jobId:available.id,status:available.qa?.status,files:available.files}));}
  else{
    const j=app.queue.enqueue(p.id,'revise',{engine:'codex',baseRevision:p.revision,selection:store.get(p.id).selection,
      message:'只修改所选字幕 '+edit.id+' 的文字为“'+newText+'”。所有旁白、时间、其他字幕与画面保持原样。请直接用 studio_edit 提交这一处改动。'});
    let result,last='';
    while(true){
      await new Promise(r=>setTimeout(r,1000));result=store.getJob(j.id);
      const state=result.status+' '+result.phase;if(state!==last){console.log(state);last=state;}
      if(['done','failed','paused'].includes(result.status))break;
    }
    if(result.status!=='done')throw Error(result.error);
    const after=store.get(p.id);
    if(after.timeline.clips.find(c=>c.id===edit.id).text!==newText||videos.some(v=>JSON.stringify(v)!==JSON.stringify(after.timeline.clips.find(c=>c.id===v.id))))throw Error('改稿结果或锁定范围不符');
    const changed=after.timeline.clips.filter(c=>JSON.stringify(c)!==JSON.stringify(p.timeline.clips.find(old=>old.id===c.id)));
    if(changed.length!==1||changed[0].id!==edit.id)throw Error('改稿影响了用户指定范围以外的片段');
    console.log(JSON.stringify({projectId:p.id,jobId:j.id,status:result.qa?.status,issues:result.qa?.issues?.map(i=>i.message),files:result.files}));
  }
}finally{await app.close();}
