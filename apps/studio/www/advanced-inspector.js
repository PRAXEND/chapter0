import {contentStage} from './motion-clock.js';
import {defaultMask,validateMask,focusKeys,framingFor,blendKeys,graphicKeys,sourceAt,timeKeys,validateTimeMap,setTimeMap} from './clip-automation.js';

const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const short=n=>Number(n.toFixed(3));
const drafts=new Map();
const initial=(clip,graphic)=>({mask:clip.mask?{...clip.mask}:null,focus:focusKeys(clip),graphic:graphic?graphicKeys(clip):[],
  curve:timeKeys(clip),flat:!clip.timeMap,graphicOff:!clip.keyframes?.length,focusOff:!clip.framing,dirty:{},open:false,selected:{focus:0,graphic:0,curve:0}});
const labels={mask:'画面蒙版',focus:'镜头取景关键帧',graphic:'图层关键帧',curve:'时间曲线'};
const properties={x:['水平中心',0,1,.005],y:['垂直中心',0,1,.005],width:['蒙版宽度',.005,2,.01],height:['蒙版高度',.005,2,.01],
  feather:['羽化',0,.5,.005],zoom:['取景倍率',1,4,.05],scale:['缩放',.01,10,.05],opacity:['透明度',0,1,.02],rotation:['顺时针角度',-36000,36000,1]};
