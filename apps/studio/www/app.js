import {motionCues,defaultMotionGeometry,contentStage} from './motion-clock.js';
import {mountClipInspector} from './advanced-inspector.js';
import {timelineView} from './timeline.js';
import {createTimelinePlayer} from './timeline-player.js';
let timeline,transport,advanced,editorView,editorProject,openingProject=0;
function releaseEditor(){
  advanced?.dispose();advanced=null;timeline?.destroy();timeline=null;transport?.destroy();transport=null;
}
const playhead=()=>transport?.frame??editorView?.frame??0;
const el=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const urlPart=encodeURIComponent;
const btn=(act,label,cls='',id='')=>`<button type="button" data-act="${esc(act)}" data-id="${esc(id)}" class="${esc(cls)}">${esc(label)}</button>`;
const field=(label,control)=>`<label class="field">${label}${control}</label>`;
const input=(id,value='',kind='text',extra='')=>`<input id="${id}" type="${kind}" value="${esc(value)}" ${extra}>`;
const area=(id,value='',rows=3,ph='')=>`<textarea id="${id}" rows="${rows}" placeholder="${esc(ph)}">${esc(value)}</textarea>`;
const select=(id,rows,chosen)=>`<select id="${id}">${rows.map(([v,l,unavailable])=>`<option ${unavailable?'disabled':''} value="${esc(v)}" ${String(v)===String(chosen)?'selected':''}>${esc(l)}</option>`).join('')}</select>`;
const check=(id,label,selected)=>`<label class="check"><input id="${id}" type="checkbox" ${selected?'checked':''}>${esc(label)}</label>`;
const fileInput=(id,multiple=true)=>`<input id="${id}" type="file" accept="video/*,audio/*,image/*" ${multiple?'multiple':''}>`;
const val=id=>el(id)?.value||'';
const tracks={video:'画面',narration:'人声',music:'配乐',caption:'字幕',graphic:'动效'};
const modeLabels={topic:'从选题开始',script:'脚本与素材',interview:'精剪原片'};
const statusLabels={'awaiting-plan':'等待确认分镜',queued:'等待中',running:'制作中',pausing:'正在暂停',paused:'已暂停',done:'已完成',failed:'需要处理'};
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
function currentResult(project){return s.p?.id===project.id&&project.revision>=s.p.revision;}
async function refreshList(){s.projects=await api('/api/projects');renderNav();}
async function choose(id,tab='edit'){
  const request=++openingProject;
  if(s.p&&s.p.id!==id)releaseEditor();
  const [project,jobs]=await Promise.all([api('/api/projects/'+urlPart(id)),api('/api/projects/'+urlPart(id)+'/jobs')]);
  if(request!==openingProject)return;
  if(s.p?.id!==project.id||currentResult(project))s.p=project;
  s.jobs=jobs;s.tab=tab;s.clip=s.p.selection?.clipId||null;s.style=null;
  await refreshList();if(request===openingProject)draw();
}
async function reload(){if(s.p)await choose(s.p.id,s.tab);}
const frameRate=()=>s.p.profile.fps;
function captureNew(){
  if(el('new-title'))s.form={title:val('new-title'),brief:val('brief'),script:val('script'),style:val('new-style'),ratio:val('ratio'),targetDuration:val('new-duration'),captionDisplay:val('new-captions'),confirmSequence:el('new-confirm-sequence').checked,minimum:val('new-min'),maximum:val('new-max'),finalReview:el('new-final-review').checked,sourceScope:val('new-source-scope'),autoReview:el('new-auto-review').checked,sourceUrls:val('new-urls'),factUrls:val('new-facts'),voice:val('new-voice'),shareFrames:el('new-share-frames').checked,shareTranscript:el('new-share-text').checked};
  if(el('new-files')?.files.length)s.newFiles=[...el('new-files').files];
}
function pageHeading(title,description,topic){
  return '<div class="page-heading"><div><h1>'+title+'</h1><p>'+description+'</p></div><button type="button" class="guide-link" data-guide="'+topic+'">操作说明</button></div>';
}
function newPage(fresh=true){
  if(fresh){openingProject++;releaseEditor();editorProject=null;s.p=null;s.tab='new';s.form={};s.newFiles=[];s.mode='topic';}
  renderNav();el('current-title').textContent='新建工程';el('top-actions').innerHTML=btn('import-folder','打开工程文件夹');
  const f=s.form;
  el('content').innerHTML=`<section class="page new-page">${pageHeading('新建工程','选一种起点，再告诉 Codex 这条片要讲什么。','new')}
  <div class="modes">${Object.entries(modeLabels).map(([k,v],n)=>`<button data-act="mode" data-id="${k}" class="mode ${s.mode===k?'chosen':''}"><span aria-hidden="true" class="mode-icon mode-${k}"></span><strong>${v}</strong><small>${['找来源、写稿并组接画面','按原稿匹配镜头与旁白','保留同期声，按原句精剪'][n]}</small></button>`).join('')}</div>
  <div class="card">${field('工程名称',input('new-title',f.title,'text','placeholder="例如，岛上的第一场雨" maxlength="160"'))}
  ${field(s.mode==='topic'?'选题与制作要求':'制作要求',area('brief',f.brief,3,s.mode==='interview'?'保留哪些观点，想剪成多长？':'想让观众看懂什么？'))}
  ${s.mode==='script'?field('脚本',area('script',f.script,5,'粘贴准备好的旁白或分镜稿')):''}
  ${s.mode==='topic'?'<details class="fold"><summary>素材来源</summary>'+field('素材范围',select('new-source-scope',[['search','检索和使用工程素材'],['project','仅使用工程已有素材']],f.sourceScope||'search'))+field('出处网页（每行一个，可选）',area('new-facts',f.factUrls,2))+field('可用的媒体文件直链（可选）',area('new-urls',f.sourceUrls,2))+'</details>':''}
  <div class="form-grid basic-specs">${field('画幅',select('ratio',[['16:9','16:9 横屏'],['9:16','9:16 竖屏'],['1:1','1:1 方形']],f.ratio||'16:9'))}${field('风格',select('new-style',styleOptions(),f.style||styleOptions()[0]?.[0]))}${field('目标片长（秒，可留空）',input('new-duration',f.targetDuration||'','number','min="1"'))}</div>
  <details class="fold"><summary>片长范围、旁白与字幕</summary><div class="form-grid">${field('最短片长（秒）',input('new-min',f.minimum||'','number','min=".01" step="any"'))}${field('最大片长（秒）',input('new-max',f.maximum||'','number','min=".01" step="any"'))}</div>
  ${s.voices.length?field('本期音色',select('new-voice',[['','跟随所选风格'],...s.voices.map(v=>[v.id,v.name])],f.voice||'')):''}
  ${field('字幕',select('new-captions',[['burned-in','画面字幕和 SRT'],['sidecar','只导出 SRT']],f.captionDisplay||'burned-in'))}</details><div class="outline">${field(s.mode==='interview'?'原片':'本地素材',fileInput('new-files'))}<small id="selected-files">${s.newFiles.length?esc(s.newFiles.map(f=>f.name).join('、')):'支持视频、音频和图片，可在工程中继续添加。'}</small></div>
  <details class="fold"><summary>制作确认与画面分享</summary>${check('new-confirm-sequence','制作前由我确认正式分镜与台词',f.confirmSequence===true)}<fieldset><legend>给 Codex 的创作资料</legend>${check('new-share-text','分享语音转录文字',f.shareTranscript!==false)}${check('new-share-frames','分享选取的素材、风格、草稿与成片帧（含画面上的字幕）',f.shareFrames===true)}${check('new-auto-review','分享画面时自动回看首版，保留两版',f.autoReview!==false)}${check('new-final-review','允许独立终审使用 1 个 Codex 回合',f.finalReview!==false)}<p id="review-mode" class="help"></p></fieldset></details>
  <div class="actions">${btn('create','仅创建工程')}${btn('create-run','创建并开始制作','primary')}</div></div>
  <input type="file" id="folder-picker" webkitdirectory multiple hidden></section>`;reviewMode();
}
function reviewMode(){
  const node=el('review-mode');if(!node)return;
  node.textContent=!el('new-share-frames').checked?'本次只使用本地检测。开启分享画面后，可让 Codex 看素材与成片。':!el('new-auto-review').checked?'本次由主导演制作，可手动查看成片。':el('new-final-review').checked?'主导演可看图和修改首版。最终候选另交独立终审，最多 1 个 Codex 回合。':'主导演可看图和修改首版。独立终审已关闭。';
}
document.addEventListener('change', e=>{if(['new-share-frames','new-auto-review','new-final-review'].includes(e.target.id))reviewMode();});
function styleOptions(){return s.styles.map(item=>[item.id+'@'+item.version,item.name+' · v'+item.version+(item.available===false?'（资源待恢复）':''),item.available===false]);}
function styleSelector(value){
  const item=s.styles.find(st=>st.id+'@'+st.version===value);
  if(!item||item.available===false)throw Error('所选风格尚未载入，请查看风格库或重新打开工作台。');
  return {id:item.id,version:item.version};
}
async function uploadFiles(projectId,files){
  for(const [n,file] of [...files].entries()){
    notice('导入 '+(n+1)+' / '+files.length+' · '+file.name);
    await api('/api/projects/'+projectId+'/assets',undefined,{method:'POST',headers:{'X-File-Name':encodeURIComponent(file.name)},body:file});
  }
}
async function create(run){
  captureNew();const f=s.form,mode=s.mode;const ratio=f.ratio==='9:16'?[1080,1920]:f.ratio==='1:1'?[1080,1080]:[1920,1080];
  if(!f.title?.trim()&&!f.brief?.trim()&&!f.script?.trim()&&!s.newFiles.length)throw Error('请填写选题、脚本或选择原片。');
  const p=await api('/api/projects',{mode,title:f.title||f.brief?.slice(0,36)||s.newFiles[0]?.name||'新工程',brief:f.brief,script:f.script,style:styleSelector(f.style),profile:{width:ratio[0],height:ratio[1],fps:30},settings:{captionDisplay:f.captionDisplay,confirmSequence:f.confirmSequence,autoReview:f.autoReview,finalReviewMaxTurns:f.finalReview?1:0,...(f.minimum&&{durationMinSeconds:Number(f.minimum)}),...(f.maximum&&{durationMaxSeconds:Number(f.maximum)}),sourceScope:f.sourceScope||'search',targetDuration:f.targetDuration?Number(f.targetDuration):null,shareFrames:f.shareFrames===true,shareTranscript:f.shareTranscript!==false,factUrls:(f.factUrls||'').split('\n').map(v=>v.trim()).filter(Boolean),sourceUrls:(f.sourceUrls||'').split('\n').map(v=>v.trim()).filter(Boolean)}});
  try{await uploadFiles(p.id,s.newFiles);if(f.voice){const latest=await api('/api/projects/'+p.id);await api('/api/projects/'+p.id+'/voices/use',{id:f.voice,baseRevision:latest.revision});}}finally{await choose(p.id);}
  if(run)await startJob('produce','codex');
}
function draw(){
  const instruction=el('instruction')?.value;
  const previousEditor=editorProject;
  releaseEditor();
  if(!s.p)return newPage(false);
  const p=s.p;el('current-title').textContent=p.title;const making=s.jobs.some(j=>['queued','running','pausing'].includes(j.status));el('top-actions').innerHTML=(making?btn('draft','预览当前片段'):btn('preview','生成预览'))+btn('render','导出成片','accent');
  const tabs={edit:'剪辑台',assets:'素材与原句',style:'风格库',deliver:'交付',settings:'工程设置'};
  el('content').innerHTML=`<nav class="tabs" aria-label="工程分区">${Object.entries(tabs).map(([k,v])=>btn('tab',v,s.tab===k?'selected':'',k)).join('')}</nav><div id="view"></div>`;
  if(s.tab==='edit'){drawEdit();if(previousEditor===p.id&&instruction!==undefined)el('instruction').value=instruction;}else if(s.tab==='assets')drawAssets();else if(s.tab==='style')loadStyle().catch(e=>notice(e.message));else if(s.tab==='deliver')drawDeliver();else drawSettings();
}
const componentById=id=>s.components?.find(c=>c.id===id);
function clipTitle(c){const a=s.p?.assets.find(a=>a.id===c.assetId);return componentById(c.motion?.componentId)?.name||c.text||(c.track==='narration'&&a?.source?.text)||(c.shape==='outline'?'证据指示框':c.shape==='polygon'?'矢量轮廓':'')||assetName(c.assetId)||tracks[c.track];}
function cutLabel(job) {
  if(job?.cutRole==='first')return 'Codex 首版';
  if(job?.cutRole==='self-review')return job.creativeResult?.changed===false?'Codex 回看版（保留原剪）':'Codex 回看版';
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
const newText={label:'',lab:'来源一',hardware:'来源二',a:'第一步',b:'第二步',c:'第三步',left:'左侧画面',right:'右侧画面'};
function componentFields(c){
  const spec=componentById(c.motion.componentId);
  const cues=c.motion.cueFrames??motionCues(spec,c.duration,frameRate(),c.motion.props);
  const props=spec.fields.filter(f=>!['second','third'].includes(f.key)).map(f=>{
    const key='motion-'+f.key,value=c.motion.props?.[f.key]??f.defaultValue;
    if(f.type==='boolean')return check(key,f.label,value);
    return field(f.label,input(key,value,f.type==='number'?'number':'text'));
  }).join('');
  const g=c.geometry??defaultMotionGeometry(spec,contentStage(s.p.profile,s.p.style));
  const sameStyle=spec.styleId===s.p.style?.id&&spec.styleVersion===s.p.style?.version;
  const design=c.soundDesign||{};
  const sound=sameStyle?'<details><summary>动作音效</summary>'+check('motion-sound-on','在动作落点加入音效',design.enabled??Boolean(spec.soundEvents?.length))+field('声音素材',select('motion-sound-id',[['','按风格事件'],...(spec.soundResources||[]).map(r=>[r.id,r.name])],design.resourceId||''))+
    (design.assetId?'<small>保留本片自选音频</small>':'')+'</details>':'';
  return sound+'<div class="form-grid">'+props+'</div>'+ (cues.length?'<fieldset><legend>出场时刻（片段内）</legend>'+cues.map((at,i)=>field((spec.id==='source-label'?'切换 ':'第 '+(i+1)+' 步 ')+(spec.id==='source-label'?(i+1):'')+' <output id="cue-read-'+i+'">'+at+' 帧</output>',
    input('cue-'+i,at,'range','data-cue="'+i+'" min="0" max="'+(c.duration-1)+'" step="1" '+(i===0?'disabled':'')))).join('')+
    (spec.id==='source-label'?btn('add-cue','增加切换')+(cues.length>1?btn('drop-cue','移除末次切换'):''):'')+'</fieldset>':'')+
    '<details><summary>动效位置和尺寸</summary>'+rectFields('motion-rect',g,true)+'</details>';
}
function shakeRow(effect,index){
  const fields=[['offsetFrames','动作落点（帧）',0],['duration','时长（帧）',7],['strength','强度',.35],['speed','频率（Hz）',6],
    ['zoom','画面放大',1.015],['rotation','旋转幅度（度）',.1],['breathe','缩放起伏',0]];
  return '<fieldset data-shake="'+index+'" data-phase="'+Number(effect.phaseFrames||0)+'"><legend>动作震动</legend><div class="form-grid">'+
    fields.map(([key,label,fallback])=>field(label,input('shake-'+index+'-'+key,effect[key]??fallback,'number','step="any"'))).join('')+
    '</div>'+btn('remove-shake','移除该效果','',String(index))+'</fieldset>';
}
function shakeInspector(c){
  return '<details><summary>画面震动</summary><div id="picture-shakes">'+(c.pictureEffects||[]).map(shakeRow).join('')+'</div>'+
    btn('add-shake','在播放头加震屏','',c.id)+'</details>';
}
function readShakes(){
  return [...el('picture-shakes').querySelectorAll('[data-shake]')].map(row=>{
    const effect={type:'camera-shake'},phase=Number(row.dataset.phase);
    if(phase)effect.phaseFrames=phase;
    for(const key of ['offsetFrames','duration','strength','speed','zoom','rotation','breathe'])
      effect[key]=Number(val('shake-'+row.dataset.shake+'-'+key));
    return effect;
  });
}
const rectKeys=['x','y','width','height'];
function rectFields(prefix,r,center=false){
  const names=center?['水平中心','垂直中心','宽度','高度']:['距左','距顶','宽度','高度'];
  return '<div class="form-grid">'+rectKeys.map((k,i)=>field(names[i]+'（画布比例）',input(prefix+'-'+k,r[k],'number','step="any"'))).join('')+'</div>';
}
const readRect=prefix=>Object.fromEntries(rectKeys.map(k=>[k,Number(val(prefix+'-'+k))]));
const fullRect={x:0,y:0,width:1,height:1};
function viewportFields(c){
  const candidates=s.p.assets.filter(a=>a.kind==='video'||a.kind==='image');
  return '<details><summary>画面窗口与分屏</summary>'+check('use-viewport','使用独立画面窗口',Boolean(c.viewport))+
    rectFields('viewport',c.viewport||fullRect)+field('窗口内取景',select('clip-fit',[['contain','显示完整画面'],['cover','裁满窗口']],c.fit||'contain'))+
    field('右窗素材',select('right-asset',candidates.map(a=>[a.id,a.name]),candidates.find(a=>a.id!==c.assetId)?.id))+
    btn('pair-shots','将所选镜头与右窗素材并排','',c.id)+'</details>';
}
function mountAdvanced(p,clip){
  advanced?.dispose();advanced=null;
  if(!clip)return;
  advanced=mountClipInspector({element:el('clip-automation'),project:p,clip,frame:playhead(),
    commit:commands=>{if(s.p?.id!==p.id||s.clip!==clip.id)throw Error('选区已改变，请重新选择要编辑的片段。');return edit(commands,p.revision);},
    seek:frame=>transport?.seek(frame)});
}
function drawEdit(){
  const p=s.p,clips=p.timeline.clips,fps=p.profile.fps;
  const active=s.jobs.find(j=>['running','queued','pausing'].includes(j.status));
  const chosen=clips.find(c=>c.id===s.clip);
  if(editorProject!==p.id){editorProject=p.id;editorView={frame:0,zoom:1,scroll:0,snap:true,clipboard:null};}
  editorView.selected=s.clip;
  el('view').innerHTML=`<div class="editor-intro"><span>在播放头看画面，选片段手动调整，或把改动交给 Codex。</span><button class="guide-link" data-guide="edit">操作说明</button></div><div class="edit-layout workspace"><div class="monitor"><div class="screen"><video id="player" playsinline preload="metadata"></video>
  ${!clips.length?'<div class="empty"><p>时间线为空</p>'+btn('tab','添加素材','','assets')+'</div>':''}</div>
  <div class="monitor-foot"><span id="monitor-status" role="status"></span><span class="mono">${p.profile.width} × ${p.profile.height} · ${fps} fps</span></div></div>
  <aside class="card director"><div class="hrow space"><h2>剪辑对话</h2></div>
  <div class="compose">${field('本次要求',area('instruction','',4,'例如，把选中镜头换成操作特写，旁白保留。'))}</div>
  <div class="actions">${btn('direct',active?'告诉 Codex 新的方向':clips.length?'用 Codex 改稿':'用 Codex 剪辑','primary')}</div>
  ${active?'':'<details><summary>本地粗剪</summary><p class="help">按素材与脚本生成草稿。需要按风格选镜、设计强调或检查画面时，请用 Codex 剪辑。</p>'+btn('local','生成本地草稿')+'</details>'}
  <div id="activity">${activity(active||s.jobs[0])}</div></aside>
  <section class="timeline" aria-label="工程时间线"></section>
  <div class="insert-tools"><details><summary>插入素材、字幕与动效</summary><div class="actions">
  ${select('insert-asset',p.assets.map(a=>[a.id,a.name]))}${btn('insert-asset','在播放头插入素材')}
  ${btn('insert-caption','插入字幕')}${select('new-component',[...s.components].sort((a,b)=>Number(b.styleId===p.style?.id)-Number(a.styleId===p.style?.id)).map(c=>[c.id,(c.styleId==='henry-hot-news'?'热点 · ':'科普 · ')+c.name]))}${btn('add-component','插入动效')}
  </div></details>${clips.length?field('选中片段',select('clip-picker',[['','选择时间线片段'],...clips.map(c=>[c.id,tracks[c.track]+' · '+clock(c.start/fps)+' · '+clipTitle(c)])],s.clip)):''}</div>
  <div id="inspect">${inspector(chosen)}</div></div>`;
  const onError=e=>{notice(e?.message||String(e));if(e?.status===409&&s.p?.id===p.id)reload().catch(e=>notice(e.message));};
  const seek=(frame,scrub=false)=>{timeline?.frame(frame);return Promise.resolve(transport?.seek(frame,{scrub})).catch(onError);};
  timeline=timelineView({root:document.querySelector('section.timeline'),p,view:editorView,title:clipTitle,
    seek,select:(id,focus)=>pickClip(id,focus).catch(onError),commit:edit,action:timelineAction,player:()=>transport,
    report:onError,history:()=>proj('/history')});
  transport=createTimelinePlayer({project:p,jobs:s.jobs,video:el('player'),frame:editorView.frame,
    onFrame:f=>{timeline?.frame(f,true);advanced?.setFrame(f);},onState:state=>{
      timeline?.setPlaying(state.playing);
      const node=el('monitor-status');
      if(node)node.textContent=state.error?.message||state.error||(state.status==='loading'?'正在准备当前帧…':state.status==='buffering'?'正在准备下一段…':clips.length?'工程预览 · v'+p.revision:'工程预览');
    }});
  mountAdvanced(p,chosen);
}
async function timelineAction(act,id){
  if(act==='undo'||act==='redo'){
    const p=s.p,result=await proj('/'+act,{baseRevision:p.revision});if(currentResult(result)){s.p=result;s.clip=result.timeline.clips.some(c=>c.id===s.clip)?s.clip:null;draw();}return;
  }
  if(act==='paste'){s.clip=id[0].id;await edit(id.map(clip=>({op:'add',clip})));return pickClip(id[0].id,false);}
  if(act==='split')return runAction('split-clip',id);
  if(act==='ripple')return edit([{op:'ripple-remove',id}]);
  if(act==='remove')return runAction(act,id);
}
function activity(j){
  if(!j)return '<p class="help">可以在这里查看制作进度、暂停任务并继续改稿。</p>';
  const text=(j.events||[]).slice(-8).map(e=>'<li>'+esc(e.message)+'</li>').join('');
  return `<div class="hrow space"><strong>${esc(['produce','revise'].includes(j.kind)?(j.creativeEngine==='local'?'本地粗剪进度':j.creativeEngine==='codex'?'Codex 剪辑进度':'剪辑进度'):j.kind==='preview'?'预览进度':'导出进度')}</strong><span class="pill">${statusLabels[j.status]||j.status}</span></div>
  ${j.status==='running'?'<progress></progress>':''}<ul class="log">${text}</ul>${j.error?'<p class="feedback">'+esc(j.error)+'</p>':''}
  ${j.status==='awaiting-plan'&&j.approval?'<ol>'+j.approval.beats.map(b=>'<li>'+esc(s.p.assets.find(a=>a.id===b.assetId)?.name||b.assetId||'')+' · '+esc(String(b.sourceStart??0))+' 至 '+esc(String(b.sourceEnd??'由实际片长决定'))+' 秒 · '+esc(b.narration||'')+'</li>').join('')+'</ol><details><summary>查看完整分镜、源区间和动效</summary><pre>'+esc(JSON.stringify(j.approval.beats,null,2))+'</pre></details>'+btn('approve-plan','确认这版分镜并继续','primary',j.id)+btn('replan','重新拟定分镜','',j.id):''}
  ${['running','queued'].includes(j.status)?btn('pause','暂停','',j.id):['paused','failed'].includes(j.status)?btn('resume','检查后续作','',j.id):''}`;
}
function inspector(c){
  if(!c)return '<p class="help">选择片段可修剪、锁定或调整声音。拖动时间线上的片段可移动起点。</p>';
  const fps=frameRate(),asset=s.p.assets.find(a=>a.id===c.assetId),timed=asset&&asset.kind!=='image';
  const canSwitchAudioTrack=['narration','music'].includes(c.track)&&!c.soundBinding&&!c.speechGroup;
  return `<section class="card inspector"><div class="hrow space"><h3>${esc(clipTitle(c))}</h3>${btn('lock',c.locked?'解锁片段':'锁定片段','',c.id)}</div>
  <div class="three">${[['起点（秒）','at',c.start/fps],['长度（秒）','len',c.duration/fps],['原片入点（秒）','in',(c.sourceIn||0)/fps],['速率','speed',c.speed??1],['音量','gain',c.gain??1]].filter((_,i)=>i<2||(i<4?timed:asset?.hasAudio)).map(([label,id,v])=>field(label,input('clip-'+id,Number(v.toFixed(4)),'number','step="any" min="0"'))).join('')}</div>
  ${canSwitchAudioTrack?field('音频轨道',select('clip-audio-track',[['narration','旁白'],['music','配乐']],c.track)):''}
  ${asset?.hasAudio?btn('clip-mute',c.muted?'恢复原声':'静音片段','',c.id):''}
  ${c.motion?componentFields(c):['caption','graphic'].includes(c.track)?field('文字',area('clip-text',c.text,2)):''}
  ${c.shape==='polygon'?field('轮廓顶点（图层内 x、y，范围 0–1）',area('clip-points',JSON.stringify(c.geometry.points),3)):''}
  ${!c.motion&&['caption','graphic'].includes(c.track)?`<details><summary>图层位置与关键帧</summary><div class="three">${field('水平位置 0–1',input('clip-x',c.geometry?.x??.5,'number','step=".01"'))}${field('垂直位置 0–1',input('clip-y',c.geometry?.y??.5,'number','step=".01"'))}${field('字号（像素）',input('clip-font',c.style?.fontSize||48,'number','min="1"'))}</div>${field('关键帧（帧、位置、缩放、透明度及顺时针角度 rotation）',area('clip-keys',JSON.stringify(c.keyframes||[]),2))}</details>`:''}
  ${c.track==='video'?`${viewportFields(c)}${framingFields(c)}<div class="form-grid">${field('替换画面素材',select('replace-asset',s.p.assets.filter(a=>['image','video'].includes(a.kind)).map(a=>[a.id,a.name]),c.assetId))}${field('入场方式',select('clip-transition',[['fade','叠化'],['wipe-right','向右擦除对照'],['whip-pan','热点 · 甩镜'],['organic-dissolve','热点 · 纹理溶解']],['wipe-right','whip-pan','organic-dissolve'].includes(c.transition?.type)?c.transition.type:'fade'))}${field('转场时长（帧）',input('clip-fade',c.transition?.duration||0,'number','min="0"'))}</div>${shakeInspector(c)}`:''}<div id="clip-automation"></div><div class="actions">${!c.motion?btn('split-clip','在播放头处分割','',c.id):''}${c.assetId?btn('clip-source','查看原片区间','',c.id):''}${btn('remove','移除片段','',c.id)}${c.motion?btn('save-preview-cue','保存并预览落点','',c.id):''}${btn('save-clip','保存片段','primary',c.id)}</div></section>`;
}
async function edit(commands,baseRevision=s.p.revision){
  const previous=s.p, result=await proj('/edits',{baseRevision,commands});
  if(!currentResult(result))return;
  const changed=commands.find(cmd=>cmd.op!=='lock');
  if(changed)s.lastEdit={projectId:previous.id,clipId:changed.id||changed.clip?.id,previous:previous.revision,revision:result.revision};
  s.p=result;draw();
}
let selectionWrite=Promise.resolve();
async function pickClip(id,seek=true){
  const projectId=s.p.id,c=s.p.timeline.clips.find(c=>c.id===id);if(!c)return;
  s.clip=id;
  timeline?.choose(id);
  if(el('inspect')){advanced?.dispose();advanced=null;el('inspect').innerHTML=inspector(c);mountAdvanced(s.p,c);}
  if(el('clip-picker'))el('clip-picker').value=id;
  if(seek)transport?.seek(c.start);
  const write=selectionWrite.then(()=>{
    if(s.p?.id===projectId&&s.clip===id)return api('/api/projects/'+urlPart(projectId)+'/select',{clipId:id,fromFrame:c.start,toFrame:c.start+c.duration});
  });
  selectionWrite=write.catch(()=>{});await write;
}
document.addEventListener('input',e=>{
  if(e.target.dataset.cue!==undefined){
    s.cueFocus={id:s.clip,index:e.target.dataset.cue};
    el('cue-read-'+e.target.dataset.cue).value=e.target.value+' 帧';
  }
});
document.addEventListener('change',e=>{
  const id=e.target.id;
  if(id==='clip-picker'&&e.target.value)safeAction(pickClip)(e.target.value);
  if(['voice-mode','voice-reference','narration'].includes(id)&&el('voice-selection')&&val('voice-selection')!=='preview')el('voice-selection').value='user';
  if(['music-mode','bgm'].includes(id)&&el('music-selection'))el('music-selection').value='user';
  if(id==='music-selection'&&e.target.value==='style'&&el('music-mode'))el('music-mode').value='library';
});
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
 el('view').innerHTML=`<section class="page">${pageHeading('素材与原句','把原片放进工程，试听转录原句，或把选中的素材加入时间线。','assets')}<div class="two-col"><section class="card"><div class="hrow space"><h2>工程素材</h2>${btn('legacy','从历史工程导入')}</div><div class="outline">${fileInput('asset-upload')}</div><div class="asset-list">${p.assets.map(a=>`<div class="asset"><div><strong>${esc(a.name)}</strong><small>${esc(a.kind)} · ${clock(a.duration)}　${esc(a.source?.credit||a.source?.author||'')}</small>${a.source?.url?'<small class="wrap">'+esc(a.source.url)+'</small>':''}</div><div class="hrow">${btn('asset-play','预览','',a.id)}${btn('add-asset-clip','加入时间线','',a.id)}${a.hasAudio?btn('transcribe','转录','',a.id):''}</div></div>`).join('')}</div></section>
 <section class="card"><h2>按来源导入</h2>${s.p.settings.sourceScope!=='project'?field('查找并手动选择源录像',input('asset-query'))+btn('search-assets','查找候选')+'<div id="source-choices"></div>':''}${field('媒体文件直链',input('asset-url','','url','placeholder="https://…"'))}${field('来源与授权说明',input('asset-rights'))}${btn('add-url','导入工程')}<h3>转录原句</h3>${utterances.length?utterances.map((u,i)=>`<div class="entry"><div><strong>${esc(u.text)}</strong><small>${clock(u.start)} – ${clock(u.end)}</small></div><div class="hrow">${btn('play-line','听原句','',i)}${btn('restore-line','恢复','',i)}</div></div>`).join(''):'<p class="help">转录带声音的素材后，可试听原句或恢复到时间线。</p>'}</section></div>${factList(p)}</section>`;s.utterances=utterances;
}
let styleRequest=0;
async function loadStyle(selector=s.p.style){
 const request=++styleRequest,selected=s.p.id,available=styleOptions();
 if(!available.length){el('view').innerHTML='<section class="page">'+pageHeading('风格库','本机风格包尚未载入。','style')+'</section>';return;}
 const requested=available.some(([key])=>key===selector?.id+'@'+selector?.version)?selector:styleSelector(available[0][0]);
 let st;
 try{st=await api('/api/styles/'+urlPart(requested.id)+'/'+urlPart(requested.version));}
 catch(error){
   if(request!==styleRequest||s.p?.id!==selected||s.tab!=='style')return;
   el('view').innerHTML='<section class="page">'+pageHeading('风格库','可在本机资源恢复后继续使用所选风格。','style')+field('浏览风格',select('browse-style',available,requested.id+'@'+requested.version))+'<p role="status">'+esc(error.message)+'</p></section>';return;
 }
 if(request!==styleRequest||s.p?.id!==selected||s.tab!=='style')return;
 s.style=st;const ref=(st.references||[]).filter(r=>r.available!==false&&r.locator&&r.sha256);
 const templates=st.templates||[],current=s.p.style?.id===st.id&&s.p.style?.version===st.version;
 const label=r=>r.kind==='image'?'查看参考帧':r.kind==='audio'?'试听':/script|direction|text/i.test(r.kind)?'查看文字':'看片段';
 el('view').innerHTML=`<section class="page">${pageHeading('风格库','先看参考片，再决定本期采用哪一种讲法。','style')}
 <div class="two-col style-layout"><section class="card"><div class="style-selector">${field('浏览风格',select('browse-style',available,st.id+'@'+st.version))}</div>
 <div class="hrow space"><h2>${esc(st.name)}</h2><span class="pill">v${esc(st.version)}</span></div>
 <p class="help">${esc(st.description||'')}</p>
 <div class="actions">${current?'<span class="applied">✓ 本工程正在使用</span>':btn('pin-style','用于本工程','primary')}</div>
 <h3>参考素材</h3>${ref.map(r=>`<div class="entry"><span>${esc(r.title||r.id)}</span>${btn('style-ref',label(r),'',r.id)}</div>`).join('')}
 ${st.readiness?'<details class="fold"><summary>本机资源状态</summary><p>'+esc(st.readiness.ready?'基准片指纹已核对 · 可执行原动效 '+st.readiness.executable+' / '+st.readiness.expected:st.readiness.problems.join('，'))+'</p></details>':''}</section>
 <section class="card"><h2>场景模板</h2><p class="help">在剪辑台选中镜头后，可在此设置画面强调的文字和时间。</p>
 ${field('模板',select('scene-template',templates.map(t=>typeof t==='string'?[t,t]:[t.id,t.name||t.title||t.id]),''))}
 <div class="form-grid">${field('事件落点（秒）',input('scene-action','1','number','min="0" step=".1"'))}${field('场景时长（秒）',input('scene-duration','4','number','min=".3" step=".1"'))}</div>${field('强调文字',input('scene-text','','text','placeholder="例如，灯芯亮起"'))}
 <details class="fold"><summary>动作音效</summary>${check('scene-sound','在动作帧上加入音效',s.p.settings.sceneSound??(s.p.mode!=='interview'))}${field('落点音效来源',select('scene-sound-asset',[['','模板自带'],...s.p.assets.filter(a=>a.kind==='audio').map(a=>[a.id,a.name])],''))}</details>
 ${btn('add-scene','在选区加入可编辑模板')}</section></div></section>`;
}
function pictureEvidence(qa){
 const visual=qa.evidence?.visual,coverage=visual?.motionCoverage;
 if(!coverage?.totalFrames)return '';
 const seconds=n=>((n||0)/(qa.frameRate||frameRate())).toFixed(1)+' 秒';
 const videoFrames=coverage.videoFrames??(visual.sourceWindows||[]).filter(w=>w.kind==='video').reduce((n,w)=>n+w.toFrame-w.fromFrame+1,0);
 const rows=['画面总长 '+seconds(coverage.totalFrames),'源录像 '+seconds(videoFrames),'照片底图 '+seconds(coverage.stillFrames)];
 const measured=videoFrames?'按最长 4 秒分段抽帧，源片和成片均检出局部变化的区间约 '+seconds(coverage.changingFrames)+'。':'';
 if(coverage.unverifiedFrames)rows.push('未核实 '+seconds(coverage.unverifiedFrames));
 const diagram=visual.explanatoryAnimation;
 const explained=diagram?.diagramFrames?'已核实图解 '+seconds(diagram.diagramFrames)+'，其中关键帧动作 '+seconds(diagram.actionFrames)+'。':'';
 const policy={met:'运动画面承担了主要讲解。',partial:'已用部分运动镜头，风格要求的运动画面占比仍有差距。',unmet:'所选风格要求用运动画面讲解，此版没有核实到相应镜头。',unverified:'运动镜头的作用仍待核实。','photo-adaptation':'按本期要求以照片讲解。'};
 return '<div class="entry"><div><strong>实际画面构成</strong><p>'+esc(rows.join(' · '))+'</p><small>'+esc(measured+explained+(policy[visual.styleExecution?.motionStatus]||''))+'</small></div></div>';
}
function independentEvidence(qa){
 const r=qa.evidence?.independentReview;
 if(!r)return '';
 const reason={'budget-disabled':'本工程关闭了独立终审','frames-disabled':'本工程没有授权分享帧','auto-review-disabled':'自动回看已关闭',superseded:'工程已有较新编辑','permission-changed':'工程分享授权已改变','candidate-integrity':'候选文件指纹与回执不符','reference-changed':'基准片版本已经改变','reference-unavailable':'基准片当前不可读取','source-changed':'原片已改变','time-budget-exhausted':'已到本轮时间上限','ambiguous-turn-receipt':'上次终审的回执尚不能确认','receipt-mismatch':'回执不属于当前候选'};
 const state={completed:'已完成',skipped:'已跳过',unavailable:'待复核'};
 return '<div class="entry"><div><strong>独立终审 · '+esc(state[r.status]||r.status)+'</strong><p>'+esc(reason[r.reason]||r.reason||'')+'</p>'+((r.comparisons||[]).map(c=>'<small>'+esc([Number.isFinite(c.fromFrame)?clock(c.fromFrame/(qa.frameRate||frameRate())):'',c.observation,c.comparison].filter(Boolean).join(' · '))+'</small>').join(' '))+'</div></div>';
}
function parityEvidence(qa){
 const p=qa.evidence?.compositeParity;
 if(!p)return '';
 const matches=p.checks.filter(c=>c.matches===true).length,failed=p.checks.filter(c=>c.matches===false).length;
 return '<p>预览与导出抽检 · v'+p.revision+' · '+matches+' / '+p.requested+' 处在像素容差内'+(failed?' · '+failed+' 处需复核':'')+(p.requested>matches+failed?' · 部分帧未能读取':'')+'</p>';
}
function issuePlayback(q,job,index,rate){
 const key=job+'|'+index;
 if(q.locations?.length)return q.locations.map(({frame},i)=>btn('review-issue','播放 '+(frame/rate).toFixed(2)+' 秒','',key+'|'+i)).join(' ');
 return '<small>'+clock((q.fromFrame||0)/rate)+'</small> '+btn('review-issue','播放该段','',key);
}
function drawDeliver(){
 const cards=s.jobs.filter(j=>j.files?.includes('video')).map(j=>{const qa=j.qa||{};return `<section class="card"><div class="hrow space"><h2>${esc(cutLabel(j))} · v${j.revision}</h2><span class="pill ${qa.status==='repair'?'bad':qa.status==='unverified'?'warn':''}">${esc(qa.label||'验收中')}</span></div>
 <video class="wide-video" data-review="${esc(j.id)}" controls preload="metadata" src="/api/jobs/${j.id}/file/video"></video>${parityEvidence(qa)}${pictureEvidence(qa)}${independentEvidence(qa)}
 <div class="actions">${(j.files||[]).filter(k=>['video','subtitle','project','cover34','cover43','copy','credits','review'].includes(k)).map(k=>btn('reveal',({video:'MP4',subtitle:'SRT',project:'可编辑工程',cover34:'3:4 封面',cover43:'4:3 封面',copy:'发布文案',credits:'素材与事实来源',review:'验收记录'})[k],'',j.id+'|'+k)).join('')}</div>
 ${(qa.issues||[]).map((q,i)=>`<div class="feedback"><strong>${esc(q.message||q.reason)}</strong> ${issuePlayback(q,j.id,i,qa.frameRate||frameRate())} ${btn('fix-issue','按意见修改','',j.id+'|'+i)}<br><small>${esc(q.fix||'')}</small></div>`).join('')}<p class="help">${esc((qa.limitations||[]).join('　'))}</p></section>`;}).join('');
 el('view').innerHTML=`<section class="page">${pageHeading('交付记录','播放已导出的版本，按时间点查看审片意见，或在访达中打开文件。','deliver')}${cards||'<div class="card empty-panel">完成渲染后，可在这里播放成片并打开本地交付目录。</div>'}</section>`;
}
function drawSettings(){
 const p=s.p,t=p.settings,options=[['','请选择'],...p.assets.filter(a=>a.hasAudio||a.kind==='audio').map(a=>[a.id,a.name])];
 el('view').innerHTML=`<section class="page">${pageHeading('工程设置','设置本片的旁白、配乐与分享范围，调整后点击保存。','settings')}<div class="two-col"><section class="card"><h2>创作与交付</h2><details class="fold" open><summary>内容与时长</summary>${field('名称',input('set-title',p.title))}${field('制作要求',area('set-brief',p.brief))}${field('原始脚本',area('set-script',p.script,4))}${field('素材范围',select('set-scope',[['search','允许检索其他来源'],['project','只使用我已选入工程的素材']],t.sourceScope||'search'))}${field('字幕',select('set-captions',[['burned-in','画面字幕和 SRT'],['sidecar','只导出 SRT']],t.captionDisplay||'burned-in'))}${field('最短片长（秒）',input('set-min',t.durationMinSeconds||'','number','min=".01" step="any"'))}${field('最大片长（秒）',input('set-max',t.durationMaxSeconds||'','number','min=".01" step="any"'))}${field('目标片长（秒，可留空）',input('target-length',t.targetDuration||'','number','min="1"'))}
 </details><details class="fold"><summary>旁白与音色</summary>
 ${p.styleAudio?.voice?.status==='preview-only'?'<p class="help">本期旁白为试听候选。确认采用当前声音，或在个人音色库选择已授权音色。</p>':''}${field('本期旁白选择',select('voice-selection',[['style','跟随所选风格'],['user','使用我为本片指定的声音'],['preview','仅用于试听候选']],t.voiceSelection||p.styleAudio?.voice?.selection||(['import','clone','original'].includes(t.voiceMode)?'user':'style')))}${field('声音',select('voice-mode',[['original','保留同期声'],['system','系统中文配音'],['preset','Qwen 本地预置男声 Dylan'],['import','导入旁白'],['clone','本地克隆']],t.voiceMode))}${field('导入旁白',select('narration',options,t.narrationAssetId))}
 ${field('参考录音',select('voice-reference',options,t.voiceReferenceAssetId))}${field('参考录音的准确原文',area('reference-text',t.voiceReferenceText,2))}${check('consent','我已获准用该录音建立音色',t.voiceConsent)}${btn('audition','试听当前音色')}<details><summary>个人音色库</summary>${field('使用已登记的音色',select('saved-voice',[['','请选择'],...s.voices.map(v=>[v.id,v.name])],t.voiceLibraryId))}${btn('use-voice','用于本工程')}${field('给参考音色取名',input('voice-label'))}${btn('enroll-voice','登记参考录音')}</details>
 </details><details class="fold"><summary>配乐与音效</summary>${field('本期配乐选择',select('music-selection',[['style','跟随所选风格'],['user','使用我为本片指定的配乐设置']],t.musicSelection||p.styleAudio?.music?.selection||(['asset','original'].includes(t.musicMode)||p.mode==='interview'?'user':'style')))}${field('配乐方式',select('music-mode',[['library','本地曲库'],['asset','指定素材'],['original','原创配乐'],['none','无需配乐']],t.musicEnabled===false?'none':t.musicMode||'library'))}${field('配乐素材',select('bgm',options,t.musicAssetId))}${check('project-scene-sound','场景模板在动作发生时加落点音效',t.sceneSound??(p.mode!=='interview'))}</details><details class="fold"><summary>发布包与文案</summary>${check('pack','附两种封面和发布文案',t.publishPackage)}<details><summary>编辑发布文案</summary>${field('发布标题',input('pub-title',p.publication?.title))}${field('标题中的黄色重点',input('pub-emphasis',p.publication?.emphasis))}${field('给观众的正文',area('pub-body',p.publication?.body,3))}${field('话题',input('pub-tags',p.publication?.tags?.join(' ')))}</details></details></section>
 <section class="card"><h2>项目隐私与服务</h2>${check('confirm-plan','制作前由我确认正式分镜与台词',t.confirmSequence===true)}<p class="help">Codex 会收到本项目的要求、脚本和剪辑结构。原媒体保存在本机。</p>${check('share-text','允许把转录文字交给 Codex',t.shareTranscript)}${check('share-frames','允许分享选取的参考帧、素材帧和成片帧（含画面上的字幕）',t.shareFrames)}${check('auto-review','分享画面时自动回看首版，保留两版',t.autoReview===true)}${check('final-review','允许独立终审使用 1 个 Codex 回合',t.finalReviewMaxTurns!==0)}
 ${check('cloud','启用第三方原创配乐',t.cloudEnabled)}${field('本项目云配乐总时长预算（秒）',input('budget',t.cloudBudget,'number','min="0" step="1"'))}
 <div class="actions">${btn('settings-save','保存工程设置','primary')}</div><hr><details class="fold"><summary>生成原创配乐</summary>${field('曲风与用途',area('music-prompt','',2))}${field('时长（秒）',input('music-length',15,'number','min="3" max="600"'))}${btn('compose-music','从云端生成并导入')}${(p.musicReceipts||[]).map(r=>`<div class="entry"><small>${esc(r.seconds)} 秒 · ${esc(r.status)}</small>${['sent','unknown'].includes(r.status)?btn('reconcile','核对回执','',r.id):''}</div>`).join('')}</details></section></div></section>`;
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
 ${[['render','本地渲染','melt'],['speech','语音转录','transcription'],['clone','中文音色克隆','clone'],['preset','Qwen 本地预置男声 Dylan','preset']].map(([key,label,cap])=>`<div class="entry"><div><strong>${label}</strong><small>${capability(cap)}</small></div>${btn('install',key==='preset'?'准备本地预置男声':'准备组件','',key)}</div>`).join('')}
 ${v.install?'<p class="help">'+esc(v.install.state+' · '+v.install.message)+'</p>':''}
 <h3>云配乐账号</h3>${field('ElevenLabs API 密钥（仅在本次打开期间使用）',input('cloud-key','','password','autocomplete="off"'))}${btn('cloud-key','保存本次连接')} <span class="help">${v.cloudMusic?'已连接':''}</span>`);
}
async function showDraft(project,fromFrame,focusFrame){
  notice('正在合成此处的工程草稿');
  const draft=await api('/api/projects/'+project.id+'/draft',{fromFrame});
  if(s.p?.id!==project.id||draft.revision!==s.p.revision)return;
  const fps=project.profile.fps;
  modal('当前草稿 · v'+draft.revision+' · '+clock(draft.fromFrame/fps)+'–'+clock(draft.toFrame/fps),
    '<video class="wide-video" autoplay controls playsinline src="'+esc(draft.url)+'"></video>');
  if(Number.isInteger(focusFrame)){
    const player=el('dialog-body').querySelector('video');
    player.addEventListener('loadedmetadata',()=>{player.currentTime=Math.max(0,(focusFrame-draft.fromFrame)/fps-.5);},{once:true});
  }
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
   const at=playhead();
   const selected=p.timeline.clips.find(c=>c.id===s.clip);
   return showDraft(p,selected?.start??at);
 }
 case 'save-preview-cue':{
   const index=s.cueFocus?.id===id?s.cueFocus.index:0;
   const focusFrame=Math.round(Number(val('clip-at'))*p.profile.fps)+Number(val('cue-'+index));
   await runAction('save-clip',id);
   if(s.p?.id===p.id)return showDraft(s.p,Math.max(0,focusFrame-p.profile.fps),focusFrame);
   return;
 }
 case 'preview':case 'render':return startJob(act,'local');
 case 'pause':s.jobs=await proj('/jobs');await api('/api/jobs/'+id+'/pause',{});return reload();
 case 'replan':return startJob('produce','codex');
 case 'approve-plan':{
   const j=s.jobs.find(job=>job.id===id);
   await api('/api/jobs/'+id+'/resume',{approvedSequenceHash:j.approval.hash});return reload();}
 case 'resume':await api('/api/jobs/'+id+'/resume',{confirmRetry:true});return reload();
 case 'clip-mute':{const c=p.timeline.clips.find(c=>c.id===id);return edit([{op:'update',id,changes:{muted:!c.muted}}]);}
 case 'lock':{const c=p.timeline.clips.find(c=>c.id===id);return edit([{op:'lock',id,locked:!c.locked}]);}
 case 'remove':s.clip=null;return edit([{op:'remove',id}]);
 case 'split-clip':{
  const c=p.timeline.clips.find(c=>c.id===id), at=playhead();
  if(!c||at<=c.start||at>=c.start+c.duration)throw Error('将播放头放在所选片段的两个端点之间。');
  return edit([{op:'split',id,newId:crypto.randomUUID(),atFrame:at}]);}
 case 'add-component':{
   const spec=componentById(val('new-component')),shot=p.timeline.clips.find(c=>c.id===s.clip&&c.track==='video');
   const start=shot?.start??playhead(),duration=shot?.duration??frameRate()*4;
   const props=Object.fromEntries(spec.fields.filter(f=>f.type==='text').map(f=>[f.key,newText[f.key]??p.title]));
   const clip={id:crypto.randomUUID(),track:'graphic',start,duration,geometry:defaultMotionGeometry(spec,contentStage(p.profile,p.style)),
     motion:{componentId:spec.id,version:spec.version,props,cueFrames:motionCues(spec,duration,frameRate())}};
   await edit([{op:'add',clip}]);return pickClip(clip.id);
 }
 case 'add-cue':case 'drop-cue':{
   const box=el('cue-0').closest('fieldset'),sliders=box.querySelectorAll('[data-cue]'),i=sliders.length;
   if(act==='drop-cue'){if(i>1){sliders[i-1].closest('label').remove();if(i===2)box.querySelector('[data-act="drop-cue"]').remove();}return;}
   const max=Number(sliders[0].max),at=Math.min(max,Number(sliders[i-1].value)+frameRate());
   if(at<=Number(sliders[i-1].value))throw Error('已经到达片段末帧。');
   const add=box.querySelector('[data-act="add-cue"]');
   add.insertAdjacentHTML('beforebegin',field('切换 '+(i+1)+' <output id="cue-read-'+i+'">'+at+' 帧</output>',input('cue-'+i,at,'range','data-cue="'+i+'" min="0" max="'+max+'" step="1"')));
   if(i===1)add.insertAdjacentHTML('afterend',btn('drop-cue','移除末次切换'));return;
 }
 case 'pair-shots':{
   const c=p.timeline.clips.find(c=>c.id===id),asset=p.assets.find(a=>a.id===val('right-asset'));
   const duration=asset.kind==='image'?c.duration:Math.min(c.duration,Math.floor(asset.duration*frameRate()));
   if(duration<1)throw Error('右侧素材缺少可用帧。');
   const clip={id:crypto.randomUUID(),assetId:asset.id,track:'video',start:c.start,duration,sourceIn:0,gain:0,fit:'cover',viewport:{x:.5,y:0,width:.5,height:1}};
   await edit([{op:'update',id,changes:{fit:'cover',viewport:{x:0,y:0,width:.5,height:1}}},{op:'add',clip}]);return pickClip(clip.id);
 }
 case 'add-shake':{
   const c=p.timeline.clips.find(c=>c.id===id),offsetFrames=Math.max(0,Math.min(c.duration-1,playhead()-c.start));
   const box=el('picture-shakes'),rows=[...box.querySelectorAll('[data-shake]')],index=Math.max(-1,...rows.map(r=>Number(r.dataset.shake)))+1;
   if(rows.length>=16)throw Error('每个镜头最多可放 16 个震屏。');
   box.insertAdjacentHTML('beforeend',shakeRow({offsetFrames,duration:Math.min(c.duration-offsetFrames,Math.max(1,Math.round(frameRate()*7/30)))},index));return;
 }
 case 'remove-shake':{el('picture-shakes').querySelector('[data-shake="'+Number(id)+'"]')?.remove();return;}
 case 'save-clip':{
  const c=p.timeline.clips.find(c=>c.id===id),f=frameRate();
  const changes={start:Math.round(Number(val('clip-at'))*f),duration:Math.round(Number(val('clip-len'))*f)};
  const edited=key=>{const n=el('clip-'+key);return n&&Number(n.value)!==Number(n.defaultValue);};
  if(edited('in'))changes.sourceIn=Number((Number(val('clip-in'))*f).toFixed(8));
  if(edited('gain'))changes.gain=Number(val('clip-gain'));
  if(c.motion){
    const spec=componentById(c.motion.componentId),props={...c.motion.props};
    for(const f of spec.fields.filter(f=>!['second','third'].includes(f.key))){
      const node=el('motion-'+f.key);
      props[f.key]=f.type==='number'?Number(node.value):f.type==='boolean'?node.checked:node.value;
    }
    const cueFrames=Array.from(document.querySelectorAll('[data-cue]'),n=>Number(n.value));
    const sound=el('motion-sound-on'),soundDesign={...c.soundDesign};
    if(sound){
      const defaultEnabled=Boolean(spec.soundEvents?.length),selected=val('motion-sound-id');
      if(sound.checked!==defaultEnabled||soundDesign.enabled!=null)soundDesign.enabled=sound.checked;
      if(selected!==String(soundDesign.resourceId||'')){
        if(selected)soundDesign.resourceId=selected;else delete soundDesign.resourceId;
        delete soundDesign.assetId;
      }
    }
    return edit([{op:'update',id,changes:{start:changes.start,duration:changes.duration,geometry:readRect('motion-rect'),
      ...(sound?{soundDesign}:{}),motion:{...c.motion,props,cueFrames}}}]);
  }
  const asset=p.assets.find(a=>a.id===c.assetId);
  const speedChange=asset&&asset.kind!=='image'&&edited('speed');
  const newSpeed=Number(val('clip-speed'));
  if(el('clip-audio-track')&&val('clip-audio-track')!==c.track)changes.track=val('clip-audio-track');
  if(!edited('len'))delete changes.duration;
  if(!edited('at'))delete changes.start;
  if(['caption','graphic'].includes(c.track)){
    changes.text=val('clip-text');changes.geometry={...c.geometry,x:Number(val('clip-x')),y:Number(val('clip-y'))};
    if(c.shape==='polygon')changes.geometry.points=JSON.parse(val('clip-points'));
    changes.style={...c.style,fontSize:Number(val('clip-font'))};changes.keyframes=JSON.parse(val('clip-keys')||'[]');
  }
  if(c.track==='video'){
    changes.viewport=el('use-viewport').checked?readRect('viewport'):null;changes.fit=val('clip-fit');
    const point=key=>Object.fromEntries(['x','y','zoom'].map(k=>[k,Number(val('view-'+key+'-'+k))]));
    if(el('clip-framing').checked)changes.framing={from:point('from'),to:point('to')};
    else if(c.framing)changes.framing=null;
    if(el('picture-shakes')&&(c.pictureEffects||el('picture-shakes').children.length))changes.pictureEffects=readShakes();
    changes.assetId=val('replace-asset');const n=Number(val('clip-fade'));const type=val('clip-transition');if(n!==(c.transition?.duration||0)||(n&&type!==(['wipe-right','whip-pan','organic-dissolve'].includes(c.transition?.type)?c.transition.type:'fade')))changes.transition=n?{type,duration:n}:null;}
  const commands=speedChange?[{op:'speed',id,speed:newSpeed}]:[];
  if(Object.keys(changes).length)commands.push({op:'update',id,changes});
  if(commands.length)return edit(commands);
  return;}
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
    return previewOriginal(asset,{fromFrame,toFrame:fromFrame+c.duration*(c.speed||1)});
 }
 case 'insert-caption':{
   const clip={id:crypto.randomUUID(),track:'caption',start:playhead(),duration:frameRate()*2,text:'新字幕'};
   s.clip=clip.id;await edit([{op:'add',clip}]);await pickClip(clip.id,false);el('clip-text')?.select();return;
 }
 case 'insert-asset':case 'add-asset-clip':{
  const a=p.assets.find(a=>a.id===(act==='insert-asset'?val('insert-asset'):id));if(!a)throw Error('请先导入素材。');const track=a.kind==='audio'?'music':'video';
  const start=act==='insert-asset'?playhead():Math.max(0,...p.timeline.clips.filter(c=>c.track===track).map(c=>c.start+c.duration));
  s.clip=crypto.randomUUID();await edit([{op:'add',clip:{id:s.clip,assetId:a.id,track,start,sourceIn:0,duration:Math.max(1,Math.round((a.kind==='image'?4:a.duration)*frameRate())),gain:1,speed:1}}]);notice('已加入'+tracks[track]+'轨');return;}
 case 'search-assets':{
   const rows=await proj('/source-options',{query:val('asset-query')});
   el('source-choices').innerHTML=rows.map(r=>'<div class="entry"><div>'+check('pick-'+r.key,r.title,false)+'<small>'+esc([r.credit,r.date,r.license].filter(Boolean).join(' · '))+'</small>'+(r.hasWindow?field('原片入点（秒）',input('in-'+r.key,'0','number'))+field('原片出点（秒）',input('out-'+r.key,'10','number'))+check('rights-'+r.key,'我已获得该原片的使用授权',false):'')+'</div></div>').join('')+(rows.length?btn('pick-assets','导入选中素材'):'没有找到匹配的录像。');return;}
 case 'pick-assets':{
   const items=Array.from(el('source-choices').querySelectorAll('input[id^="pick-"]:checked')).map(e=>{const key=e.id.slice(5);return {key,...(el('in-'+key)&&{window:{start:Number(val('in-'+key)),end:Number(val('out-'+key))},authorized:el('rights-'+key).checked})};});
   await proj('/source-options/pick',{items});return choose(p.id,'assets');}
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
 case 'settings-save':{
   const changes={title:val('set-title'),brief:val('set-brief'),script:val('set-script'),publication:{title:val('pub-title'),emphasis:val('pub-emphasis'),body:val('pub-body'),tags:val('pub-tags').split(/\s+/).filter(Boolean)},settings:{captionDisplay:val('set-captions'),sourceScope:val('set-scope'),confirmSequence:el('confirm-plan').checked,autoReview:el('auto-review').checked,finalReviewMaxTurns:el('final-review').checked?1:0,durationMinSeconds:val('set-min')?Number(val('set-min')):null,durationMaxSeconds:val('set-max')?Number(val('set-max')):null,voiceSelection:val('voice-selection'),musicSelection:val('music-selection'),targetDuration:val('target-length')?Number(val('target-length')):null,voiceMode:val('voice-mode'),narrationAssetId:val('narration'),voiceReferenceAssetId:val('voice-reference'),voiceReferenceText:val('reference-text'),voiceConsent:el('consent').checked,musicAssetId:val('bgm'),musicMode:val('music-mode'),musicEnabled:val('music-mode')!=='none',requireMusic:val('music-mode')==='asset'||val('music-mode')==='original',publishPackage:el('pack').checked,sceneSound:el('project-scene-sound').checked,shareTranscript:el('share-text').checked,shareFrames:el('share-frames').checked,cloudEnabled:el('cloud').checked,cloudBudget:Number(val('budget'))}};
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
  const [job,n,at]=id.split('|'),j=s.jobs.find(j=>j.id===job),q=j.qa.issues[Number(n)];
  const f=j.qa.frameRate||frameRate(),location=at===undefined?undefined:q.locations?.[Number(at)]?.frame,from=location??q.fromFrame??0,to=location??q.toFrame??from;
  if(act==='fix-issue'){
    const times=q.locations?.length?q.locations.map(p=>(p.frame/f).toFixed(2)+' 秒').join('、'):clock(from/f);
    s.tab='edit';draw();el('instruction').value='修改 '+times+' 附近：'+q.message+' '+(q.fix||'');el('instruction').focus();return;
  }
  const v=document.querySelector(`video[data-review="${CSS.escape(job)}"]`);v.currentTime=Math.max(0,from/f-.8);v.ontimeupdate=()=>{if(v.currentTime>to/f+1){v.pause();v.ontimeupdate=null;}};return v.play();}
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
 if(s.polling||!s.p||timeline?.dragging)return;s.polling=true;
 try{
  const id=s.p.id,previous=s.jobs,next=await proj('/jobs');
  if(s.p?.id!==id||timeline?.dragging)return;
  const changed=previous.some(a=>['queued','running','pausing'].includes(a.status)&&next.some(b=>a.id===b.id&&['done','paused','failed','awaiting-plan'].includes(b.status)));
  if(changed){
    const project=await proj();
    if(s.p?.id!==id||timeline?.dragging)return;
    s.jobs=next;
    if(currentResult(project)){s.p=project;draw();}
    await refreshList();
  }else{
    s.jobs=next;
    if(el('activity')&&next.length)el('activity').innerHTML=activity(next[0]);
  }
 }catch{}finally{s.polling=false;}
}
async function init(){[s.styles,s.voices,s.components]=await Promise.all([api('/api/styles'),api('/api/voices'),api('/api/motion-components')]);await refreshList();if(s.projects.length)await choose(s.projects[0].id);else newPage();setInterval(refreshJobs,1800);}
window.addEventListener('pagehide',releaseEditor);
window.addEventListener('pageshow',e=>{if(e.persisted&&s.p)draw();});
safeAction(init)();
