// Per-window drafts stay attached to the project, clip and original field value.
const inactiveJobs = new Set(['done','paused','failed','awaiting-plan']);
export const activeJob = jobs => jobs?.find(j=>['queued','running','pausing'].includes(j.status));
export const finishedJob = status => inactiveJobs.has(status);

export function busyGroup(action,id=''){
  if(['mode','tab','open-project','drop-file','keep-draft','use-current','add-cue','drop-cue','add-shake','remove-shake','fix-issue'].includes(action))return null;
  if(['create','create-run','continue-create'].includes(action))return 'create';
  if(['direct','local','render','preview','pause','resume','approve-plan','replan'].includes(action))return 'jobs';
  if(['save-clip','save-preview-cue','clip-mute','split-clip','remove','lock','add-asset-clip','insert-asset','insert-caption','add-component','pair-shots','restore-line','add-scene'].includes(action))return 'timeline';
  if(['settings-save','use-voice','enroll-voice','audition','pin-style'].includes(action))return 'settings';
  if(['install','login','cloud-key','cloud-disconnect'].includes(action))return 'device';
  if(['charged','not-charged','compose-music','reconcile'].includes(action))return 'cloud-music';
  return action+'|'+id;
}
export function actionGate(){
  const active=new Set();
  const key=(scope,op,id)=>JSON.stringify([scope,busyGroup(op,id)]);
  return {
    has:(scope,op,id)=>active.has(key(scope,op,id)),
    begin(scope,op,id){
      if(busyGroup(op,id)===null)return ()=>{};
      const k=key(scope,op,id);if(active.has(k))return null;
      active.add(k);return ()=>active.delete(k);
    }
  };
}
const valueOf=n=>n.type==='checkbox'||n.type==='radio'?n.checked:n.value;
const write=(n,v)=>{if(n.type==='checkbox'||n.type==='radio')n.checked=v;else n.value=v;};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const cleanField=n=>n.id&&!['file','password','button','submit','hidden'].includes(n.type)&&!n.closest('dialog,#clip-automation,.tl-transport');
export function formDrafts(root,scopeFor){
  const values=new Map(), bound=new WeakMap(), structures=new WeakMap();
  const controls=container=>[...container.querySelectorAll('input[id],textarea[id],select[id]')].filter(cleanField);
  const groups=container=>[container.querySelector('#picture-shakes'),container.querySelector('#cue-0')?.closest('fieldset')].filter(Boolean);
  function fieldKey(n){return n.id||n.querySelector('input')?.id+'-group';}
  function groupState(n){return controls(n).map(c=>[c.id,valueOf(c)]);}
  function store(binding,value,template){
    if(same(value,binding.base)){values.delete(binding.key);return;}
    const previous=values.get(binding.key);
    values.set(binding.key,{base:previous?.base??binding.base,value,template,conflict:previous?.conflict||false});
  }
  function mount(container=root){
    for(const group of groups(container)){
      if(structures.has(group))continue;
      const scope=scopeFor(group);if(!scope)continue;
      const key=JSON.stringify([scope,fieldKey(group)+':structure']), base=groupState(group),saved=values.get(key);
      structures.set(group,{key,base});
      if(saved){
        if(same(saved.value,base)){values.delete(key);continue;}
        if(!same(base,saved.base))saved.conflict=true;
        if(saved.template)group.replaceChildren(...[...saved.template.cloneNode(true).childNodes]);
      }
    }
    for(const n of controls(container)){
      if(bound.has(n)||n.closest('#picture-shakes')||n.closest('fieldset')?.querySelector('#cue-0'))continue;
      const scope=scopeFor(n);if(!scope)continue;
      const key=JSON.stringify([scope,n.id]),base=valueOf(n),saved=values.get(key);
      bound.set(n,{key,base});
      if(!saved)continue;
      if(same(saved.value,base)){values.delete(key);continue;}
      if(!same(base,saved.base))saved.conflict=true;
      if(n.tagName==='SELECT'&&![...n.options].some(o=>o.value===saved.value)){saved.conflict=true;continue;}
      write(n,saved.value);
    }
  }
  function capture(container=root){
    for(const group of groups(container)){
      const b=structures.get(group);if(b)store(b,groupState(group),group.cloneNode(true));
    }
    for(const n of controls(container)){
      const b=bound.get(n);
      if(b)store(b,valueOf(n));
    }
  }
  function conflicts(container=root){
    return [...groups(container).map(n=>[n,structures.get(n)]),...controls(container).map(n=>[n,bound.get(n)])]
      .filter(([,b])=>b&&values.get(b.key)?.conflict);
  }
  function resolve(container,keepDraft){
    for(const [n,b] of conflicts(container)){
      if(keepDraft){const saved=values.get(b.key);saved.base=b.base;saved.conflict=false;}
      else{values.delete(b.key);if(bound.has(n))write(n,b.base);else structures.delete(n);}
    }
  }
  function clear(scope){
    for(const key of values.keys())if(JSON.parse(key)[0]===scope)values.delete(key);
  }
  // A successful save clears only fields captured by that request. Later typing survives.
  function submitted(scope){
    capture();const at=new Map([...values].filter(([key])=>JSON.parse(key)[0]===scope).map(([key,row])=>[key,structuredClone(row.value)]));
    return ()=>{
      capture();
      for(const n of [...groups(root),...controls(root)]){
        const b=bound.get(n)||structures.get(n);
        if(b&&at.has(b.key))b.base=at.get(b.key);
      }
      for(const [key,v] of at){const remaining=values.get(key);if(same(remaining?.value,v))values.delete(key);else if(remaining){remaining.base=v;remaining.conflict=false;}}
    };
  }
  return {mount,capture,conflicts,resolve,clear,submitted};
}
export function durationProblem(low,high,target){
  const numbers=[low,high,target].map(v=>v===''||v==null?null:Number(v));
  if(numbers.some(v=>v!=null&&(!Number.isFinite(v)||v<=0||v>86400)))return '片长须为一天以内的正数。';
  const [min,max,goal]=numbers;
  if(min!=null&&max!=null&&min>max)return '最短片长不能超过最大片长。';
  if(goal!=null&&(min!=null&&goal<min||max!=null&&goal>max))return '目标片长须在填写的最短与最大片长之间。';
  return '';
}
export function dependencies({frames,review,scope,voice,music,cloud,viewport,framing,sound}){
  return {
    autoReview:frames?'':'先开启分享画面。',finalReview:frames&&review?'':'先开启分享画面和自动回看。',
    sourceUrls:scope==='project'?'当前只使用已在工程内的素材。':'',
    narration:voice==='import'?'':'选择导入旁白后可用。',
    bgm:['asset','original'].includes(music)?'':'选择指定素材或原创配乐后可用。',
    budget:cloud?'':'开启第三方原创配乐后可设置预算。',
    viewport:viewport?'':'先启用独立画面窗口。',framing:framing?'':'先启用按原图位置取景。',sound:sound?'':'先启用动作音效。'
  };
}
export function jobReason(action,{jobs=[],hasClips=false,message='',approvalRevision,revision}){
  const active=activeJob(jobs);
  if(['preview','render','draft'].includes(action)&&!hasClips)return '先在时间线加入可播放的片段。';
  if(['preview','render','local','resume','approve-plan','replan'].includes(action)&&active)return '当前工程已有任务，等待完成或先暂停。';
  if(action==='direct'&&active){
    if(active.status==='pausing')return '正在保存暂停进度。';
    if(!message.trim())return '输入本次新的剪辑要求。';
  }
  if(action==='approve-plan'&&approvalRevision!==revision)return '工程修订已改变，请重新拟定分镜。';
  return '';
}

