// Stable control names bind explanations to actions, even when their visible label is a filename.
const entries={
 new:[
 ['从选题开始','mode:topic'],['脚本与素材','mode:script'],['精剪原片','mode:interview'],['工程名称／','new-title brief script'],['画幅／','ratio new-style new-duration'],['最短片长／','new-min new-max'],['素材范围／','new-source-scope new-facts new-urls'],['本地素材／','new-files new-voice'],['字幕','new-captions'],['制作前确认','new-confirm-sequence'],['分享语音','new-share-text new-share-frames new-auto-review new-final-review'],['移除已选','drop-file continue-create'],['仅创建工程','create create-run'],['打开工程文件夹','import-folder folder-picker open-project new']],
 edit:[
 ['播放头／','tl-time tl-ruler step-back step-next'],['播放／','play out fit in'],['吸附／','snap clip'],['分割／','split remove ripple'],['复制／','copy paste undo redo'],['M／','track:toggle track:lock'],['本次要求','instruction direct'],['暂停／','pause resume approve-plan replan'],['生成本地草稿','local preview render draft'],['插入素材','insert-asset insert-caption add-component new-component'],['选中片段','clip-picker']],
 inspector:[
 ['起点／','clip-at clip-len clip-in clip-speed clip-gain'],['音频轨道','clip-audio-track clip-mute'],['锁定片段','lock clip-source'],['移除片段','remove split-clip save-clip'],['画面窗口','use-viewport viewport-* clip-fit'],['右窗素材','right-asset pair-shots'],['原素材取景','clip-framing view-*'],['替换画面素材','replace-asset clip-transition clip-fade'],['动作震屏','add-shake remove-shake shake-*'],['文字／','clip-text clip-x clip-y clip-font clip-points'],['图层位置','clip-keys'],['第几步','cue-* add-cue drop-cue'],['动作音效','motion-sound-on motion-sound-id motion-rect-*'],['字号／','motion-font motion-size motion-white motion-cyan motion-transparentBackground motion-color motion-accent motion-ink motion-emphasis motion-count motion-crack motion-tilt motion-glow'],['眉题／','motion-*'],['保存并预览','save-preview-cue']],
 advanced:[
 ['画面蒙版','mode-mask rectangle ellipse'],['水平中心／','width height feather invert'],['镜头取景','mode-focus zoom'],['图层关键帧','mode-graphic scale opacity rotation'],['在播放头加关键帧','key-*'],['时间曲线','mode-curve slow fast'],['在播放头加锚点','sourceFrame'],['应用到时间线','apply discard']],
 assets:[
 ['选择文件','asset-upload legacy'],['查找并','asset-query search-assets pick-assets pick-* in-* out-* rights-*'],['媒体文件直链','asset-url asset-rights add-url'],['预览／','asset-play add-asset-clip transcribe'],['听原句','play-line restore-line'],['打开出处','fact-source fact-shot event-label mark-action source-preview']],
 style:[
 ['浏览风格','browse-style pin-style'],['看片段','style-ref'],['模板／','scene-template scene-action scene-duration'],['强调文字','scene-text scene-sound scene-sound-asset'],['在选区','add-scene']],
 settings:[
 ['名称／','set-title set-brief set-script set-scope set-captions target-length set-min set-max'],['本期旁白选择','voice-selection voice-mode'],['导入旁白','narration voice-reference reference-text consent'],['试听当前','audition saved-voice use-voice voice-label enroll-voice'],['本期配乐选择','music-selection music-mode bgm'],['场景模板落点','project-scene-sound'],['确认分镜','confirm-plan share-text share-frames auto-review final-review'],['附两种封面','pack pub-title pub-emphasis pub-body pub-tags'],['启用第三方','cloud budget music-prompt music-length compose-music'],['核对回执','reconcile charged not-charged'],['采用我的','keep-draft use-current'],['保存工程设置','settings-save']],
 deliver:[['播放器','player'],['播放问题','review-issue fix-issue'],['MP4／','reveal:video reveal:subtitle reveal:project'],['3:4','reveal']],
 tools:[['本机与账号','environment install'],['连接 Codex','login'],['ElevenLabs','cloud-key'],['断开本次','cloud-disconnect'],['历史素材','legacy-editor migrate legacy'],['使用帮助','dismiss']],
 blind:[['新建盲评','new title kind'],['候选 A','add source comparison expected group primary-source condition'],['冻结候选','create reviewer begin'],['看片判断','decision observation dimension'],['问题起点','from to mark-from mark-to']]
};
export function guideControl(el,topic,topics){
 if(el.closest('#clip-automation'))topic='advanced';
 const d=el.dataset,action=d.act,raw=el.labels?.[0]?.childNodes;
 const labelText=raw?[...raw].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(' '):'';
 const caption=el.matches('button,a,summary')?el.textContent.trim().slice(0,65):'';
 const label=el.getAttribute('aria-label')||labelText||caption||el.title||el.getAttribute('placeholder')||el.id;
 const key=d.ae||d.aeValue||d.tl||action||el.id||(d.trackOp?'track:'+d.trackOp:d.clip?'clip':el.classList.contains('tl-time')?'tl-time':el.classList.contains('tl-ruler')?'tl-ruler':d.dimension?'dimension':d.condition?'condition':el.className);
 const specific=action==='reveal'?'reveal:'+String(d.id).split('|').at(-1):action==='mode'?'mode:'+d.id:key;
 if(el.hasAttribute('data-guide'))return {label,description:'打开本页对应的图文说明，完成后返回现在的工作位置。'};
 if(el.closest('#projects')&&el.tagName==='BUTTON')return {label,description:'打开这个本机工程，继续查看时间线、素材和交付记录。'};
 if(el.tagName==='A'&&el.getAttribute('href')==='/')return {label,description:'回到剪辑工作台。'};
 if(el.tagName==='A'&&el.target==='_blank')return {label,description:'打开此项目记录的来源页面。'};
 if(el.id==='dismiss')return {label,description:'关闭当前窗口，回到之前的操作位置。'};
 if(action==='tab')return {label,description:'切换到「'+label+'」查看本工程对应的内容。'};
 if(topic==='advanced'&&(d.ae||d.aeValue)){
  const mode=el.closest('.advanced-inspector')?.querySelector('button[aria-pressed=true][data-ae^="mode-"]')?.dataset.ae;
  const prefix=['add','delete','clear'].includes(key)||['x','y','frame'].includes(key)?({ 'mode-mask':'水平中心／','mode-focus':'镜头取景','mode-graphic':'图层关键帧','mode-curve':'在播放头加锚点'})[mode]:null;
  const row=prefix&&topics.get('advanced').groups.flatMap(([,items])=>items).find(([name])=>name.startsWith(prefix));if(row)return {label,description:row[1]};
 }
 if(el.tagName==='SUMMARY')return {label,description:'展开或收起「'+label+'」中的设置与说明。'};
 if(el.tagName==='A'&&el.getAttribute('href')==='/blind')return {label,description:'进入独立审片室，冻结样本并按正常速度观看、记录判断。'};
 const order=[topic,...Object.keys(entries).filter(id=>id!==topic)];
 for(const id of order){
  const rows=topics.get(id)?.groups.flatMap(([,items])=>items)||[];
  for(const [prefix,keys] of entries[id]||[]){
   const candidates=keys.split(' ');if(!candidates.some(k=>k===specific||k===key||k.endsWith('*')&&String(key).startsWith(k.slice(0,-1))))continue;
   const row=rows.find(([name])=>name.startsWith(prefix));if(row)return {label,description:row[1],topic:id,match:row[0]};
  }
 }
 const rows=topics.get(topic)?.groups.flatMap(([,items])=>items)||[];
 const normalized=label.replace(/[（(].*/,'');
 const row=rows.find(([name])=>normalized&&name.split('／').some(part=>normalized.includes(part)||part.includes(normalized)));
 if(row)return {label,description:row[1],topic,match:row[0]};
 if(el.matches('audio,video'))return {label:'播放器',description:'播放、暂停或移动到想核对的时间位置。'};
 if(el.tagName==='BUTTON'&&el.form?.id==='ballot')return {label,description:'提交当前样本的看片判断和观察依据。'};
 if(topic==='blind'&&label==='打开')return {label,description:'打开已冻结的这项研究，选择审片人继续。'};
 if(topic==='blind'&&label==='移除')return {label,description:'从正在准备的研究中移除这一条样本。'};
 return {label,description:el.getAttribute('title')||''};
}
