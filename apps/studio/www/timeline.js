// Project frames are the only timeline unit. Pixel geometry is local to the current gesture.
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const escape=s=>String(s??'').replace(/[&<>"']/g,k=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[k]));
const names={video:'画面',narration:'旁白',music:'音乐',caption:'字幕',graphic:'动效'};
const symbols={video:'▣',narration:'◖',music:'♫',caption:'T',graphic:'◇'};
const rail=98;
export function timecode(frame,fps) {
  const seconds=Math.floor(frame/fps),pad=v=>String(v).padStart(2,'0');
  return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60,frame%fps].map(pad).join(':');
}
export function parseTimecode(text,fps) {
  const value=text.trim();
  if(/^\d+$/.test(value))return Number(value);
  const m=/^(\d+):(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if(!m||Number(m[2])>=60||Number(m[3])>=60||Number(m[4])>=fps)return null;
  return ((Number(m[1])*60+Number(m[2]))*60+Number(m[3]))*fps+Number(m[4]);
}
export function snapPosition(position, offsets, targets, threshold, min, max, held=null) {
  if(held?.guide!=null&&targets.includes(held.guide)&&held.value>=min&&held.value<=max&&Math.abs(position-held.value)<=threshold*1.4)return held;
  let value=clamp(Math.round(position),min,max),guide=null,distance=Infinity;
  for(const offset of offsets)for(const target of targets){
    const next=target-offset,delta=Math.abs(next-position);
    if(next>=min&&next<=max&&delta<=threshold&&delta<distance){value=next;guide=target;distance=delta;}
  }
  return {value,guide};
}
export function trackRows(clips) {
  const ends=[],rows=new Map();
  for(const clip of [...clips].sort((a,b)=>a.start-b.start||b.duration-a.duration)){
    let lane=ends.findIndex(end=>end<=clip.start);
    if(lane<0)lane=ends.length;
    ends[lane]=clip.start+clip.duration;rows.set(clip.id,lane);
  }
  return {rows,count:Math.max(1,ends.length)};
}
const control=(id,name,sign,extra='')=>'<button type="button" data-tl="'+id+'" title="'+name+'" aria-label="'+name+'" '+extra+'>'+sign+'</button>';
export function timelineView({root,p,view,title,seek,select,commit,action,player,report,history}) {
  const fps=p.profile.fps,clips=p.timeline.clips,byId=new Map(clips.map(c=>[c.id,c])),assets=new Map(p.assets.map(a=>[a.id,a]));
  const end=clips.filter(c=>!c.hidden&&c.enabled!==false).reduce((n,c)=>Math.max(n,c.start+c.duration),0);
  // Keep hidden clips selectable even when the playable picture ends earlier.
  const extent=clips.reduce((n,c)=>Math.max(n,c.start+c.duration),Math.max(end,fps*4));
  const total=Math.min(86400*fps,extent+Math.max(fps,Math.ceil(extent*.04)));
  let scale=1,gesture=null,raf=0,selected=view.selected,dead=false,playing=false;
  const events=new AbortController(), listen=(node,type,fn,options={})=>node.addEventListener(type,fn,{...options,signal:events.signal});
  const guard=fn=>(...args)=>Promise.resolve().then(()=>fn(...args)).catch(report);
  root.innerHTML='<div class="timeline-header"><div class="tl-heading"><h2>时间线</h2><small>v'+p.revision+'</small></div><div class="tl-transport">'+
    control('step-back','上一帧（←）','❮')+control('play','播放 / 暂停（空格）','▶')+control('step-next','下一帧（→）','❯')+
    '<input class="tl-time" aria-label="定位到时间码或帧号" title="输入帧号或 时:分:秒:帧，回车定位" spellcheck="false"><span class="tl-duration"> / '+timecode(end,fps)+'</span></div></div>'+
    '<div class="tl-tools"><div>'+control('undo','撤销（⌘Z）','↶','disabled')+control('redo','重做（⇧⌘Z）','↷','disabled')+'<i></i>'+
    control('split','在播放头处分割（S）','分割')+control('remove','删除所选片段','删除')+control('ripple','同轨波纹删除（⇧删除）','波纹删除')+
    control('copy','复制片段（⌘C）','复制')+control('paste','粘贴到播放头（⌘V）','粘贴')+'</div><div>'+
    control('snap','吸附片段边缘与播放头（N，按住 Option 暂停吸附）','吸附','aria-pressed="'+view.snap+'"')+'<i></i>'+
    control('out','缩小','−')+control('fit','缩放至全片','全片')+control('in','放大','＋')+'</div></div>'+
    '<div class="tl-scroll" tabindex="0" aria-label="剪辑时间线"><div class="tl-sheet"><div class="tl-row tl-scale"><span class="tl-label">时间码</span><div class="tl-ruler" tabindex="0" role="slider" aria-label="播放头" aria-valuemin="0" aria-valuemax="'+Math.max(0,end-1)+'"></div></div>'+
    Object.entries(names).map(([track,name])=>{
      const list=clips.filter(c=>c.track===track),layout=trackRows(list),height=track==='video'?43:track==='narration'||track==='music'?32:25;
      const audio=['music','narration'].includes(track),muted=list.length&&list.every(c=>audio?c.muted:c.hidden),locked=list.length&&list.every(c=>c.locked);
      const trackButton=(op,label,active,glyph)=>'<button type="button" data-track-op="'+op+'" data-id="'+track+'" aria-label="'+name+' · '+label+'" title="'+label+'" aria-pressed="'+Boolean(active)+'" '+(!list.length?'disabled':'')+'>'+glyph+'</button>';
      return '<div class="tl-row kind-'+track+'"><span class="tl-label"><b aria-hidden="true">'+symbols[track]+'</b>'+name+'<span class="tl-track-actions">'+trackButton('toggle',audio?'静音':'隐藏',muted,audio?'M':'◉')+trackButton('lock','锁定轨内片段',locked,'L')+'</span></span><div class="tl-lane" data-track="'+track+'" style="height:'+(4+height*layout.count)+'px">'+
        list.map(c=>'<button type="button" class="tl-clip '+(c.locked?'lock ':'')+(c.muted||c.hidden||c.enabled===false?'quiet ':'')+'" '+(c.motion?'data-component ':'')+'data-clip="'+escape(c.id)+'" title="'+escape(title(c))+'" style="top:'+(2+layout.rows.get(c.id)*height)+'px;height:'+(height-3)+'px">'+
        '<span class="tl-art"></span><span class="tl-caption">'+(c.locked?'▣ ':'')+escape(title(c))+'</span><span class="tl-handle left" data-edge="start" title="修剪入点"></span><span class="tl-handle right" data-edge="end" title="修剪出点"></span></button>').join('')+'</div></div>';
    }).join('')+'<div class="tl-cursor" aria-hidden="true"><i></i></div><div class="tl-guide" hidden></div></div></div>';
  const scroll=root.querySelector('.tl-scroll'),sheet=root.querySelector('.tl-sheet'),ruler=root.querySelector('.tl-ruler'),cursor=root.querySelector('.tl-cursor'),guide=root.querySelector('.tl-guide');
  const nodes=[...root.querySelectorAll('[data-clip]')],buttons=Object.fromEntries([...root.querySelectorAll('[data-tl]')].map(b=>[b.dataset.tl,b]));
  const time=root.querySelector('.tl-time');
  function controls() {
    const c=byId.get(selected);
    buttons.split.disabled=!c||c.locked||!!c.motion||view.frame<=c.start||view.frame>=c.start+c.duration;
    buttons.remove.disabled=buttons.ripple.disabled=!c||c.locked;
    buttons.copy.disabled=!c;buttons.paste.disabled=!view.clipboard;
    buttons.play.disabled=!end;buttons['step-back'].disabled=!end||view.frame<=0;buttons['step-next'].disabled=!end||view.frame>=end-1;
  }
  function frame(n,follow=false) {
    view.frame=clamp(Math.round(n)||0,0,Math.max(0,end-1));
    const x=view.frame*scale;
    cursor.style.transform='translateX('+x+'px)';if(document.activeElement!==time)time.value=timecode(view.frame,fps);
    ruler.setAttribute('aria-valuenow',view.frame);ruler.setAttribute('aria-valuetext',timecode(view.frame,fps));
    if(follow&&playing&&!gesture&&(x<scroll.scrollLeft||x>scroll.scrollLeft+scroll.clientWidth-rail-12)) scroll.scrollLeft=Math.max(0,x-40);
    controls();
  }
  listen(time,'focus',()=>{player()?.pause();time.select();});
  listen(time,'blur',()=>{time.value=timecode(view.frame,fps);});
  listen(time,'keydown',e=>{
    if(e.key==='Escape'){time.blur();return;}
    if(e.key!=='Enter')return;
    e.preventDefault();const n=parseTimecode(time.value,fps);
    if(n===null||!Number.isSafeInteger(n)||n<0||n>=Math.max(1,end)){report(Error('请输入片内帧号或有效的 时:分:秒:帧。'));return;}
    time.blur();scroll.focus({preventScroll:true});seek(n,false);frame(n);
    const x=n*scale;if(x<scroll.scrollLeft||x>scroll.scrollLeft+scroll.clientWidth-rail)scroll.scrollLeft=Math.max(0,x-32);
  });
  function choose(id) {
    selected=view.selected=id;
    for(const n of nodes){const active=n.dataset.clip===id;n.classList.toggle('focus',active);n.setAttribute('aria-pressed',active);}
    controls();
  }
  function artwork(n,c,width) {
    const asset=assets.get(c.assetId),box=n.firstElementChild;if(!asset)return;
    const endpoint='/api/projects/'+encodeURIComponent(p.id)+'/assets/'+encodeURIComponent(asset.id);
    if(c.track==='video'){
      const count=Math.max(1,Math.min(10,Math.ceil(width/66)));
      if(box.childElementCount===count)return;
      box.replaceChildren();
      for(let i=0;i<count;i++){
        const img=document.createElement('img');
        const ms=Math.round(((c.sourceIn||0)+(i+.5)/count*c.duration*(c.speed||1))/fps*1000);
        img.loading='lazy';img.draggable=false;img.alt='';img.src=endpoint+'/thumb?ms='+(asset.kind==='image'?0:ms);box.append(img);
      }
    }else if(asset.hasAudio&&['music','narration'].includes(c.track)){
      if(box.firstChild)return;
      const pic=document.createElement('img'),sourceLength=asset.duration*fps,window=c.duration*(c.speed||1);
      pic.alt='';pic.loading='lazy';pic.draggable=false;pic.className='tl-wave';pic.src=endpoint+'/waveform';
      pic.style.width=100*sourceLength/window+'%';pic.style.left=-100*(c.sourceIn||0)/window+'%';box.append(pic);
    }
  }
  function geometry(n,start,duration) {
    n.style.left=start*scale+'px';n.style.width=Math.max(2,duration*scale)+'px';
    n.classList.toggle('tl-tiny',duration*scale<24);
  }
  function ticks(){
    const steps=[1,2,5,10,...[1,2,5,10,15,30,60,120,300,600,1800,3600].map(v=>v*fps)].sort((a,b)=>a-b);
    const step=steps.find(v=>v*scale>=70)||3600*fps;
    ruler.replaceChildren();
    // Only visible ticks need DOM nodes, even when an hour-long edit is zoomed to frames.
    const first=Math.max(0,Math.floor(scroll.scrollLeft/(step*scale))-1)*step;
    const last=Math.min(total,first+Math.ceil((scroll.clientWidth+step*scale*3)/scale));
    for(let n=first;n<=last;n+=step){
      const t=document.createElement('span'); t.style.left=n*scale+'px';
      t.textContent=step<fps?timecode(n,fps).slice(3):timecode(n,fps).slice(n>=3600*fps?0:3,8);
      ruler.append(t);
    }
    ruler.style.setProperty('--tick',(step*scale/5)+'px');sheet.style.setProperty('--grid',step*scale+'px');
  }
  function layout(){
    if(dead||!scroll.clientWidth)return;
    scale=Math.max(1,scroll.clientWidth-rail-2)/total*view.zoom;
    sheet.style.width=(rail+total*scale)+'px';ticks();
    for(const n of nodes){const c=byId.get(n.dataset.clip);geometry(n,c.start,c.duration);artwork(n,c,c.duration*scale);}
    frame(view.frame);
  }
  function zoom(value){
    const anchor=view.frame*scale-scroll.scrollLeft;
    view.zoom=clamp(value,1,Math.max(16,Math.min(65536,total*18/Math.max(1,scroll.clientWidth-rail))));
    layout();scroll.scrollLeft=view.zoom===1?0:view.frame*scale-clamp(anchor,0,scroll.clientWidth-rail);
  }
  function coordinate(x){return Math.round((x-scroll.getBoundingClientRect().left-rail+scroll.scrollLeft)/scale);}
  function scrub(x,live){const n=clamp(coordinate(x),0,Math.max(0,end-1));frame(n);seek(n,live);}
  function begin(e){
    if(gesture)return;
    if(e.button===1){
      e.preventDefault();gesture={pan:true,pointer:e.pointerId,x:e.clientX,initialScroll:scroll.scrollLeft};
      try{scroll.setPointerCapture(e.pointerId);}catch{}return;
    }
    if(e.button!==0)return;
    const n=e.target.closest('[data-clip]'),head=e.target.closest('.tl-ruler,.tl-cursor,.tl-lane');
    if(!n&&!head)return;
    e.preventDefault();scroll.focus({preventScroll:true});
    const c=n&&byId.get(n.dataset.clip),edge=!c?.motion&&e.target.dataset.edge;
    gesture={pointer:e.pointerId,node:n,c,edge,x:e.clientX,lastX:e.clientX,initialScroll:scroll.scrollLeft,changed:false,alt:e.altKey};
    try{scroll.setPointerCapture(e.pointerId);}catch{/* Synthetic input has no native capture. */}
    if(!c){player()?.pause();scrub(e.clientX,true);return;}
    choose(c.id);select(c.id,false);
    gesture.targets=[...new Set([0,view.frame,...clips.filter(k=>k.id!==c.id).flatMap(k=>[k.start,k.start+k.duration])])];
    gesture.result=null;
  }
  function drag(){
    raf=0;const g=gesture;if(!g||!g.changed)return;
    const bounds=scroll.getBoundingClientRect();
    const over=g.lastX<bounds.left+rail?g.lastX-bounds.left-rail:g.lastX>bounds.right-18?g.lastX-bounds.right+18:0;
    if(over)scroll.scrollLeft+=clamp(over,-24,24);
    if(!g.c)scrub(g.lastX,true);
    else if(!g.c.locked){
      const c=g.c,stop=c.start+c.duration,asset=assets.get(c.assetId),speed=c.speed||1;
      const delta=(g.lastX-g.x+scroll.scrollLeft-g.initialScroll)/scale;
      let origin=c.start,min=0,max=86400*fps-c.duration,offsets=[0,c.duration];
      if(g.edge){
        offsets=[0];const media=asset&&asset.kind!=='image';
        if(g.edge==='start'){min=media?Math.max(0,c.start-Math.floor((c.sourceIn||0)/speed)):0;max=stop-1;}
        else{origin=stop;min=c.start+1;max=media?c.start+Math.floor((Math.ceil(asset.duration*fps)-(c.sourceIn||0))/speed):86400*fps;}
      }
      const result=snapPosition(origin+delta,offsets,view.snap&&!g.alt?g.targets:[],8/scale,min,max,g.snap);g.snap=result;g.result=result.value;
      const start=g.edge==='end'?c.start:result.value,duration=g.edge==='end'?result.value-c.start:g.edge==='start'?stop-start:c.duration;
      geometry(g.node,start,duration);g.node.classList.add('dragging');
      guide.hidden=result.guide===null;if(!guide.hidden)guide.style.transform='translateX('+result.guide*scale+'px)';
    }
    if(over&&scroll.scrollWidth>scroll.clientWidth)raf=requestAnimationFrame(drag);
  }
  function move(e){
    if(!gesture||e.pointerId!==gesture.pointer)return;
    if(gesture.pan){scroll.scrollLeft=gesture.initialScroll+gesture.x-e.clientX;return;}
    gesture.lastX=e.clientX;gesture.alt=e.altKey;
    if(Math.abs(e.clientX-gesture.x)>=3)gesture.changed=true;
    if(gesture.changed&&!raf)raf=requestAnimationFrame(drag);
  }
  function finish(e,cancel=false){
    const g=gesture;if(!g||e.pointerId!==g.pointer)return;
    if(g.pan){gesture=null;return;}
    if(raf)cancelAnimationFrame(raf);raf=0;
    if(!cancel){g.lastX=e.clientX;if(Math.abs(e.clientX-g.x)>=3)g.changed=true;drag();}
    if(raf)cancelAnimationFrame(raf);raf=0;gesture=null;guide.hidden=true;
    if(!g.c){if(!cancel)scrub(e.clientX,false);return;}
    g.node.classList.remove('dragging');
    if(cancel||g.c.locked||!g.changed||g.result===null){
      geometry(g.node,g.c.start,g.c.duration);
      if(!cancel&&!g.changed)seek(clamp(coordinate(e.clientX),g.c.start,g.c.start+g.c.duration-1),false);
      return;
    }
    const original=g.edge==='end'?g.c.start+g.c.duration:g.c.start;
    if(g.result===original)return;
    const command=g.edge?{op:'trim',id:g.c.id,edge:g.edge,atFrame:g.result}:{op:'move',id:g.c.id,start:g.result};
    Promise.resolve(commit([command],p.revision)).catch(error=>{if(!dead)geometry(g.node,g.c.start,g.c.duration);report(error);});
  }
  function command(id){
    if(buttons[id]?.disabled)return;
    if(id==='snap'){view.snap=!view.snap;buttons.snap.setAttribute('aria-pressed',view.snap);return;}
    if(id==='fit'||id==='out'||id==='in')return zoom(id==='fit'?1:view.zoom*(id==='in'?2:.5));
    if(id==='play')return player()?.toggle();
    if(id==='step-back'||id==='step-next')return seek(clamp(view.frame+(id==='step-back'?-1:1),0,Math.max(0,end-1)),false);
    if(id==='copy'){view.clipboard=structuredClone(byId.get(selected));controls();return;}
    if(id==='paste'){
      const c={...structuredClone(view.clipboard),id:crypto.randomUUID(),start:view.frame,locked:false};delete c.stackOrigin;delete c.soundBinding;
      return action('paste',c);
    }
    return action(id,selected);
  }
  listen(scroll,'pointerdown',begin);listen(scroll,'pointermove',move);listen(scroll,'pointerup',e=>finish(e));
  listen(scroll,'pointercancel',e=>finish(e,true));listen(scroll,'lostpointercapture',e=>{if(gesture)finish(e,true);});
  listen(scroll,'scroll',()=>{view.scroll=scroll.scrollLeft;ticks();},{passive:true});
  listen(root,'click',guard(e=>{const b=e.target.closest('[data-tl]');if(b)return command(b.dataset.tl);
    const t=e.target.closest('[data-track-op]');if(!t)return;
    const items=clips.filter(c=>c.track===t.dataset.id),key=['narration','music'].includes(t.dataset.id)?'muted':'hidden';
    const lock=t.dataset.trackOp==='lock',value=!items.every(c=>lock?c.locked:c[key]);
    const commands=items.filter(c=>Boolean(lock?c.locked:c[key])!==value).map(c=>lock?{op:'lock',id:c.id,locked:value}:{op:'update',id:c.id,changes:{[key]:value}});
    if(commands.length)return commit(commands,p.revision);}));
  listen(document,'keydown',e=>{
    if(e.defaultPrevented||e.isComposing||document.querySelector('dialog[open]')||e.target.closest('input,textarea,select,[contenteditable="true"]'))return;
    if(e.target.closest('button,a')&&e.key===' '&&!e.target.closest('[data-clip],.tl-scroll'))return;
    if(e.key==='Enter'&&e.target.dataset.clip){e.preventDefault();choose(e.target.dataset.clip);select(selected,true);return;}
    const cmd=e.metaKey||e.ctrlKey,key=e.key.toLowerCase();
    const id=cmd?({z:e.shiftKey?'redo':'undo',y:'redo',c:'copy',v:'paste'}[key]):({' ':'play',arrowleft:'step-back',arrowright:'step-next',s:'split',n:'snap',delete:e.shiftKey?'ripple':'remove',backspace:e.shiftKey?'ripple':'remove','+':'in','=':'in','-':'out'}[key]);
    if(id){if(cmd&&['c','v'].includes(key)&&(!selected&&!view.clipboard||String(window.getSelection())))return;e.preventDefault();guard(command)(id);}
    else if(!cmd&&['home','end'].includes(key)){e.preventDefault();seek(key==='home'?0:Math.max(0,end-1),false);}
  });
  listen(root,'click',e=>{const n=e.target.closest('[data-clip]');if(n&&e.detail===0){choose(n.dataset.clip);select(n.dataset.clip,true);}});
  const resize=new ResizeObserver(()=>{if(!gesture)layout();});resize.observe(scroll);
  layout();scroll.scrollLeft=view.scroll||0;choose(selected);
  history().then(h=>{if(!dead&&h.revision===p.revision){buttons.undo.disabled=!h.canUndo;buttons.redo.disabled=!h.canRedo;}}).catch(report);
  return {frame,choose,setPlaying(active){playing=active;buttons.play.textContent=active?'Ⅱ':'▶';},
    destroy(){dead=true;resize.disconnect();events.abort();cancelAnimationFrame(raf);},
    get dragging(){return !!gesture;}};
}
