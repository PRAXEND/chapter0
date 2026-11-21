import {randomInt,randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {mkdir,readFile,readdir,realpath,link,rm,writeFile} from 'node:fs/promises';
import {fileSha256} from './style.mjs';

const kinds=['gate','style','pair'];
const modes=['topic','script','interview'];
const statuses=['deliverable','advisory','repair','unverified'];
const uuid=/^[a-f0-9-]{36}$/i;
const titleMax=180;
function check(ok,msg) {if(!ok) throw Error(msg);}
function shuffle(items) {
  const copy=items.slice();
  for(let i=copy.length-1;i>0;i--) {const k=randomInt(i+1);[copy[i],copy[k]]=[copy[k],copy[i]];}
  return copy;
}
async function writeOnce(file,data) {
  await mkdir(path.dirname(file),{recursive:true});
  const temp=file+'.'+randomUUID()+'.tmp';
  try {await writeFile(temp,JSON.stringify(data),{mode:0o600,flag:'wx'});await link(temp,file);}
  finally {await rm(temp,{force:true});}
}
const readJson=async file=>JSON.parse(await readFile(file,'utf8'));
function reviewerKey(name) {
  check(typeof name==='string' && name.trim().length>=1 && name.trim().length<=80,'请填写审片人名称');
  return createHash('sha256').update(name.trim().normalize('NFKC')).digest('hex');
}
const details=(s)=>({id:s.id,title:s.title,kind:s.kind,count:s.samples.length,createdAt:s.createdAt});
const incomplete=(error)=>{if(error.code==='ENOENT') return null;throw error;};
export function createBlindReview(dataRoot,{allowedRoots=[]}={}) {
  const folder=path.resolve(dataRoot,'blind-reviews');
  const roots=[path.resolve(dataRoot),...allowedRoots.map(x=>path.resolve(x))];
  const dir=(id)=>{check(uuid.test(id),'盲评编号无效');return path.join(folder,id);};
  async function mediaPath(file) {
    check(typeof file==='string' && path.isAbsolute(file),'请从工作台选择项目输出文件');
    const target=await realpath(file);
    let allowed=false;
    for(const root of roots) {
      const resolved=await realpath(root).catch(incomplete);
      if(!resolved) continue;
      const relative=path.relative(resolved,target);
      if(relative && relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative)) {allowed=true;break;}
    }
    check(allowed && ['.mp4','.mov','.m4v','.webm'].includes(path.extname(target).toLowerCase()),'请选择项目目录内已授权的视频');
    return target;
  }
  async function snap(input) {
    const file=await mediaPath(input);
    return {file,hash:await fileSha256(file)};
  }
  async function create({kind,samples,title='看片盲评',choices=[]}) {
    check(kinds.includes(kind)&&Array.isArray(samples)&&samples.length>0&&samples.length<=100,'研究类型或样本数无效');
    check(typeof title==='string'&&title.trim().length>0&&title.length<=titleMax,'研究标题无效');
    const prepared=[];
    for(const s of samples) {
      check(modes.includes(s.mode),'样本须注明制作入口');
      const clip=await snap(s.videoPath);
      const row={key:randomUUID(),mode:s.mode,clip};
      if(kind==='gate') {
        check(statuses.includes(s.systemStatus),'请冻结此候选的系统验收状态');
        row.systemStatus=s.systemStatus;
        row.systemIssues=(s.systemIssues||[]).filter(i=>['major','blocker'].includes(i.severity)&&Number.isInteger(i.fromFrame)&&Number.isInteger(i.toFrame)).map(i=>({fromFrame:i.fromFrame,toFrame:i.toFrame}));
      } else if(kind==='style') {
        check(typeof s.expected==='string'&&s.expected.length>0&&s.expected.length<100&&typeof s.topicGroup==='string'&&s.topicGroup.length>0,'风格盲评需真值风格及题材分组');
        row.expected=s.expected;row.topicGroup=s.topicGroup;
      } else {
        row.other=await snap(s.comparisonPath);
        check(s.primary==='workbench'||s.primary==='foreground','请登记两版来源');
        row.primary=s.primary;
      }
      prepared.push(row);
    }
    if(kind==='style') {
      choices=[...new Set([...choices,...prepared.map(s=>s.expected)])].sort();
      check(choices.length>=2&&choices.length<=12,'请提供至少两项可辨认的风格');
    }
    const study={id:randomUUID(),kind,title:title.trim(),choices,createdAt:new Date().toISOString(),samples:prepared};
    await writeOnce(path.join(dir(study.id),'study.json'),study);
    return details(study);
  }
  async function list() {
    const records=await readdir(folder,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT') return [];throw e;});
    const studies=await Promise.all(records.filter(r=>r.isDirectory()&&uuid.test(r.name)).map(r=>readJson(path.join(dir(r.name),'study.json')).catch(incomplete)));
    return studies.filter(Boolean).map(details).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  const load=id=>readJson(path.join(dir(id),'study.json'));
  async function assignment(study,name) {
    const file=path.join(dir(study.id),'reviewers',reviewerKey(name),'assignment.json');
    const saved=await readJson(file).catch(incomplete);
    if(saved) return saved;
    const slots=shuffle(study.samples.map(s=>s.key)).map(key=>({key,code:randomUUID(),swap:study.kind==='pair'&&Boolean(randomInt(2))}));
    try {await writeOnce(file,slots);return slots;} catch(e) {if(e.code==='EEXIST') return readJson(file);throw e;}
  }
  const responseFile=(id,name,code)=>path.join(dir(id),'reviewers',reviewerKey(name),'answers',code+'.json');
  async function open(id,name) {
    const study=await load(id),slots=await assignment(study,name),items=[];
    for(const [index,slot] of slots.entries()) {
      const answer=await readJson(responseFile(id,name,slot.code)).catch(incomplete);
      items.push({code:slot.code,index:index+1,sides:study.kind==='pair'?['A','B']:['A'],answered:!!answer});
    }
    return {...details(study),items,choices:study.kind==='style'?study.choices:study.kind==='gate'?['usable','minor','redo']:['A','B','tie']};
  }
  async function media(id,name,code,side='A') {
    check(uuid.test(code)&&['A','B'].includes(side),'样本编号无效');
    const study=await load(id),slots=await assignment(study,name),slot=slots.find(r=>r.code===code);
    check(slot&&(side==='A'||study.kind==='pair'),'此样本不属于当前评审');
    const row=study.samples.find(s=>s.key===slot.key);
    const asset=(side==='A'&&!slot.swap || side==='B'&&slot.swap)?row.clip:row.other;
    const file=await mediaPath(asset.file);
    check(await fileSha256(file)===asset.hash,'候选文件在分组后已变化，请重新建立研究');
    return file;
  }
  async function rate(id,name,{code,decision,observation,fromFrame,toFrame,dimensions}) {
    const study=await load(id),slots=await assignment(study,name),slot=slots.find(r=>r.code===code);
    check(!!slot,'样本编号无效');
    const choices=study.kind==='style'?study.choices:study.kind==='gate'?['usable','minor','redo']:['A','B','tie'];
    check(choices.includes(decision),'选择项无效');
    check(typeof observation==='string' && observation.trim().length>0&&observation.length<=3000,'请记录可见画面或实际听感的依据');
    if(study.kind==='gate'&&decision==='redo') check(Number.isInteger(fromFrame)&&Number.isInteger(toFrame)&&fromFrame>=0&&toFrame>=fromFrame,'请记录严重问题在视频中的帧区间');
    const verifiedFile=await media(id,name,code);
    if(study.kind==='pair') await media(id,name,code,'B');
    check(!!verifiedFile,'视频未就绪');
    const vote={key:slot.key,decision,observation:observation.trim(),fromFrame,toFrame,at:new Date().toISOString()};
    if(study.kind==='pair') {
      const sample=study.samples.find(s=>s.key===slot.key);
      const primary=(decision==='A'&&!slot.swap)||(decision==='B'&&slot.swap);
      vote.selection=decision==='tie'?'tie':primary?sample.primary:sample.primary==='workbench'?'foreground':'workbench';
      vote.dimensions=Object.fromEntries(['facts','shots','sync','rework'].map(k=>[k,String(dimensions?.[k]||'').slice(0,500)]));
    }
    try {await writeOnce(responseFile(id,name,code),vote);} catch(e) {if(e.code==='EEXIST') throw Error('该样本的独立评审已提交');throw e;}
    return {accepted:true};
  }
  async function summary(id) {
    const study=await load(id),reviewRoot=path.join(dir(id),'reviewers');
    const saved=await readdir(reviewRoot,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT') return [];throw e;});
    const complete=[];
    for(const r of saved.filter(d=>d.isDirectory())) {
      const answers=path.join(reviewRoot,r.name,'answers');
      const files=await readdir(answers).catch(e=>{if(e.code==='ENOENT') return [];throw e;});
      const votes=await Promise.all(files.filter(f=>uuid.test(f.replace(/\.json$/,''))&&f.endsWith('.json')).map(f=>readJson(path.join(answers,f))));
      if(votes.length===study.samples.length) complete.push(new Map(votes.map(v=>[v.key,v])));
    }
    const result={...details(study),completeReviewers:complete.length,thresholdMet:null,disagreements:0,status:'awaiting-human-ratings'};
    if(complete.length<2) return result;
    const modesSeen=new Set(study.samples.map(s=>s.mode)),groups=new Map();
    const metrics={usable:0,severe:0,falseBlocks:0,severeLocated:0,identified:0,workbench:0,foreground:0,tie:0};
    for(const s of study.samples) {
      const votes=complete.map(v=>v.get(s.key)).filter(Boolean);
      const answers=votes.map(v=>study.kind==='gate'?v.decision==='redo'?'severe':'usable':study.kind==='pair'?v.selection:v.decision);
      const winners=[...new Set(answers)].filter(v=>answers.filter(k=>k===v).length>answers.length/2);
      if(winners.length!==1) {result.disagreements++;continue;}
      const win=winners[0];
      if(study.kind==='gate') {
        metrics[win]++;
        if(win==='usable' && ['repair','unverified'].includes(s.systemStatus)) metrics.falseBlocks++;
        if(win==='severe' && s.systemStatus==='repair') {
          const severeVotes=votes.filter(v=>v.decision==='redo');
          const located=severeVotes.filter(v=>s.systemIssues.some(i=>i.fromFrame<=v.toFrame&&i.toFrame>=v.fromFrame));
          if(located.length>severeVotes.length/2) metrics.severeLocated++;
        }
      } else if(study.kind==='style') {
        if(win===s.expected) metrics.identified++;
        const n=groups.get(s.topicGroup)||new Map(); n.set(s.expected,(n.get(s.expected)||0)+1);groups.set(s.topicGroup,n);
      } else metrics[win]++;
    }
    result.status=result.disagreements?'needs-adjudication':'scored';result.metrics=metrics;
    if(!result.disagreements && study.kind==='gate') {
      result.thresholdMet=study.samples.length===18&&modes.every(m=>modesSeen.has(m))&&metrics.usable===12&&metrics.severe===6&&metrics.falseBlocks<=1&&metrics.severeLocated===6;
    } else if(!result.disagreements&&study.kind==='style') {
      const layout=groups.size===3&&study.choices.length===2&&[...groups.values()].every(g=>study.choices.every(id=>g.get(id)===2));
      result.thresholdMet=layout&&study.samples.length===12&&metrics.identified>=10;
    }
    return result;
  }
  return {list,create,open,rate,summary,media};
}