export function syncControls({doc,project:p,jobs=[],selected,gate,scope,files=[],mode,style,system,frame=0,drafts,clicked}){
  const by=id=>doc.getElementById(id),v=id=>by(id)?.value?.trim()||'',on=id=>Boolean(by(id)?.checked);
  const native=(node,reason)=>{
    if(!node)return;
    if(reason){if(!node.dataset.stateOff)node.dataset.originalTitle=node.title;node.dataset.stateOff=reason;node.disabled=true;node.title=reason;}
    else if(node.dataset.stateOff){node.disabled=false;node.title=node.dataset.originalTitle||'';delete node.dataset.stateOff;delete node.dataset.originalTitle;}
  };
  const page=by('content'),clip=p?.timeline.clips.find(c=>c.id===selected);
  const d=dependencies({frames:on(p?'share-frames':'new-share-frames'),review:on(p?'auto-review':'new-auto-review'),scope:v(p?'set-scope':'new-source-scope'),voice:v('voice-mode'),music:v('music-mode'),cloud:on('cloud'),viewport:on('use-viewport'),framing:on('clip-framing'),sound:on('motion-sound-on')});
  for(const [id,why] of Object.entries({[p?'auto-review':'new-auto-review']:d.autoReview,[p?'final-review':'new-final-review']:d.finalReview,'new-urls':d.sourceUrls,'new-facts':d.sourceUrls,narration:d.narration,bgm:d.bgm,budget:d.budget,'motion-sound-id':d.sound,'scene-sound-asset':on('scene-sound')?'':'启用场景音效后可选声音来源。'}))native(by(id),why);
  for(const n of doc.querySelectorAll('[id^="viewport-"]'))native(n,d.viewport);
  for(const n of doc.querySelectorAll('[id^="view-from-"],[id^="view-to-"]'))native(n,d.framing||(clip?.framing?.keys?.length?'在可视关键帧面板调整现有取景曲线。':''));
  const lock='片段已锁定，先解锁再编辑。';
  for(const n of doc.querySelectorAll('#inspect input,#inspect select,#inspect textarea')){
    if(n.closest('#clip-automation'))continue;
    if(clip?.locked){if(!n.dataset.clipLocked)n.dataset.wasDisabled=String(n.disabled);n.dataset.clipLocked='1';n.disabled=true;n.title=lock;}
    else if(n.dataset.clipLocked){delete n.dataset.clipLocked;n.disabled=n.dataset.wasDisabled==='true';delete n.dataset.wasDisabled;}
  }
  const conflicts=drafts?.conflicts(page)||[];
  let banner=by('control-conflicts');
  if(conflicts.length){
    const container=by('inspect')?.contains(conflicts[0][0])?by('inspect'):by('view');
    if(container&&!banner){
      banner=doc.createElement('div');banner.id='control-conflicts';banner.className='feedback';banner.setAttribute('role','status');
      const label=doc.createElement('span');label.className='conflict-fields';banner.append(label);
      for(const [act,name] of [['keep-draft','采用我的修改'],['use-current','采用当前工程值']]){
        const button=doc.createElement('button');button.type='button';button.dataset.act=act;button.textContent=name;banner.append(button);
      }
      container.prepend(banner);
    }
    if(banner)banner.querySelector('.conflict-fields').textContent='工程中也改过以下草稿字段：'+conflicts.map(([n])=>n.labels?.[0]?.firstChild?.textContent||n.id||'关键帧').join('、')+'。';
  }else banner?.remove();
  const hasClips=Boolean(p?.timeline.clips.some(c=>!c.hidden&&c.enabled!==false&&c.duration>0));
  const active=activeJob(jobs);
  const changedVoice=v('voice-mode'),cloneReady=v('voice-reference')&&v('reference-text')&&on('consent');
  const needClone='选择已授权的参考录音，填写准确原文并确认授权。';
  const requestState=p?.musicReceipts||[];
  const reasons={
    'create':!v('new-title')&&!v('brief')&&!v('script')&&!files.length?'填写选题、脚本或选择本地素材。':'',
    'settings-save':durationProblem(v('set-min'),v('set-max'),v('target-length')),
    'use-voice':!v('saved-voice')?'先选择已登记的音色。':'',
    'enroll-voice':!cloneReady||!v('voice-label')?needClone+' 填写音色名称。':'',
    'audition':changedVoice==='clone'&&!cloneReady?needClone:changedVoice==='import'&&!v('narration')?'选择导入的录音。':changedVoice==='original'&&!p?.assets.some(a=>a.hasAudio||a.kind==='audio')?'工程需要可试听的原录音。':'',
    'compose-music':!on('cloud')||!p?.settings?.cloudEnabled?'先开启并保存本项目云配乐授权。':requestState.some(r=>['sent','unknown'].includes(r.status))?'先核对已有云配乐回执。':system&&system.cloudMusic===false?'先在本机与账号中连接云配乐账号。':!v('music-prompt')?'填写本次曲风与用途。':!Number.isInteger(Number(v('music-length')))||Number(v('music-length'))<3||Number(v('music-length'))>600?'曲长须为 3 至 600 整秒。':Number(v('music-length'))>Number(p?.settings?.cloudBudget||0)-requestState.filter(r=>['done','charged'].includes(r.status)).reduce((n,r)=>n+r.seconds,0)?'剩余已保存预算不足。':'',
    'add-url':!/^https?:\/\/[^\s/]+/i.test(v('asset-url'))?'填写公开的 HTTP 或 HTTPS 文件直链。':'',
    'search-assets':!v('asset-query')?'输入要查找的录像。':'',
    'pick-assets':!by('source-choices')?.querySelector('input[id^="pick-"]:checked')?'先勾选要导入的素材。':'',
    'pin-style':p?.style?.id===style?.id&&p?.style?.version===style?.version?'工程已采用此版本。':'',
    'add-scene':!style||style.id!==p?.style?.id||style.version!==p.style.version?'先将这个风格版本用于工程。':!v('scene-template')?'该风格没有可加入的场景模板。':!(Number(v('scene-duration'))>0)||Number(v('scene-action'))<0||Number(v('scene-action'))>=Number(v('scene-duration'))?'事件落点须在场景时长内。':'',
    'insert-asset':!v('insert-asset')?'先导入或选择一份素材。':'',
    'add-component':!v('new-component')?'先选择动效组件。':'',
    'cloud-key':!v('cloud-key')?'输入本次连接的密钥。':''
  };
  if(!p){reasons.create||=durationProblem(v('new-min'),v('new-max'),v('new-duration'));reasons['create-run']=reasons.create||(mode==='interview'&&!files.some(f=>/^(audio|video)\//.test(f.type)||/\.(mp4|mov|m4v|mkv|webm|wav|aif|aiff|mp3|m4a|flac)$/i.test(f.name))?'选择可转录的视频或录音，或先仅创建工程。':'');}
  if(clip?.locked)for(const op of ['save-clip','save-preview-cue','split-clip','remove','clip-mute','add-cue','drop-cue','add-shake','remove-shake','pair-shots'])reasons[op]=lock;
  if(clip&&!clip.locked){
    const numbers=['clip-at','clip-len','clip-in','clip-speed','clip-gain','clip-font'];
    for(const id of numbers){
      const node=by(id);if(!node||node.disabled)continue;
      const n=Number(node.value),positive=['clip-len','clip-speed','clip-font'].includes(id);
      if(!node.value.trim()||!Number.isFinite(n)||(positive?n<=0:n<0)||node.validity?.badInput){
        reasons['save-clip']='片段数值须有效，时长、速率与字号须大于零。';break;
      }
    }
    for(const id of ['clip-keys','clip-points'])if(by(id)&&v(id)){
      try{if(!Array.isArray(JSON.parse(v(id))))throw Error();}catch{reasons['save-clip']='关键帧和轮廓顶点须为有效的 JSON 数组。';}
    }
    if(reasons['save-clip'])reasons['save-preview-cue']=reasons['save-clip'];
  }
  if(!reasons['split-clip']&&clip&&(frame<=clip.start||frame>=clip.start+clip.duration))reasons['split-clip']='将播放头放在这个片段的两个端点之间。';
  if(conflicts.length)for(const op of ['settings-save','save-clip','save-preview-cue','audition'])reasons[op]='先处理已在工程中改变的草稿字段。';
  if(by('new-files')&&(files.length||by('selected-files')?.querySelector('button'))){
    const label=by('selected-files');
    if(label&&label.dataset.fileNames!==JSON.stringify(files.map(f=>[f.name,f.size,f.lastModified]))){
      label.dataset.fileNames=JSON.stringify(files.map(f=>[f.name,f.size,f.lastModified]));label.replaceChildren();
      files.forEach((f,i)=>{const n=doc.createElement('button');n.type='button';n.dataset.act='drop-file';n.dataset.id=String(i);n.textContent=f.name+' ×';n.title='移除此选取的素材';label.append(n);});
      if(!files.length)label.textContent='可同时选择视频、音频与图片。';
    }
  }
  const buttons=clicked?[clicked]:doc.querySelectorAll('[data-act]');
  for(const n of buttons){
    const act=n.dataset.act,id=n.dataset.id;
    if(n.closest('#guide-dialog,#clip-automation'))continue;
    const busy=gate.has(typeof scope==='function'?scope(act):scope,act,id), approval=jobs.find(j=>j.id===id)?.approval;
    let reason=busy?'正在处理，请等待本次操作完成。':(reasons[act]||jobReason(act,{jobs,hasClips,message:v('instruction'),approvalRevision:approval?.revision,revision:p?.revision}));
    if(act==='direct'&&active)n.textContent=active.phase==='creative'?'告诉 Codex 新的方向':active.kind==='preview'?'暂停预览并改稿':'暂停导出并改稿';
    if(act==='install'&&system?.install?.state==='running')reason='有本机组件正在准备。';
    if(act==='pick-assets'&&!reason){
      for(const e of by('source-choices')?.querySelectorAll('input[id^="pick-"]:checked')||[]){const key=e.id.slice(5);
        const start=Number(v('in-'+key)),end=Number(v('out-'+key));
        if(by('in-'+key)&&(!on('rights-'+key)||start<0||!(end>start))){reason='勾选授权，并为选中的视频填写有效原片区间。';break;}
      }
    }
    if(reason){if(!n.dataset.controlReason)n.dataset.defaultTitle=n.title;n.dataset.controlReason=reason;n.setAttribute('aria-disabled','true');n.title=reason;}
    else if(n.dataset.controlReason){n.removeAttribute('aria-disabled');n.title=n.dataset.defaultTitle||'';delete n.dataset.controlReason;delete n.dataset.defaultTitle;}
    if(busy)n.setAttribute('aria-busy','true');else n.removeAttribute('aria-busy');
  }
}
