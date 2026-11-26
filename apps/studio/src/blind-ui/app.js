const el=id=>document.getElementById(id);
const show=(id,yes=true)=>{el(id).hidden=!yes;};
const setNotice=value=>{el('notice').textContent=value||'';};
const labels={gate:'交付判断',style:'风格辨认',pair:'前台与工作台配对',usable:'愿意直接用',minor:'愿意用但想小修',redo:'必须重剪',tie:'两版相当',A:'A 版',B:'B 版'};
const dimensionNames={facts:'事实与叙事',shots:'镜头选择',sync:'声画落点',rework:'需要返工之处'};
let candidates=[],studies=[],chosen,session,active,loading=false;
const sampleDrafts=new Map(),ballotDrafts=new Map();
let currentKind='gate',viewer='';
function updateControls(){
  const rows=[...el('samples').querySelectorAll('.sample')],pair=el('kind').value==='pair';
  const complete=rows.length&&rows.every(r=>r.querySelector('.source')?.value&&(!pair||r.querySelector('.comparison')?.value&&r.querySelector('.comparison').value!==r.querySelector('.source').value)&&(!r.querySelector('.expected')||r.querySelector('.expected').value.trim()));
  el('create').disabled=loading||!el('title').value.trim()||!complete;
  el('create').title=complete?'':'先填完整样本，配对时选择不同候选。';
  el('begin').disabled=loading||!el('reviewer').value.trim();
  const decision=el('decision').value,range=session?.kind==='gate'&&decision==='redo';
  el('ballot').querySelector('button.primary').disabled=loading||!viewer||viewer!==el('reviewer').value.trim()||!decision||!el('observation').value.trim()||(range&&(!el('from').value||!el('to').value||Number(el('to').value)<=Number(el('from').value)));
}
function ballotKey(){return chosen&&active&&viewer?JSON.stringify([chosen.id,viewer,active.code]):null;}
function rememberBallot(){const key=ballotKey();if(!key||el('screen').hidden)return;ballotDrafts.set(key,[...el('ballot').querySelectorAll('input,select,textarea')].map(f=>f.value));}
function rememberSetup(){sampleDrafts.set(currentKind,[...el('samples').children].map(r=>[...r.querySelectorAll('input,select')].map(f=>f.value)));}
function renderSetup(){currentKind=el('kind').value;el('samples').replaceChildren();for(const values of sampleDrafts.get(currentKind)||[[]]){sample();const fields=el('samples').lastChild.querySelectorAll('input,select');values.forEach((v,i)=>{if(fields[i])fields[i].value=v;});}updateControls();}
async function api(url,body) {
  const res=await fetch(url,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();
  if(!res.ok) throw Error(data.error||'请求失败');
  return data;
}
function run(fn) {return async e=>{
  e?.preventDefault();if(loading)return;loading=true;const main=document.querySelector('main');main.inert=true;
  setNotice('');try{await fn(e);}catch(error){setNotice(error.message);}finally{loading=false;main.inert=false;updateControls();}
};}
function make(tag,text='',parent) {const n=document.createElement(tag);n.textContent=text;if(parent)parent.append(n);return n;}
function control(tag,label,wrapper) {const group=make('label',label,wrapper);const input=document.createElement(tag);group.append(input);return input;}
function option(select,value,label) {const o=make('option',label,select);o.value=value;}
function sourcePick(wrapper,label,cls) {
  const select=control('select',label,wrapper);select.className=cls;
  for(const item of candidates.filter(c=>c.jobId||el('kind').value==='pair')) option(select,item.jobId||item.assetId,item.title+(item.jobId?' · v'+item.revision:' · 已导入视频')+' · '+String(item.createdAt||'').slice(0,10));
  return select;
}
function sample() {
  const section=make('div','',el('samples'));section.className='sample';
  sourcePick(section,'候选成片','source');
  if(el('kind').value==='style') {
    control('input','实际风格',section).className='expected';
    control('input','题材组',section).className='group';
  }
  if(el('kind').value==='pair') {
    sourcePick(section,'对比成片','comparison');
    const src=control('select','第一份候选来自',section);src.className='primary-source';option(src,'workbench','工作台');option(src,'foreground','前台 Codex');
    const details=make('details','',section);make('summary','两端输入与模型条件',details);
    for(const [k,label] of Object.entries({model:'相同模型',effort:'相同推理档',promptHash:'需求文本 SHA-256',imageHash:'输入帧 SHA-256',notes:'补充条件'})) control('input',label,details).dataset.condition=k;
  }
  const remove=make('button','移除',section);remove.onclick=()=>{section.remove();updateControls();};
}
async function refresh() {
  studies=await api('/api/blind/studies');el('studies').replaceChildren();
  for(const s of studies) {
    const row=make('div','',el('studies'));row.className='row';make('span',s.title+' · '+labels[s.kind]+' · '+s.count+' 段',row);
    const btn=make('button','打开',row);btn.onclick=run(()=>choose(s));
  }
  if(!studies.length) make('p','尚未建立盲评。',el('studies'));
}
async function choose(s) {
  rememberBallot();viewer='';active=null;chosen=s;session=null;el('study-title').textContent=s.title;show('setup',false);show('screen',false);show('identity');await progress();
  const url=new URL(location.href);url.searchParams.set('study',s.id);history.replaceState(null,'',url);
}
async function progress(scores=false) {
  if(!chosen) return;
  const p=await api('/api/blind/studies/'+chosen.id+'/summary');show('report');const dest=el('report-text');dest.replaceChildren();
  make('p','已完成全部样本的审片人 '+p.completeReviewers+' 位。',dest);
  if(!scores) return;
  if(p.status==='awaiting-human-ratings') {make('p','两位审片人分别提交后显示汇总。',dest);return;}
  if(p.disagreements) make('p','有 '+p.disagreements+' 段意见仍不一致，可由第三位审片人独立复核。',dest);
  const m=p.metrics;
  if(p.kind==='gate') make('p','可用 '+m.usable+' 段，其中误拦 '+m.falseBlocks+' 段。严重 '+m.severe+' 段，其中正确拦截并定位 '+m.severeLocated+' 段。',dest);
  if(p.purpose==='calibration') make('p','按新规则重分类后，仍被拦住的可用片有 '+m.reclassifiedFalseBlocks+' 段。这组用于历史校准。',dest);
  if(p.kind==='style') make('p','正确辨认 '+m.identified+' / '+p.count+' 段。',dest);
  if(p.kind==='pair') {make('p','工作台更好 '+m.workbench+' 次，前台更好 '+m.foreground+' 次，相当 '+m.tie+' 次。',dest);if(!p.matchedInputsRecorded) make('p','本组尚未登记完整匹配条件，用作探索性对照。',dest);}
  if(p.thresholdMet!==null) make('p',p.thresholdMet?'达到首发样本门槛。':'本组尚未达到完整首发样本门槛。',dest);
}
async function loadSession() {
  viewer=el('reviewer').value.trim();session=await api('/api/blind/studies/'+chosen.id+'/session',{reviewer:viewer});
  active=session.items.find(i=>!i.answered);
  if(!active){el('movies').replaceChildren();show('screen',false);setNotice('这一组样本已评完。');await progress(true);return;}
  show('screen');el('progress').textContent='样本 '+active.index+' / '+session.count;el('movies').replaceChildren();el('decision').replaceChildren();el('observation').value='';el('from').value='';el('to').value='';
  for(const s of active.sides) {
    const figure=make('figure','',el('movies')),video=make('video','',figure);
    video.controls=true;video.preload='metadata';video.src='/api/blind/studies/'+chosen.id+'/media?'+new URLSearchParams({reviewer:el('reviewer').value,code:active.code,side:s});
    video.onerror=()=>setNotice('候选无法播放，请检查原文件或重新准备研究。');
    if(active.sides.length>1) make('figcaption',s+' 版',figure);
  }
  for(const decision of session.choices) option(el('decision'),decision,labels[decision]||decision);
  el('dimensions').replaceChildren();show('dimensions',session.kind==='pair');
  if(session.kind==='pair') for(const [key,label] of Object.entries(dimensionNames)) control('input',label,el('dimensions')).dataset.dimension=key;
  const saved=ballotDrafts.get(ballotKey());if(saved){const fields=el('ballot').querySelectorAll('input,select,textarea');saved.forEach((v,i)=>{if(fields[i])fields[i].value=v;});}
  el('decision').onchange();
}
el('decision').onchange=()=>show('range',session?.kind==='gate'&&el('decision').value==='redo');
el('new').onclick=run(async()=>{
  candidates=await api('/api/blind/candidates');if(!candidates.length) throw Error('请先在工作台完成至少一个可播放的正式候选。');
  rememberBallot();if(!el('setup').hidden)rememberSetup();viewer='';active=null;chosen=null;show('setup');show('screen',false);show('identity',false);show('report',false);renderSetup();
});
el('kind').onchange=()=>{rememberSetup();renderSetup();};
el('add').onclick=()=>{sample();updateControls();};
el('create').onclick=run(async()=>{
  const samples=[...el('samples').querySelectorAll('.sample')].map(row=>{
    const source=candidates.find(c=>(c.jobId||c.assetId)===row.querySelector('.source')?.value);
    const comp=candidates.find(c=>(c.jobId||c.assetId)===row.querySelector('.comparison')?.value);
    const conditions=Object.fromEntries([...row.querySelectorAll('[data-condition]')].map(i=>[i.dataset.condition,i.value]));
    return {...source,expected:row.querySelector('.expected')?.value.trim(),topicGroup:row.querySelector('.group')?.value.trim(),comparisonProjectId:comp?.projectId,comparisonJobId:comp?.jobId,comparisonAssetId:comp?.assetId,primary:row.querySelector('.primary-source')?.value,conditions};
  });
  const s=await api('/api/blind/studies',{kind:el('kind').value,title:el('title').value,samples});await refresh();await choose(s);
});
el('begin').onclick=run(loadSession);
el('reviewer').addEventListener('input',()=>{if(viewer&&el('reviewer').value.trim()!==viewer){rememberBallot();viewer='';active=null;session=null;show('screen',false);el('movies').replaceChildren();}});
document.addEventListener('input',e=>{if(!e.target.closest('#guide-dialog'))updateControls();});
document.addEventListener('change',e=>{if(!e.target.closest('#guide-dialog'))updateControls();});
for(const which of ['from','to']) el('mark-'+which).onclick=()=>{const movie=el('movies').querySelector('video');if(movie) el(which).value=movie.currentTime.toFixed(3);};
el('ballot').onsubmit=run(async()=>{
  const dims=Object.fromEntries([...el('dimensions').querySelectorAll('input')].map(i=>[i.dataset.dimension,i.value]));
  if(!viewer||viewer!==el('reviewer').value.trim()||!active)throw Error('请先以当前审片人身份开始看片。');
  const answer={reviewer:viewer,code:active.code,decision:el('decision').value,observation:el('observation').value,dimensions:dims};
  if(session.kind==='gate'&&answer.decision==='redo'){
    if(!el('from').value||!el('to').value)throw Error('请记录需要重剪的播放区间。');
    answer.fromSeconds=Number(el('from').value);answer.toSeconds=Number(el('to').value);
  }
  await api('/api/blind/studies/'+chosen.id+'/rating',answer);ballotDrafts.delete(ballotKey());await loadSession();
});
await run(async()=>{await refresh();const id=new URLSearchParams(location.search).get('study'),s=studies.find(x=>x.id===id);if(s){show('library',false);await choose(s);}})();