const button=(action,label,extra='')=>'<button type="button" data-ae="'+action+'" '+extra+'>'+label+'</button>';
const input=(id,name,value,min,max,step)=>'<label>'+name+'<input data-ae-value="'+id+'" type="number" min="'+min+'" max="'+max+'" step="'+step+'" value="'+short(value)+'"></label>';
const pointsAttr=(points,x,y)=>points.map(p=>short(x(p)*1000)+','+short(y(p)*1000)).join(' ');
const srcUrl=(p,c,ms)=>'/api/projects/'+encodeURIComponent(p.id)+'/assets/'+encodeURIComponent(c.assetId)+'/thumb?ms='+ms;
function graphicBounds(p,c){return c.track==='caption'&&c.portraitPlacement==='free'?p.profile:contentStage(p.profile,p.style);}
function pointOn(svg,event){const r=svg.getBoundingClientRect();return {x:clamp((event.clientX-r.left)/r.width,0,1),y:clamp((event.clientY-r.top)/r.height,0,1)};}
function projectImage(asset,ratio,focus,cover){
  const aspect=asset.width*(asset.pixelAspect||1)/asset.height;
  if(!focus&&!cover){const w=Math.min(1,aspect/ratio),h=Math.min(1,ratio/aspect);return {x:(1-w)/2,y:(1-h)/2,w,h};}
  const p=focus||{x:.5,y:.5,zoom:1},w=Math.min(1,ratio/aspect)/p.zoom,h=Math.min(1,aspect/ratio)/p.zoom;
  return {x:-clamp(p.x-w/2,0,1-w)/w,y:-clamp(p.y-h/2,0,1-h)/h,w:1/w,h:1/h};
}
function limitAnchor(points,i,frame,source){
  const a=points[i-1],b=points[i+1];if(!a||!b)return points[i];
  const f=clamp(Math.round(frame),a.frame+1,b.frame-1);
  const low=Math.max(a.sourceFrame+(f-a.frame)*.125,b.sourceFrame-(b.frame-f)*8);
  const high=Math.min(a.sourceFrame+(f-a.frame)*8,b.sourceFrame-(b.frame-f)*.125);
  return {frame:f,sourceFrame:clamp(source,low,high)};
}
const noop={setFrame(){},dispose(){}};
export function mountClipInspector({element,project,clip,frame=0,commit,seek,getFrameSurface}){
  if(!element)return noop;
  const asset=project?.assets?.find(a=>a.id===clip?.assetId),video=clip?.track==='video'&&asset,graphic=clip&&!clip.motion&&['caption','graphic'].includes(clip.track);
  if(!video&&!graphic){element.replaceChildren();return noop;}
  const sidecar=clip.track==='caption'&&project.settings?.captionDisplay==='sidecar';
  if(sidecar){element.replaceChildren();return noop;}
  const modes=video?['mask','focus',...(asset.kind==='video'?['curve']:[])]:['graphic'];
  const identity=JSON.stringify([project.id,clip.id]),signature=JSON.stringify([clip.assetId,clip.duration,clip.sourceIn,clip.speed,clip.timeMap,
    clip.framing,clip.mask,clip.keyframes,clip.geometry,clip.portraitPlacement,project.profile,project.style]);
  const saved=drafts.get(identity);
  let state=saved?.state??initial(clip,graphic),conflict=Boolean(saved&&saved.signature!==signature&&Object.keys(state.dirty).length);
  if(saved&&saved.signature!==signature&&!conflict)state=initial(clip,graphic);
  state.mode=modes.includes(state.mode)?state.mode:modes[0];
  let graphicStill;
  let local=clamp(Math.round(frame-clip.start),0,clip.duration-1),drag=null,timer=0,removed=false,pending=false,message='';
  const host=document.createElement('details');host.className='advanced-inspector';host.open=state.open;
  host.innerHTML='<summary>高级剪辑</summary><div class="ae-body"></div>';
  element.replaceChildren(host);
  const body=host.lastElementChild,stage=contentStage(project.profile,project.style);
  const pane=clip.viewport??{width:1,height:1},paneRatio=stage.width*pane.width/(stage.height*pane.height);
  const portraitCaption=clip.track==='caption'&&stage.height!==project.profile.height;
  const readOnly=()=>clip.locked||conflict||pending;
  const remember=()=>{drafts.delete(identity);drafts.set(identity,{signature:conflict?saved.signature:signature,state});if(drafts.size>32)drafts.delete(drafts.keys().next().value);};
  const mark=()=>{if(state.mode==='graphic')state.graphicOff=false;state.dirty[state.mode]=true;message='有尚未应用的修改';remember();};
  const select=(index,jump=false)=>{state.selected[state.mode]=index;if(jump)seek?.(clip.start+Math.min(clip.duration-1,state[state.mode][index].frame));};
  function data(){return state[state.mode];}
  function thumb(){
    const ms=asset?.kind==='video'?Math.max(0,Math.round(sourceAt(clip,local)*1000/project.profile.fps)):0;
    return asset&&srcUrl(project,clip,ms);
  }
  function controls(){
    const m=state.mode,items=data(),i=state.selected[m]??0,p=m==='mask'?state.mask:items[i];
    const bar=modes.map(k=>button('mode-'+k,labels[k],'aria-pressed="'+(m===k)+'"')).join('');
    let fields='',actions='',markers='',caption='';
    if(m==='mask'){
      actions=button('rectangle','矩形')+button('ellipse','椭圆')+button('clear','移除蒙版');
      if(p){fields=['x','y','width','height','feather'].map(k=>input(k,properties[k][0],p[k]??0,...properties[k].slice(1))).join('')+
        '<label class="ae-check"><input data-ae-value="invert" type="checkbox" '+(p.invert?'checked':'')+'>反选区域</label>';}
      caption=p?'拖动轮廓中心移动，拖动右下角调整尺寸。':'选择形状后，上层画面仅在蒙版内可见。';
    }else{
      const end=m==='focus'?clip.duration-1:clip.duration;
      markers=items.map((k,j)=>button('key-'+j,'第 '+k.frame+' 帧','aria-pressed="'+(i===j)+'"')).join('');
      if(m==='curve'){
        actions=button('add','在播放头加锚点')+button('delete','移除锚点')+button('slow','先慢后快')+button('fast','先快后慢')+button('clear','恢复恒速');
        const last=items.at(-1),a=items[i-1],b=items[i+1];
        if(a&&b)fields=input('frame','片段帧',p.frame,a.frame+1,b.frame-1,1)+input('sourceFrame','原片距离（帧）',p.sourceFrame,a.sourceFrame,b.sourceFrame,.01);
        caption='横轴为片段时间，纵轴为从入点起经过的原片帧。'+items.slice(1).map((k,j)=>short((k.sourceFrame-items[j].sourceFrame)/(k.frame-items[j].frame))+'×').join(' → ')+
          '。首尾锁定在 '+short(last.sourceFrame)+' 原片帧。';
      }else{
        actions=button('add','在播放头加关键帧')+button('delete','移除关键帧')+button('clear',m==='focus'?'恢复默认取景':'清除动画');
        if(i>0&&i<items.length-1)fields=input('frame','片段帧',p.frame,items[i-1].frame+1,items[i+1].frame-1,1);
        const keys=m==='focus'?['x','y','zoom']:['x','y','scale','opacity','rotation'];
        fields+=keys.map(k=>input(k,properties[k][0],p[k],...properties[k].slice(1))).join('');
        caption=m==='focus'?'原片上拖动焦点，取景框显示该关键帧的裁切范围。':'拖动位置点调整图层中心。相邻关键帧间线性插值。';
      }
      if(end<1)actions=button('clear','重设');
    }
    return '<nav aria-label="专用剪辑工具">'+bar+'</nav><fieldset '+(readOnly()?'disabled':'')+'><div class="ae-actions">'+actions+'</div>'+
      '<div class="ae-board"></div><div class="ae-keys">'+markers+'</div><div class="ae-fields">'+fields+'</div></fieldset>'+
      '<p class="ae-caption">'+caption+'</p><div class="ae-footer"><span data-ae-clock></span>'+
      button('discard',conflict?'载入当前版本':'撤销未应用修改')+button('apply','应用到时间线',readOnly()||!Object.keys(state.dirty).length?'disabled':'')+'</div>'+
      '<output aria-live="polite"></output>';
  }
  function composedBackdrop(){
    const at=clip.start+local;if(graphicStill?.at===at)return graphicStill.url;
    const source=getFrameSurface?.(at);if(!source)return '';
    const w=source.videoWidth||source.naturalWidth,h=source.videoHeight||source.naturalHeight;if(!w||!h)return '';
    const area=portraitCaption?project.profile:graphicBounds(project,clip),crop=h*area.height/project.profile.height;
    const canvas=document.createElement('canvas');canvas.width=Math.min(480,w);canvas.height=Math.max(1,Math.round(canvas.width*area.height/area.width));
    canvas.getContext('2d').drawImage(source,0,(h-crop)/2,w,crop,0,0,canvas.width,canvas.height);
    const url=canvas.toDataURL('image/jpeg',.8);graphicStill={at,url};return url;
  }
  function renderBoard(preserve=false){
    const m=state.mode,rows=data(),p=m==='mask'?state.mask:rows[state.selected[m]??0],el=body.querySelector('.ae-board');if(!el)return;
    let ratio=1.8,content='';
    const line=(coords)=>'<polyline class="ae-path" points="'+coords+'"/>';
    const dot=(x,y,j,on)=>'<circle class="ae-point '+(on?'on':'')+'" data-point="'+j+'" cx="'+short(x*1000)+'" cy="'+short(y*1000)+'" r="16"/>';
    if(m==='curve'){
      const x=k=>k.frame/clip.duration,y=k=>1-k.sourceFrame/rows.at(-1).sourceFrame;
      content='<path class="ae-diagonal" d="M0 1000L1000 0"/>'+line(pointsAttr(rows,x,y))+rows.map((k,j)=>dot(x(k),y(k),j,k===p)).join('');
      content+='<line class="ae-time" x1="'+local/clip.duration*1000+'" x2="'+local/clip.duration*1000+'" y1="0" y2="1000"/>';
    }else{
      if(m==='focus'||m==='mask'){
        ratio=m==='focus'?asset.width*(asset.pixelAspect||1)/asset.height:paneRatio;
        const focus=state.focusOff?null:blendKeys(state.focus,local);
        const r=m==='focus'?{x:0,y:0,w:1,h:1}:projectImage(asset,ratio,focus,clip.fit==='cover');
        content='<image href="'+thumb()+'" x="'+r.x*1000+'" y="'+r.y*1000+'" width="'+r.w*1000+'" height="'+r.h*1000+'" preserveAspectRatio="none"/>';
      }else{const area=portraitCaption?project.profile:graphicBounds(project,clip);ratio=area.width/area.height;const image=composedBackdrop();if(image)content='<image href="'+image+'" width="1000" height="1000" preserveAspectRatio="none"/>';}
      if(m==='mask'&&p){
        const x=(p.x-p.width/2)*1000,y=(p.y-p.height/2)*1000,w=p.width*1000,h=p.height*1000;
        content+=p.shape==='ellipse'?'<ellipse class="ae-outline" cx="'+p.x*1000+'" cy="'+p.y*1000+'" rx="'+w/2+'" ry="'+h/2+'"/>':
          '<rect class="ae-outline" x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'"/>';
        content+=dot(p.x,p.y,'center',true)+dot((x+w)/1000,(y+h)/1000,'scale',false);
      }else if(m!=='mask'){
        if(m==='focus'){
          const aw=asset.width*(asset.pixelAspect||1)/asset.height,w=Math.min(1,paneRatio/aw)/p.zoom,h=Math.min(1,aw/paneRatio)/p.zoom;
          content+='<rect class="ae-outline" x="'+clamp(p.x-w/2,0,1-w)*1000+'" y="'+clamp(p.y-h/2,0,1-h)*1000+'" width="'+w*1000+'" height="'+h*1000+'"/>';
        }
        content+=line(pointsAttr(rows,k=>k.x,k=>k.y))+rows.map((k,j)=>dot(k.x,k.y,j,k===p)).join('');
      }
    }
    let svg=el.firstElementChild;if(!preserve||!svg){el.innerHTML='<svg class="ae-pad" viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img" aria-label="'+labels[m]+'编辑区"></svg>';svg=el.firstElementChild;}
    svg.style.aspectRatio=String(ratio);svg.style.width='min(100%, '+(260*ratio)+'px)';svg.innerHTML=content;
  }
  function draw(){
    body.innerHTML=controls();renderBoard();
    body.querySelector('output').textContent=conflict?'片段已被其他编辑修改。请先载入当前版本。':clip.locked?'片段已锁定。':message;
    body.querySelector('[data-ae-clock]').textContent='播放头 · 片段第 '+local+' 帧';
  }
  function add(frame){
    const m=state.mode,rows=data(),f=clamp(Math.round(frame),0,m==='focus'?clip.duration-1:clip.duration);
    let i=rows.findIndex(p=>p.frame===f);
    if(i<0){const p=blendKeys(rows,f);i=rows.findIndex(k=>k.frame>f);rows.splice(i,0,p);mark();}
    select(i);if(m==='focus')state.focusOff=false;
    if(m==='curve'&&rows.length>2)state.flat=false;
    return i;
  }
  function act(action){
    const m=state.mode;
    if(action.startsWith('mode-')){state.mode=action.slice(5);message='';draw();return;}
    if(action==='discard'){state=initial(clip,graphic);state.mode=m;state.open=true;conflict=false;message='已载入当前片段';remember();draw();return;}
    if(readOnly())return;
    if(action.startsWith('key-')){select(Number(action.slice(4)),true);draw();return;}
    if(action==='apply'){save().catch(error=>{message=error.message;if(!removed)draw();});return;}
    if(action==='add'){add(local);}
    else if(action==='delete'){
      const index=state.selected[m];if(index<=0||index>=data().length-1){message='首尾锚点固定。';draw();return;}
      data().splice(index,1);select(index-1);mark();
    }else if(action==='clear'){
      if(m==='mask')state.mask=null;
      if(m==='focus'){state.focus=focusKeys({...clip,framing:null});state.focusOff=true;}
      if(m==='graphic')state.graphic=graphicKeys({...clip,keyframes:null});
      if(m==='curve'){state.curve=timeKeys({...clip,timeMap:null});state.flat=true;}
      state.selected[m]=0;mark();if(m==='graphic')state.graphicOff=true;
    }else if(action==='ellipse'||action==='rectangle'){state.mask={...defaultMask,...state.mask,shape:action};mark();}
    else if(action==='slow'||action==='fast'){
      if(clip.duration<2){message='片段至少需要两帧才能加入中间锚点。';draw();return;}
      const rows=timeKeys({...clip,timeMap:null}),f=Math.round(clip.duration/2),end=rows.at(-1);
      rows.splice(1,0,{frame:f,sourceFrame:end.sourceFrame*f/clip.duration});
      rows[1]=limitAnchor(rows,1,f,end.sourceFrame*(action==='slow'?.25:.75));
      state.curve=rows;state.flat=false;select(1);mark();
    }
    draw();
  }
  async function save(){
    const changes={},cmds=[],d=state.dirty;
    if(d.mask){validateMask(state.mask);changes.mask=state.mask;}
    if(d.focus)changes.framing=state.focusOff?null:framingFor(state.focus,clip.duration);
    if(d.graphic){changes.keyframes=state.graphicOff?[]:state.graphic;if(portraitCaption)changes.portraitPlacement=state.graphicOff?null:'free';}
    if(Object.keys(changes).length)cmds.push({op:'update',id:clip.id,changes});
    if(d.curve){const points=state.flat?null:state.curve;validateTimeMap({...clip,...setTimeMap(clip,points)},asset,project.profile.fps);cmds.push({op:'time-map',id:clip.id,points});}
    if(!cmds.length)return;
    pending=true;drafts.delete(identity);draw();
    try{await commit(cmds);drafts.delete(identity);state.dirty={};message='已应用到时间线';}
    catch(error){message=error.message;remember();}
    finally{pending=false;if(!removed)draw();}
  }
  function click(e){const action=e.target.closest('[data-ae]')?.dataset.ae;if(action)try{act(action);}catch(error){message=error.message;draw();}}
  function change(e){
    const field=e.target.dataset.aeValue;if(!field||readOnly())return;
    const m=state.mode,rows=data(),i=state.selected[m]??0,p=m==='mask'?state.mask:rows[i];
    const v=e.target.type==='checkbox'?e.target.checked:e.target.valueAsNumber;
    if(typeof v==='number'&&!Number.isFinite(v)){draw();return;}
    if(m==='curve'){rows[i]=limitAnchor(rows,i,field==='frame'?v:p.frame,field==='sourceFrame'?v:p.sourceFrame);state.flat=false;}
    else if(field==='frame'){p.frame=clamp(Math.round(v),rows[i-1].frame+1,rows[i+1].frame-1);}
    else if(field==='invert')p.invert=v;
    else{p[field]=clamp(v,properties[field][1],properties[field][2]);if(m==='focus')state.focusOff=false;}
    mark();draw();
  }
  function pointer(e){
    const svg=e.target.closest('.ae-pad');if(!svg||readOnly()||e.button!==0)return;
    const m=state.mode,loc=pointOn(svg,e),hit=e.target.dataset.point;
    if(m==='mask'&&!state.mask)return;
    if(m==='curve'&&hit===undefined){if(data().length>=64)return;add(loc.x*clip.duration);}
    else if(m!=='mask'&&hit!==undefined)select(Number(hit),true);
    else if(m!=='mask'&&hit===undefined)add(local);
    if(m==='curve'&&(state.selected[m]===0||state.selected[m]===data().length-1)){draw();return;}
    e.preventDefault();svg.setPointerCapture(e.pointerId);
    drag={svg,id:e.pointerId,mode:m,resize:hit==='scale',x:e.clientX,y:e.clientY,moved:false};
    if(hit===undefined)move(e,true);
  }
  function move(e,force=false){
    if(!drag||e.pointerId!==drag.id||(!force&&!drag.moved&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<2))return;
    drag.moved=true;const {x,y}=pointOn(drag.svg,e),m=state.mode,rows=data(),i=state.selected[m]??0;
    if(m==='curve'){rows[i]=limitAnchor(rows,i,x*clip.duration,(1-y)*rows.at(-1).sourceFrame);state.flat=false;}
    else{const p=m==='mask'?state.mask:rows[i];if(drag.resize){p.width=clamp(2*Math.abs(x-p.x),.005,2);p.height=clamp(2*Math.abs(y-p.y),.005,2);}else{p.x=x;p.y=y;}if(m==='focus')state.focusOff=false;}
    mark();renderBoard(true);
  }
  function end(e){if(!drag||e.pointerId!==drag.id)return;drag=null;draw();}
  function setFrame(next){if(!Number.isFinite(next)||removed)return;local=clamp(Math.round(next-clip.start),0,clip.duration-1);
    if(!host.open||drag)return;const clock=body.querySelector('[data-ae-clock]');if(clock)clock.textContent='播放头 · 片段第 '+local+' 帧';
    const line=body.querySelector('.ae-time');if(line){line.setAttribute('x1',1000*local/clip.duration);line.setAttribute('x2',1000*local/clip.duration);}
    clearTimeout(timer);if(state.mode!=='curve')timer=setTimeout(()=>{if(!removed&&!drag)renderBoard(true);},220);
  }
  host.addEventListener('toggle',()=>{state.open=host.open;remember();if(host.open)draw();});
  body.addEventListener('click',click);body.addEventListener('change',change);body.addEventListener('pointerdown',pointer);
  body.addEventListener('pointermove',move);body.addEventListener('pointerup',end);body.addEventListener('pointercancel',end);
  if(host.open)draw();
  return {setFrame,dispose(){removed=true;clearTimeout(timer);if(!pending)remember();host.remove();}};
}
