const el=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const urlPart=encodeURIComponent;
const btn=(act,label,cls='',id='')=>`<button type="button" data-act="${esc(act)}" data-id="${esc(id)}" class="${esc(cls)}">${esc(label)}</button>`;
const field=(label,control)=>`<label class="field">${label}${control}</label>`;
const input=(id,value='',kind='text',extra='')=>`<input id="${id}" type="${kind}" value="${esc(value)}" ${extra}>`;
const area=(id,value='',rows=3,ph='')=>`<textarea id="${id}" rows="${rows}" placeholder="${esc(ph)}">${esc(value)}</textarea>`;
const select=(id,rows,chosen)=>`<select id="${id}">${rows.map(([v,l])=>`<option value="${esc(v)}" ${String(v)===String(chosen)?'selected':''}>${esc(l)}</option>`).join('')}</select>`;
const check=(id,label,selected)=>`<label class="check"><input id="${id}" type="checkbox" ${selected?'checked':''}>${esc(label)}</label>`;
const fileInput=(id,multiple=true)=>`<input id="${id}" type="file" accept="video/*,audio/*,image/*" ${multiple?'multiple':''}>`;
const val=id=>el(id)?.value||'';
const tracks={video:'画面',narration:'人声',music:'配乐',caption:'字幕',graphic:'动效'};
const modeLabels={topic:'从选题开始',script:'脚本与素材',interview:'精剪原片'};
const statusLabels={queued:'等待中',running:'制作中',pausing:'正在暂停',paused:'已暂停',done:'已完成',failed:'需要处理'};
const s={projects:[],styles:[],voices:[],p:null,mode:'topic',tab:'edit',clip:null,jobs:[],form:{},style:null,notice:0,polling:false,newFiles:[]};
const clock=v=>{const n=Math.max(0,Math.floor(Number(v)||0));return Math.floor(n/60)+':'+String(n%60).padStart(2,'0');};
const assetName=id=>s.p?.assets.find(a=>a.id===id)?.name||'';
const aid=id=>'/api/projects/'+s.p.id+'/assets/'+urlPart(id);
async function api(route,body,opts={}){
  const res=await fetch(route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),...opts});
  const data=await res.json();if(!res.ok){const e=new Error(data.error||'请求失败');e.status=res.status;throw e;}return data;
}
const proj=(suffix='',body)=>api('/api/projects/'+s.p.id+suffix,body);
function notice(m){if(!m)return;el('notice').textContent=m;el('notice').hidden=false;clearTimeout(s.notice);s.notice=setTimeout(()=>el('notice').hidden=true,6000);}
function modal(title,html){el('dialog-title').textContent=title;el('dialog-body').innerHTML=html;if(!el('dialog').open)el('dialog').showModal();}
function dismiss(){el('dialog').close();}
function safeAction(action){return async(...args)=>{try{await action(...args);}catch(e){notice(e.message);if(e.status===409&&s.p)await reload().catch(()=>{});}};}
const renderNav=()=>{el('projects').innerHTML=s.projects.map(p=>btn('open-project',p.title,p.id===s.p?.id?'active':'',p.id)).join('');};
async function refreshList(){s.projects=await api('/api/projects');renderNav();}
async function choose(id,tab='edit'){s.p=await api('/api/projects/'+urlPart(id));s.jobs=await proj('/jobs');s.tab=tab;s.clip=s.p.selection?.clipId||null;s.style=null;await refreshList();draw();}
async function reload(){if(s.p)await choose(s.p.id,s.tab);}
const frameRate=()=>s.p.profile.fps;
function captureNew(){
  if(el('new-title'))s.form={title:val('new-title'),brief:val('brief'),script:val('script'),style:val('new-style'),ratio:val('ratio'),sourceUrls:val('new-urls'),factUrls:val('new-facts'),voice:val('new-voice'),shareFrames:el('new-share-frames').checked,shareTranscript:el('new-share-text').checked};
  if(el('new-files')?.files.length)s.newFiles=[...el('new-files').files];
}
function newPage(fresh=true){
  if(fresh){s.p=null;s.tab='new';s.form={};s.newFiles=[];s.mode='topic';}
  renderNav();el('current-title').textContent='新建工程';el('top-actions').innerHTML=btn('import-folder','打开工程文件夹');
  const f=s.form;
  el('content').innerHTML=`<section class="page new-page"><div class="kicker">创建视频</div><h1>从哪里开始剪？</h1>
  <div class="modes">${Object.entries(modeLabels).map(([k,v],n)=>`<button data-act="mode" data-id="${k}" class="mode ${s.mode===k?'chosen':''}"><span class="mode-icon">${['◉','▤','▥'][n]}</span><strong>${v}</strong><small>${['找来源、写稿并组接画面','按原稿匹配镜头与旁白','保留同期声，按原句精剪'][n]}</small></button>`).join('')}</div>
  <div class="card">${field('工程名称',input('new-title',f.title,'text','placeholder="例如，岛上的第一场雨" maxlength="160"'))}
  ${field(s.mode==='topic'?'选题与制作要求':'制作要求',area('brief',f.brief,3,s.mode==='interview'?'保留哪些观点，想剪成多长？':'想让观众看懂什么？'))}
  ${s.mode==='script'?field('脚本',area('script',f.script,5,'粘贴准备好的旁白或分镜稿')):''}
  ${s.mode==='topic'?field('出处网页（每行一个，可选）',area('new-facts',f.factUrls,2))+field('可用的媒体文件直链（可选）',area('new-urls',f.sourceUrls,2)):''}
  <div class="form-grid">${field('画幅',select('ratio',[['16:9','16:9 横屏'],['9:16','9:16 竖屏'],['1:1','1:1 方形']],f.ratio||'16:9'))}${field('风格',select('new-style',styleOptions(),f.style|| (s.mode==='interview'?'original-dialogue@1':'neutral@1')))}</div>
  ${s.voices.length?field('本期音色',select('new-voice',[['','随入口默认'],...s.voices.map(v=>[v.id,v.name])],f.voice||'')):''}<div class="outline">${field(s.mode==='interview'?'原片':'本地素材',fileInput('new-files'))}<small id="selected-files">${s.newFiles.length?esc(s.newFiles.map(f=>f.name).join('、')):'支持视频、音频和图片，可在工程中继续添加。'}</small></div>
  <fieldset><legend>给 Codex 的创作资料</legend>${check('new-share-text','分享语音转录文字',f.shareTranscript!==false)}${check('new-share-frames','分享选取的素材、风格及剪辑预览帧',f.shareFrames===true)}</fieldset>
  <div class="actions">${btn('create','仅创建工程')}${btn('create-run','创建并开始制作','primary')}</div></div>
  <input type="file" id="folder-picker" webkitdirectory multiple hidden></section>`;
}
function styleOptions(){const rows=s.styles.flatMap(i=>(i.versions||[i.version]).map(v=>[i.id+'@'+v,(i.name||i.id)+' · v'+v]));if(!rows.some(r=>r[0]==='neutral@1'))rows.unshift(['neutral@1','自由剪辑']);return rows;}
function styleSelector(value){const [id,version]=String(value||'neutral@1').split('@');return {id,version:Number(version)||1};}
async function uploadFiles(projectId,files){
  for(const [n,file] of [...files].entries()){
    notice('导入 '+(n+1)+' / '+files.length+' · '+file.name);
    await api('/api/projects/'+projectId+'/assets',undefined,{method:'POST',headers:{'X-File-Name':encodeURIComponent(file.name)},body:file});
  }
}
async function create(run){
  captureNew();const f=s.form,mode=s.mode;const ratio=f.ratio==='9:16'?[1080,1920]:f.ratio==='1:1'?[1080,1080]:[1920,1080];
  if(!f.title?.trim()&&!f.brief?.trim()&&!f.script?.trim()&&!s.newFiles.length)throw Error('请填写选题、脚本或选择原片。');
  const p=await api('/api/projects',{mode,title:f.title||f.brief?.slice(0,36)||s.newFiles[0]?.name||'新工程',brief:f.brief,script:f.script,style:styleSelector(f.style),profile:{width:ratio[0],height:ratio[1],fps:30},settings:{shareFrames:f.shareFrames===true,shareTranscript:f.shareTranscript!==false,factUrls:(f.factUrls||'').split('\n').map(v=>v.trim()).filter(Boolean),sourceUrls:(f.sourceUrls||'').split('\n').map(v=>v.trim()).filter(Boolean)}});
  try{await uploadFiles(p.id,s.newFiles);if(f.voice){const latest=await api('/api/projects/'+p.id);await api('/api/projects/'+p.id+'/voices/use',{id:f.voice,baseRevision:latest.revision});}}finally{await choose(p.id);}
  if(run)await startJob('produce','codex');
}
function draw(){
  if(!s.p)return newPage(false);
  const p=s.p;el('current-title').textContent=p.title;const making=s.jobs.some(j=>['queued','running','pausing'].includes(j.status));el('top-actions').innerHTML=(making?btn('draft','预览当前片段'):btn('preview','生成预览'))+btn('render','导出成片','accent');
  const tabs={edit:'剪辑台',assets:'素材与原句',style:'风格库',deliver:'交付',settings:'工程设置'};
  el('content').innerHTML=`<nav class="tabs" aria-label="工程分区">${Object.entries(tabs).map(([k,v])=>btn('tab',v,s.tab===k?'selected':'',k)).join('')}</nav><div id="view"></div>`;
  if(s.tab==='edit')drawEdit();else if(s.tab==='assets')drawAssets();else if(s.tab==='style')loadStyle().catch(e=>notice(e.message));else if(s.tab==='deliver')drawDeliver();else drawSettings();
}
function lastVideo(){return s.jobs.find(j=>j.files?.includes('video'));}
function clipTitle(c){return c.text||(c.shape==='outline'?'证据指示框':'')||assetName(c.assetId)||tracks[c.track];}
function cutLabel(job) {
  const engine=job?.creativeEngine;
  const mode=engine==='local'?'本地粗剪':engine==='codex'?'Codex 剪辑':'';
  return [mode,job?.kind==='preview'?'预览':job?.kind==='render'?'导出':''].filter(Boolean).join(' · ')||'工程成片';
}
function framingFields(c) {
  const point=(key,label)=>{
    const v=c.framing?.[key]||c.framing?.from||{x:.5,y:.5,zoom:1};
    return '<p>'+label+'</p><div class="three">'+[['x','水平中心',0,1],['y','垂直中心',0,1],['zoom','放大倍率',1,4]].map(([k,name,min,max])=>field(name,input('view-'+key+'-'+k,v[k],'number','min="'+min+'" max="'+max+'" step=".01"'))).join('')+'</div>';
  };
  return '<details><summary>原素材取景</summary>'+check('clip-framing','按原图位置取景',Boolean(c.framing))+point('from','首帧')+point('to','末帧')+'</details>';
}
function drawEdit(){
  const p=s.p, clips=p.timeline.clips, latest=lastVideo(), first=p.assets.find(a=>a.kind==='video'||a.kind==='image');
  const source=latest?'/api/jobs/'+latest.id+'/file/video':first?aid(first.id):null;
  const total=Math.max(1,...clips.map(c=>c.start+c.duration)),fps=p.profile.fps;
  const active=s.jobs.find(j=>['running','queued','pausing'].includes(j.status));
  const chosen=clips.find(c=>c.id===s.clip);
  el('view').innerHTML=`<div class="edit-layout"><div class="stack"><div class="monitor"><div class="screen">${source?(latest||first.kind==='video'?`<video id="player" controls playsinline preload="metadata" src="${source}"></video>`:`<img src="${source}" alt="素材预览">`):`<div class="empty"><p>预览画面</p>${btn('tab','添加素材','','assets')}</div>`}</div>
  <div class="monitor-foot">${btn('draft','查看当前草稿')}<span>${latest?cutLabel(latest)+' · v'+latest.revision+(latest.revision===p.revision?'':' · 有新改动'):first?'素材预览':'工程预览'}</span><span class="mono">${p.profile.width} × ${p.profile.height} · ${fps} fps</span></div></div>
  <section class="card timeline"><div class="timeline-header"><h2>时间线</h2><span class="mono">${clock(total/fps)} · v${p.revision}</span></div><div class="ruler"><span></span><div>${[0,.25,.5,.75,1].map(x=>'<span>'+clock(total*x/fps)+'</span>').join('')}</div></div>
  ${Object.entries(tracks).map(([k,v])=>`<div class="lane"><span>${v}</span><div class="lane-body" data-frames="${total}">${clips.filter(c=>c.track===k).map(c=>`<button class="clip ${k} ${s.clip===c.id?'focus':''} ${c.locked?'lock':''}" data-clip="${esc(c.id)}" title="${esc(clipTitle(c))}" style="left:${100*c.start/total}%;width:${100*c.duration/total}%">${c.locked?'⌑ ':''}${esc(clipTitle(c))}</button>`).join('')}</div></div>`).join('')}
  </section><div id="inspect">${inspector(chosen)}</div></div>
  <aside class="card director"><div class="hrow space"><h2>剪辑对话</h2></div>
  <div class="compose">${field('本次要求',area('instruction','',4,'例如，把选中镜头换成操作特写，旁白保留。'))}</div>
  <div class="actions">${btn('direct',active?'告诉 Codex 新的方向':clips.length?'用 Codex 改稿':'用 Codex 剪辑','primary')}</div>
  ${active?'':'<details><summary>本地粗剪</summary><p class="help">按素材与脚本生成草稿。需要按风格选镜、设计强调或检查画面时，请用 Codex 剪辑。</p>'+btn('local','生成本地草稿')+'</details>'}
  <div id="activity">${activity(active||s.jobs[0])}</div></aside></div>`;
}
function activity(j){
  if(!j)return '<p class="help">可以在这里查看制作进度、暂停任务并继续改稿。</p>';
  const text=(j.events||[]).slice(-8).map(e=>'<li>'+esc(e.message)+'</li>').join('');
  return `<div class="hrow space"><strong>${esc(['produce','revise'].includes(j.kind)?(j.creativeEngine==='local'?'本地粗剪进度':'Codex 剪辑进度'):j.kind==='preview'?'预览进度':'导出进度')}</strong><span class="pill">${statusLabels[j.status]||j.status}</span></div>
  ${j.status==='running'?'<progress></progress>':''}<ul class="log">${text}</ul>${j.error?'<p class="feedback">'+esc(j.error)+'</p>':''}
  ${['running','queued'].includes(j.status)?btn('pause','暂停','',j.id):['paused','failed'].includes(j.status)?btn('resume','检查后续作','',j.id):''}`;
}
function inspector(c){
  if(!c)return '<p class="help">选择片段可修剪、锁定或调整声音。拖动时间线上的片段可移动起点。</p>';
  const fps=frameRate();return `<section class="card inspector"><div class="hrow space"><h3>${esc(clipTitle(c))}</h3>${btn('lock',c.locked?'解锁片段':'锁定片段','',c.id)}</div>
  <div class="three">${[['起点（秒）','at',c.start/fps],['长度（秒）','len',c.duration/fps],['原片入点（秒）','in',(c.sourceIn||0)/fps],['速率','speed',c.speed??1],['音量','gain',c.gain??1]].map(([label,id,v])=>field(label,input('clip-'+id,Number(v.toFixed(4)),'number','step="any" min="0"'))).join('')}</div>
  ${['caption','graphic'].includes(c.track)?field('文字',area('clip-text',c.text,2)):''}
  ${['caption','graphic'].includes(c.track)?`<details><summary>图层位置与关键帧</summary><div class="three">${field('水平位置 0–1',input('clip-x',c.geometry?.x??.5,'number','step=".01"'))}${field('垂直位置 0–1',input('clip-y',c.geometry?.y??.5,'number','step=".01"'))}${field('字号（像素）',input('clip-font',c.style?.fontSize||48,'number','min="1"'))}</div>${field('关键帧（帧、位置、缩放和透明度）',area('clip-keys',JSON.stringify(c.keyframes||[]),2))}</details>`:''}
  ${c.track==='video'?`${framingFields(c)}<div class="form-grid">${field('替换画面素材',select('replace-asset',s.p.assets.filter(a=>['image','video'].includes(a.kind)).map(a=>[a.id,a.name]),c.assetId))}${field('入场叠化（帧）',input('clip-fade',c.transition?.duration||0,'number','min="0"'))}</div>`:''}<div class="actions">${c.track==='video'?btn('split-clip','在播放头处分割','',c.id):''}${c.assetId?btn('clip-source','查看原片区间','',c.id):''}${btn('remove','移除片段','',c.id)}${btn('save-clip','保存片段','primary',c.id)}</div></section>`;
}
async function edit(commands){
  const previous=s.p, result=await proj('/edits',{baseRevision:previous.revision,commands});
  const changed=commands.find(cmd=>cmd.op!=='lock');
  if(changed)s.lastEdit={projectId:previous.id,clipId:changed.id||changed.clip?.id,previous:previous.revision,revision:result.revision};
  s.p=result;draw();
}
async function pickClip(id,seek=true){
  s.clip=id;const c=s.p.timeline.clips.find(c=>c.id===id);if(!c)return;
  await proj('/select',{clipId:id,fromFrame:c.start,toFrame:c.start+c.duration});
  document.querySelectorAll('[data-clip]').forEach(n=>n.classList.toggle('focus',n.dataset.clip===id));if(el('inspect'))el('inspect').innerHTML=inspector(c);
  const video=el('player');if(seek&&video&&lastVideo())video.currentTime=c.start/frameRate();
}
let dragging;
document.addEventListener('pointerdown',e=>{const n=e.target.closest('[data-clip]');if(!n)return;const c=s.p.timeline.clips.find(c=>c.id===n.dataset.clip);dragging={id:c.id,start:c.start,locked:c.locked,x:e.clientX,span:n.parentElement.clientWidth,frames:Number(n.parentElement.dataset.frames)};n.setPointerCapture?.(e.pointerId);});
document.addEventListener('pointerup',safeAction(async e=>{if(!dragging)return;const d=dragging;dragging=null;const dist=e.clientX-d.x;if(Math.abs(dist)<5||d.locked)return pickClip(d.id);s.clip=d.id;await edit([{op:'update',id:d.id,changes:{start:Math.max(0,Math.round(d.start+dist*d.frames/d.span))}}]);}));
document.addEventListener('keydown',safeAction(async e=>{if(['Enter',' '].includes(e.key)&&e.target.dataset.clip){e.preventDefault();await pickClip(e.target.dataset.clip);}}));
async function startJob(kind,engine,extra={}){
  const message=val('instruction')||s.p.brief;
  const selection=s.p.timeline.clips.find(c=>c.id===s.clip);
  const active=s.jobs.find(j=>['queued','running','pausing'].includes(j.status));
  if(active&&['revise','produce'].includes(kind)){
    await api('/api/jobs/'+active.id+'/direction',{engine,message,selection:selection?{clipId:selection.id,fromFrame:selection.start,toFrame:selection.start+selection.duration}:undefined});s.jobs=await proj('/jobs');notice('已保存新的制作方向');return;
  }
  const j=await proj('/jobs',{kind,engine,message,baseRevision:s.p.revision,...(selection?{selection:{clipId:selection.id,fromFrame:selection.start,toFrame:selection.start+selection.duration}}:{}),...extra});
  s.jobs.unshift(j);if(el('activity'))el('activity').innerHTML=activity(j);notice('已加入制作队列');
}
function factList(p){
  const facts=p.facts||[];
  if(!facts.length)return '';
  const entries=facts.map((f,i)=>{
    const asset=p.assets.find(a=>a.id===f.assetId);
    const context=f.visualRole==='illustration'?'配图':'来源画面';
    const position=Number.isFinite(f.start)?clock(f.start/p.profile.fps)+' · ':'';
    const controls=btn('fact-source','打开出处','',i)+(asset?btn('fact-shot','查看原素材','',i):'');
    return `<div class="entry"><div><strong>${esc(f.text)}</strong><small>${position}${context} · ${esc(asset?.name||'')}</small>${f.sourceExcerpt?'<p>'+esc(f.sourceExcerpt)+'</p>':''}<small class="wrap">${esc(f.url)}</small></div><div class="hrow">${controls}</div></div>`;
  });
  return '<section class="card"><h2>事实与出处</h2>'+entries.join('')+'</section>';
}
function previewOriginal(asset,{fromFrame=0,toFrame}={}){
  const source=aid(asset.id);
  if(asset.kind==='image')return modal(asset.name,`<img class="wide-video" src="${source}" alt="${esc(asset.name)}">`);
  const type=asset.kind==='audio'?'audio':'video';
  const markup=`<${type} id="source-preview" class="wide-video" controls playsinline src="${source}"></${type}>`;
  const mark=asset.kind==='video'?field('当前帧发生了什么',input('event-label'))+btn('mark-action','将当前帧标为动作落点','',asset.id):'';
  modal(asset.name,markup+mark);
  const player=el('source-preview'),fps=frameRate();
  const start=()=>{player.currentTime=Math.max(0,fromFrame/fps);player.play().catch(()=>{});};
  if(player.readyState>=1)start();else player.addEventListener('loadedmetadata',start,{once:true});
  if(Number.isFinite(toFrame)&&toFrame>fromFrame){
    player.addEventListener('timeupdate',()=>{if(player.currentTime>=toFrame/fps)player.pause();});
  }
}
function drawAssets(){
 const p=s.p;const utterances=Object.entries(p.transcript||{}).flatMap(([assetId,arr])=>Array.isArray(arr)?arr.map(u=>({...u,assetId})):[]);
 el('view').innerHTML=`<section class="page"><div class="hrow space"><h1>素材与原句</h1>${btn('legacy','从历史工程导入')}</div><div class="two-col"><section class="card"><h2>项目素材</h2><div class="outline">${fileInput('asset-upload')}</div><div class="asset-list">${p.assets.map(a=>`<div class="asset"><div><strong>${esc(a.name)}</strong><small>${esc(a.kind)} · ${clock(a.duration)}　${esc(a.source?.credit||a.source?.author||'')}</small>${a.source?.url?'<small class="wrap">'+esc(a.source.url)+'</small>':''}</div><div class="hrow">${btn('asset-play','预览','',a.id)}${btn('add-asset-clip','加入时间线','',a.id)}${a.hasAudio?btn('transcribe','转录','',a.id):''}</div></div>`).join('')}</div></section>
 <section class="card"><h2>按来源导入</h2>${field('媒体文件直链',input('asset-url','','url','placeholder="https://…"'))}${field('来源与授权说明',input('asset-rights'))}${btn('add-url','导入工程')}<h3>转录原句</h3>${utterances.length?utterances.map((u,i)=>`<div class="entry"><div><strong>${esc(u.text)}</strong><small>${clock(u.start)} – ${clock(u.end)}</small></div><div class="hrow">${btn('play-line','听原句','',i)}${btn('restore-line','恢复','',i)}</div></div>`).join(''):'<p class="help">转录带声音的素材后，可试听原句或恢复到时间线。</p>'}</section></div>${factList(p)}</section>`;s.utterances=utterances;
}
async function loadStyle(selector=s.p.style){
 const selected=s.p.id;const st=await api('/api/styles/'+urlPart(selector.id)+'/'+urlPart(selector.version));if(s.p?.id!==selected||s.tab!=='style')return;
 s.style=st;const ref=(st.references||[]).filter(r=>r.available!==false&&r.locator&&r.sha256);
 const templates=st.templates||[];el('view').innerHTML=`<section class="page"><h1>风格库</h1><div class="two-col"><section class="card">${field('查看风格与版本',select('browse-style',styleOptions(),st.id+'@'+st.version))}<div class="hrow space"><h2>${esc(st.name)}</h2><span class="pill">v${esc(st.version)}</span></div><p class="help">${esc(st.description||'')}</p>
 ${ref.map(r=>`<div class="entry"><span>${esc(r.title||r.id)}</span>${btn('style-ref',r.kind==='image'?'查看参考帧':r.kind==='audio'?'试听':/script|direction|text/i.test(r.kind)?'查看文字':'看片段','',r.id)}</div>`).join('')}<div class="actions">${btn('pin-style','用于本工程','primary')}</div>
 <h3>场景模板</h3>${field('模板',select('scene-template',templates.map(t=>typeof t==='string'?[t,t]:[t.id,t.name||t.title||t.id]),''))}
 <div class="form-grid">${field('事件落点（秒）',input('scene-action','1','number','min="0" step=".1"'))}${field('场景时长（秒）',input('scene-duration','4','number','min=".3" step=".1"'))}</div>${field('强调文字',input('scene-text','','text','placeholder="例如，灯芯亮起"'))}${check('scene-sound','在已标记的动作帧上加入音效',s.p.settings.sceneSound??(s.p.mode!=='interview'))}${field('落点音效来源',select('scene-sound-asset',[['','模板自带'],...s.p.assets.filter(a=>a.kind==='audio').map(a=>[a.id,a.name])],''))}${btn('add-scene','在选区加入可编辑模板')}</section>
 <section class="card"><h2>保存个人风格</h2>${field('以后也这样剪',area('preference','',3,'记录这次调整，例如，结果出现后多停留半秒。'))}${btn('preference','保存为新版')}<hr><h3>从参考学习</h3>${field('风格名称',input('learn-name'))}${field('参考脚本',area('learn-script','',4))}${field('本机参考视频或录音',select('learn-media',[['','仅脚本'],...s.p.assets.filter(a=>['audio','video'].includes(a.kind)).map(a=>[a.id,a.name])],''))}${field('希望保留的视听特征（可选）',area('learn-observation','',2))}<details><summary>适用的模板与反例</summary>${field('可选场景模板',select('learn-template',[['','不指定'],['action-result','动作、反应与结果'],['step-reveal','分步揭示与实拍验证']]))}${field('这种风格应避开的做法',area('learn-exception','',2))}</details>${btn('learn','保存新风格')}</section></div></section>`;
}
function drawDeliver(){
 const cards=s.jobs.filter(j=>j.files?.includes('video')).map(j=>{const qa=j.qa||{};return `<section class="card"><div class="hrow space"><h2>${esc(cutLabel(j))} · v${j.revision}</h2><span class="pill ${qa.status==='repair'?'bad':qa.status==='unverified'?'warn':''}">${esc(qa.label||'验收中')}</span></div>
 <video class="wide-video" data-review="${esc(j.id)}" controls preload="metadata" src="/api/jobs/${j.id}/file/video"></video>
 <div class="actions">${(j.files||[]).filter(k=>['video','subtitle','project','cover34','cover43','copy','credits','review'].includes(k)).map(k=>btn('reveal',({video:'MP4',subtitle:'SRT',project:'可编辑工程',cover34:'3:4 封面',cover43:'4:3 封面',copy:'发布文案',credits:'素材与事实来源',review:'验收记录'})[k],'',j.id+'|'+k)).join('')}</div>
 ${(qa.issues||[]).map((q,i)=>`<div class="feedback"><strong>${esc(q.message||q.reason)}</strong> <small>${clock((q.fromFrame||0)/frameRate())}</small> ${btn('review-issue','播放该段','',j.id+'|'+i)} ${btn('fix-issue','按意见修改','',j.id+'|'+i)}<br><small>${esc(q.fix||'')}</small></div>`).join('')}<p class="help">${esc((qa.limitations||[]).join('　'))}</p></section>`;}).join('');
 el('view').innerHTML=`<section class="page"><h1>交付记录</h1>${cards||'<div class="card empty-panel">完成渲染后，可在这里播放成片并打开本地交付目录。</div>'}</section>`;
}
function drawSettings(){
 const p=s.p,t=p.settings,options=[['','请选择'],...p.assets.filter(a=>a.hasAudio||a.kind==='audio').map(a=>[a.id,a.name])];
 el('view').innerHTML=`<section class="page"><h1>工程设置</h1><div class="two-col"><section class="card"><h2>创作与交付</h2>${field('名称',input('set-title',p.title))}${field('制作要求',area('set-brief',p.brief))}${field('原始脚本',area('set-script',p.script,4))}${field('目标片长（秒，可留空）',input('target-length',t.targetDuration||'','number','min="1"'))}
 ${field('声音',select('voice-mode',[['original','保留同期声'],['system','系统中文配音'],['import','导入旁白'],['clone','本地克隆']],t.voiceMode))}${field('导入旁白',select('narration',options,t.narrationAssetId))}
 ${field('参考录音',select('voice-reference',options,t.voiceReferenceAssetId))}${field('参考录音的准确原文',area('reference-text',t.voiceReferenceText,2))}${check('consent','我已获准用该录音建立音色',t.voiceConsent)}${btn('audition','试听当前音色')}<details><summary>个人音色库</summary>${field('使用已登记的音色',select('saved-voice',[['','请选择'],...s.voices.map(v=>[v.id,v.name])],t.voiceLibraryId))}${btn('use-voice','用于本工程')}${field('给参考音色取名',input('voice-label'))}${btn('enroll-voice','登记参考录音')}</details>
 ${field('配乐方式',select('music-mode',[['library','本地曲库'],['asset','指定素材'],['original','原创配乐'],['none','无需配乐']],t.musicEnabled===false?'none':t.musicMode||'library'))}${field('配乐素材',select('bgm',options,t.musicAssetId))}${check('project-scene-sound','场景模板在动作发生时加落点音效',t.sceneSound??(p.mode!=='interview'))}${check('pack','附两种封面和发布文案',t.publishPackage)}<details><summary>编辑发布文案</summary>${field('发布标题',input('pub-title',p.publication?.title))}${field('给观众的正文',area('pub-body',p.publication?.body,3))}${field('话题',input('pub-tags',p.publication?.tags?.join(' ')))}</details></section>
 <section class="card"><h2>项目隐私与服务</h2><p class="help">Codex 会收到本项目的要求、脚本和剪辑结构。原媒体保存在本机。</p>${check('share-text','允许把转录文字交给 Codex',t.shareTranscript)}${check('share-frames','允许把选取的参考帧交给 Codex',t.shareFrames)}
 ${check('cloud','启用第三方原创配乐',t.cloudEnabled)}${field('本项目云配乐总时长预算（秒）',input('budget',t.cloudBudget,'number','min="0" step="1"'))}
 <div class="actions">${btn('settings-save','保存工程设置','primary')}</div><hr><h3>原创配乐</h3>${field('曲风与用途',area('music-prompt','',2))}${field('时长（秒）',input('music-length',15,'number','min="3" max="600"'))}${btn('compose-music','从云端生成并导入')}${(p.musicReceipts||[]).map(r=>`<div class="entry"><small>${esc(r.seconds)} 秒 · ${esc(r.status)}</small>${['sent','unknown'].includes(r.status)?btn('reconcile','核对回执','',r.id):''}</div>`).join('')}</section></div></section>`;
}
async function openLegacy(){
 const list=await api('/api/legacy');s.legacy=list;
 modal('历史素材与成片',list.length?list.map(p=>`<h3>${esc(p.title)}</h3>${p.editor?btn('legacy-editor','打开原编辑工程','',p.id):''}${p.media.map(a=>`<div class="entry"><div><strong>${esc(a.name)}</strong><small>${esc(a.role)} ${esc(a.status||'')}</small></div>${btn('migrate',s.p?'导入当前工程':'建工程并导入','',p.id+'|'+a.id)}</div>`).join('')}`).join(''):'<p>尚未发现旧工作台的登记记录。</p>');
}
async function environment(){
 modal('本机与账号','<p>正在检查本机组件…</p>');
 const [v,account]=await Promise.all([api('/api/status'),api('/api/account').catch(e=>({reason:e.message}))]);s.system=v;
 const capability=name=>{const a={...v.media,...v.audio};const b=a[name];if(typeof b==='object')return b?.available===false?'待准备':b?'可用':'待准备';return b?'可用':'待准备';};
 modal('本机与账号',`<div class="entry"><div><strong>Codex</strong><small>${account.connected?'已连接':esc(account.message||account.reason||'尚未登录')}</small></div>${btn('login','连接账号')}</div>
 ${[['render','本地渲染','melt'],['speech','语音转录','transcription'],['clone','中文音色克隆','clone']].map(([key,label,cap])=>`<div class="entry"><div><strong>${label}</strong><small>${capability(cap)}</small></div>${btn('install','准备组件','',key)}</div>`).join('')}
 ${v.install?'<p class="help">'+esc(v.install.state+' · '+v.install.message)+'</p>':''}
 <h3>云配乐账号</h3>${field('ElevenLabs API 密钥（仅在本次打开期间使用）',input('cloud-key','','password','autocomplete="off"'))}${btn('cloud-key','保存本次连接')} <span class="help">${v.cloudMusic?'已连接':''}</span>`);
}
async function runAction(act,id){
 const p=s.p;
 switch(act){
 case 'open-project':return choose(id);
 case 'mode':captureNew();s.mode=id;return newPage(false);
 case 'create':case 'create-run':return create(act==='create-run');
 case 'import-folder':return el('folder-picker').click();
 case 'tab':s.tab=id;return draw();
 case 'direct':return startJob(p.timeline.clips.length?'revise':'produce','codex');
 case 'local':return startJob(p.timeline.clips.length&&val('instruction').trim()?'revise':'produce','local');
 case 'draft':{
   const projectId=p.id,at=Math.floor((el('player')?.currentTime||0)*p.profile.fps);
   const selected=p.timeline.clips.find(c=>c.id===s.clip);
   notice('正在合成此处的工程草稿');
   const draft=await proj('/draft',{fromFrame:selected?.start??at});
   if(s.p?.id!==projectId)return;
   return modal('当前草稿 · v'+draft.revision+' · '+clock(draft.fromFrame/p.profile.fps)+'–'+clock(draft.toFrame/p.profile.fps),`<video class="wide-video" autoplay controls playsinline src="${esc(draft.url)}"></video>`);
 }
 case 'preview':case 'render':return startJob(act,'local');
 case 'pause':s.jobs=await proj('/jobs');await api('/api/jobs/'+id+'/pause',{});return reload();
 case 'resume':await api('/api/jobs/'+id+'/resume',{confirmRetry:true});return reload();
 case 'lock':{const c=p.timeline.clips.find(c=>c.id===id);return edit([{op:'lock',id,locked:!c.locked}]);}
 case 'remove':s.clip=null;return edit([{op:'remove',id}]);
 case 'split-clip':{
  const c=p.timeline.clips.find(c=>c.id===id), at=Math.round((el('player')?.currentTime||0)*frameRate());
  if(!lastVideo()||at<=c.start||at>=c.start+c.duration)throw Error('先生成工程预览，将播放头放到片段中间。');
  const head=at-c.start,newId=crypto.randomUUID(),camera=c.framing;
  const pointAt=frame=>Object.fromEntries(['x','y','zoom'].map(k=>[k,camera.from[k]+((camera.to||camera.from)[k]-camera.from[k])*frame/(c.duration-1)]));
  return edit([{op:'update',id,changes:{duration:head,...(camera&&{framing:{from:camera.from,to:pointAt(head-1)}})}},
    {op:'add',clip:{...c,id:newId,start:at,duration:c.duration-head,sourceIn:(c.sourceIn||0)+Math.round(head*(c.speed||1)),transition:null,...(camera&&{framing:{from:pointAt(head),to:camera.to||camera.from}})}}]);}
 case 'save-clip':{
  const c=p.timeline.clips.find(c=>c.id===id),f=frameRate();
  const changes={start:Math.round(Number(val('clip-at'))*f),sourceIn:Math.round(Number(val('clip-in'))*f),duration:Math.round(Number(val('clip-len'))*f),speed:Number(val('clip-speed')),gain:Number(val('clip-gain'))};
  if(['caption','graphic'].includes(c.track)){
    changes.text=val('clip-text');changes.geometry={...c.geometry,x:Number(val('clip-x')),y:Number(val('clip-y'))};
    changes.style={...c.style,fontSize:Number(val('clip-font'))};changes.keyframes=JSON.parse(val('clip-keys')||'[]');
  }
  if(c.track==='video'){
    const point=key=>Object.fromEntries(['x','y','zoom'].map(k=>[k,Number(val('view-'+key+'-'+k))]));
    if(el('clip-framing').checked)changes.framing={from:point('from'),to:point('to')};
    else if(c.framing)changes.framing=null;
    changes.assetId=val('replace-asset');const n=Number(val('clip-fade'));changes.transition=n?{type:'fade',duration:n}:null;}
  return edit([{op:'update',id,changes}]);}
 case 'fact-source':await proj('/facts/'+Number(id)+'/open',{});return;
 case 'fact-shot':{
    const f=p.facts?.[Number(id)],asset=p.assets.find(a=>a.id===f?.assetId);
    if(!asset)throw Error('原素材未载入工程。');
    const shot=(p.storyboard||[]).find(shot=>shot.start===f.start&&shot.assetId===asset.id);
    return previewOriginal(asset,{fromFrame:shot?.sourceStart,toFrame:shot?.sourceEnd});
 }
 case 'asset-play':return previewOriginal(p.assets.find(a=>a.id===id));
 case 'clip-source':{
    const c=p.timeline.clips.find(c=>c.id===id),asset=p.assets.find(a=>a.id===c?.assetId);
    if(!asset)throw Error('找不到此片段的原素材。');
    const fromFrame=c.sourceIn||0;
    return previewOriginal(asset,{fromFrame,toFrame:fromFrame+Math.round(c.duration*(c.speed||1))});
 }
 case 'add-asset-clip':{
  const a=p.assets.find(a=>a.id===id);const track=a.kind==='audio'?'music':'video';
  const start=Math.max(0,...p.timeline.clips.filter(c=>c.track===track).map(c=>c.start+c.duration));
  s.clip=crypto.randomUUID();await edit([{op:'add',clip:{id:s.clip,assetId:id,track,start,sourceIn:0,duration:Math.max(1,Math.round((a.kind==='image'?4:a.duration)*frameRate())),gain:1,speed:1}}]);notice('已加入'+tracks[track]+'轨');return;}
 case 'add-url':await proj('/url',{url:val('asset-url'),rights:val('asset-rights')});return reload();
 case 'transcribe':notice('正在本地转录');await proj('/transcript',{assetId:id});return reload();
 case 'play-line':{const u=s.utterances[Number(id)];modal('原句试听',`<audio id="line-audio" controls src="${aid(u.assetId)}"></audio><p>${esc(u.text)}</p>`);const a=el('line-audio');a.addEventListener('loadedmetadata',()=>{a.currentTime=u.start;a.play().catch(()=>{});},{once:true});a.ontimeupdate=()=>{if(a.currentTime>=u.end)a.pause();};return;}
 case 'restore-line':{const u=s.utterances[Number(id)];await proj('/restore-sentence',{assetId:u.assetId,utteranceId:u.id,baseRevision:p.revision});notice('已将原句恢复到时间线');return reload();}
 case 'pin-style':s.p=await proj('/configure',{baseRevision:p.revision,changes:{style:{id:s.style.id,version:s.style.version}}});notice('已固定到该风格版本');return draw();
 case 'style-ref':{
   const ref=(s.style.references||[]).find(r=>r.id===id);if(!ref)throw Error('找不到这份参考。');
   const url='/api/styles/'+urlPart(s.style.id)+'/'+urlPart(s.style.version)+'/references/'+urlPart(id);
   if(/script|direction|text/i.test(ref.kind)){
     const response=await fetch(url);if(!response.ok)throw Error('参考文字尚未载入。');
     return modal(ref.title||'参考文字','<pre class="source-text">'+esc((await response.text()).slice(0,120000))+'</pre>');
   }
   const preview=ref.kind==='image'?`<img class="wide-video" alt="${esc(ref.title)}" src="${url}">`:ref.kind==='audio'?`<audio controls autoplay src="${url}"></audio>`:`<video class="wide-video" controls autoplay src="${url}"></video>`;
   return modal(ref.title||'风格参考',preview);
 }
 case 'add-scene':{
   if(p.style.id!==s.style.id||p.style.version!==s.style.version)throw Error('请先把该风格用于本工程。');
   const c=p.timeline.clips.find(c=>c.id===s.clip),start=c?.start||0,duration=Math.round(Number(val('scene-duration'))*frameRate());
   await proj('/scene',{baseRevision:p.revision,template:val('scene-template'),clipId:c?.id,soundEnabled:el('scene-sound').checked,soundAssetId:val('scene-sound-asset')||undefined,start,duration,actionFrame:start+Math.round(Number(val('scene-action'))*frameRate()),text:val('scene-text'),sourceAssetId:c?.assetId});notice('已生成可编辑图层');return choose(p.id,'edit');}
 case 'preference':{
  if(!val('preference').trim())throw Error('请写明要保存的调整。');
  const c=p.timeline.clips.find(c=>c.id===s.clip);const recent=s.lastEdit?.projectId===p.id?s.lastEdit:null;const after={projectId:p.id,clipId:c?.id||recent?.clipId,revision:p.revision,fromFrame:c?.start||0,toFrame:c?c.start+c.duration:Math.max(1,...p.timeline.clips.map(c=>c.start+c.duration))};
  const st=await api('/api/styles/preferences',{id:s.style.id,version:s.style.version,findEdit:true,instruction:val('preference'),before:{...after,revision:Math.max(1,p.revision-1)},after,source:'用户明确保存的改稿偏好'});s.styles=await api('/api/styles');notice('已保存新版本');return loadStyle(st);}
 case 'learn':{const name=val('learn-name').trim();if(!name)throw Error('请输入风格名称。');const st=await proj('/learn-style',{name,script:val('learn-script'),assetId:val('learn-media'),observation:val('learn-observation'),templateId:val('learn-template'),exception:val('learn-exception')});s.styles=await api('/api/styles');notice('风格已保存');return loadStyle(st);}
 case 'settings-save':{
   const changes={title:val('set-title'),brief:val('set-brief'),script:val('set-script'),publication:{title:val('pub-title'),body:val('pub-body'),tags:val('pub-tags').split(/\s+/).filter(Boolean)},settings:{targetDuration:val('target-length')?Number(val('target-length')):null,voiceMode:val('voice-mode'),narrationAssetId:val('narration'),voiceReferenceAssetId:val('voice-reference'),voiceReferenceText:val('reference-text'),voiceConsent:el('consent').checked,musicAssetId:val('bgm'),musicMode:val('music-mode'),musicEnabled:val('music-mode')!=='none',requireMusic:val('music-mode')==='asset'||val('music-mode')==='original',publishPackage:el('pack').checked,sceneSound:el('project-scene-sound').checked,shareTranscript:el('share-text').checked,shareFrames:el('share-frames').checked,cloudEnabled:el('cloud').checked,cloudBudget:Number(val('budget'))}};
   s.p=await proj('/configure',{baseRevision:p.revision,changes});notice('已保存工程设置');await refreshList();return draw();}
 case 'enroll-voice':{
    const r=await proj('/voices/enroll',{name:val('voice-label'),assetId:val('voice-reference'),referenceText:val('reference-text'),consent:el('consent').checked});
    s.voices=await api('/api/voices');s.p=await proj('/voices/use',{id:r.id,baseRevision:p.revision});draw();notice('音色已登记，正在生成专名和数字试听');const audition=await proj('/audition',{});return modal('新音色试听',`<audio controls autoplay src="${aid(audition.id)}"></audio>`);}
 case 'use-voice':s.p=await proj('/voices/use',{id:val('saved-voice'),baseRevision:p.revision});notice('已使用个人音色');return draw();
 case 'mark-action':{
    const v=el('source-preview');if(!v)throw Error('请打开视频素材。');await proj('/anchor',{baseRevision:p.revision,assetId:id,sourceFrame:Math.round(v.currentTime*frameRate()),label:val('event-label')});dismiss();notice('已在原片登记动作帧');return reload();}
 case 'audition':{await runAction('settings-save');notice('正在本地生成试听');const a=await proj('/audition',{});modal('音色试听',`<audio controls autoplay src="${aid(a.id)}"></audio>`);return;}
 case 'compose-music':{const prompt=val('music-prompt'),seconds=Number(val('music-length'));if(!p.settings.cloudEnabled)throw Error('请先保存项目云配乐授权和时长预算。');await proj('/cloud-music',{requestId:crypto.randomUUID(),prompt,seconds});notice('配乐已加入项目素材');return choose(p.id,'assets');}
 case 'reconcile':{
    const receipt=await proj('/music-receipt/'+urlPart(id));
    if(receipt.status==='done'){notice('已按文件指纹找回这次生成的配乐。');return reload();}
    return modal('核对服务商账单',`<p>请核对 ${esc(receipt.at)} 的 ${esc(receipt.seconds)} 秒配乐。${receipt.songId?'曲目编号 '+esc(receipt.songId)+'。':''}${receipt.providerRequestId?'服务商请求编号 '+esc(receipt.providerRequestId)+'。':''}确认后将更新本项目的剩余时长。</p>${btn('charged','已计费','',id)} ${btn('not-charged','未计费','',id)}`);
 }
 case 'charged':case 'not-charged':await proj('/reconcile-music',{requestId:id,charged:act==='charged'});dismiss();return reload();
 case 'reveal':{const [job,key]=id.split('|');await api('/api/jobs/'+job+'/reveal/'+key,{});return;}
 case 'review-issue':case 'fix-issue':{
  const [job,n]=id.split('|'),j=s.jobs.find(j=>j.id===job),q=j.qa.issues[Number(n)];
  if(act==='fix-issue'){s.tab='edit';draw();el('instruction').value='修改 '+clock((q.fromFrame||0)/frameRate())+' 附近：'+q.message+' '+(q.fix||'');el('instruction').focus();return;}
  const v=document.querySelector(`video[data-review="${CSS.escape(job)}"]`);const f=frameRate();v.currentTime=Math.max(0,(q.fromFrame||0)/f-.8);v.ontimeupdate=()=>{if(v.currentTime>(q.toFrame||q.fromFrame||0)/f+1){v.pause();v.ontimeupdate=null;}};return v.play();}
 case 'legacy':return openLegacy();
 case 'legacy-editor':return api('/api/legacy-editor/'+id,{});
 case 'migrate':{const [old,item]=id.split('|');const h=s.legacy.find(h=>h.id===old);let pid=p?.id;if(!pid)pid=(await api('/api/projects',{mode:'script',title:h.title+' · 新剪辑'})).id;await api('/api/projects/'+pid+'/legacy',{projectId:old,itemId:item});dismiss();notice('已核对指纹并导入');return choose(pid,'assets');}
 case 'login':{const v=await api('/api/login',{});notice(v.message||'已打开官方账号登录');return;}
 case 'install':{const x=await api('/api/prepare',{feature:id});notice(x.message);return environment();}
 case 'cloud-key':await api('/api/music/connection',{key:val('cloud-key')});return environment();
 }
}
document.addEventListener('click',safeAction(async e=>{const n=e.target.closest('[data-act]');if(!n)return;n.disabled=true;try{await runAction(n.dataset.act,n.dataset.id);}finally{n.disabled=false;}}));
document.addEventListener('change',safeAction(async e=>{
 if(e.target.id==='new-files'){s.newFiles=[...e.target.files];el('selected-files').textContent=s.newFiles.map(f=>f.name).join('、');}
 if(e.target.id==='asset-upload'){await uploadFiles(s.p.id,e.target.files);await reload();}
 if(e.target.id==='browse-style')await loadStyle(styleSelector(e.target.value));
 if(e.target.id==='folder-picker'){
   const files=[...e.target.files],manifest=files.find(f=>f.name==='project.vstudio.json');
   if(!manifest)throw Error('请选择含 project.vstudio.json 和 assets 子目录的工程。');
   const {id}=await api('/api/imports',{});const folder=manifest.webkitRelativePath.slice(0,-manifest.name.length);
   for(const file of files.filter(f=>f===manifest||f.webkitRelativePath.startsWith(folder+'assets/')||f.webkitRelativePath.startsWith(folder+'style/'))){
     const name=file.webkitRelativePath.slice(folder.length);
     if(name.split('/').some(piece=>piece.startsWith('.')))continue;
     await api('/api/imports/'+id+'/file',undefined,{method:'POST',headers:{'X-Project-Path':encodeURIComponent(name)},body:file});
   }
   const p=await api('/api/imports/'+id+'/open',{});await choose(p.id);
 }
}));
el('new').onclick=()=>newPage(true);el('legacy').onclick=safeAction(openLegacy);el('environment').onclick=safeAction(environment);el('dismiss').onclick=dismiss;
el('dialog').addEventListener('close',()=>{el('dialog-body').innerHTML='';});
async function refreshJobs(){
 if(s.polling||!s.p)return;s.polling=true;
 try{
  const id=s.p.id,previous=s.jobs;const next=await proj('/jobs');if(s.p?.id!==id)return;
  const changed=previous.some(a=>['queued','running','pausing'].includes(a.status)&&next.some(b=>a.id===b.id&&['done','paused','failed'].includes(b.status)));
  s.jobs=next;
  if(changed){s.p=await proj();if(s.p.id===id){if(s.tab==='edit'&&el('instruction')?.value){const draft=val('instruction');draw();el('instruction').value=draft;}else draw();}await refreshList();}
  else if(el('activity')&&next.length)el('activity').innerHTML=activity(next[0]);
 }catch{}finally{s.polling=false;}
}
async function init(){[s.styles,s.voices]=await Promise.all([api('/api/styles'),api('/api/voices')]);await refreshList();if(s.projects.length)await choose(s.projects[0].id);else newPage();setInterval(refreshJobs,1800);}
safeAction(init)();
