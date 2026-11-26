// All public positions are integer frames on the project clock, including when a video
// element happens to be playing a six-second local window.
const lengthOf=p=>(p?.timeline?.clips||[]).reduce((n,c)=>c.hidden||c.enabled===false?n:Math.max(n,c.start+c.duration),0);
const aborted=()=>new DOMException('播放请求已取代','AbortError');
const matches=(d,f)=>d&&d.source!=='frame'&&d.fromFrame<=f&&f<d.toFrame;
function waitFor(element,events,ready,signal){
  signal.throwIfAborted();
  if(ready())return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const finish=err=>{clearTimeout(timer);for(const e of events)element.removeEventListener(e,check);element.removeEventListener('error',failed);signal.removeEventListener('abort',cancel);err?reject(err):resolve();};
    const check=()=>{if(ready())finish();},cancel=()=>finish(signal.reason||aborted());
    const failed=()=>finish(Error('这份预览暂时无法解码。'));
    const timer=setTimeout(()=>finish(Error('读取本地预览超时。')),18000);
    for(const e of events)element.addEventListener(e,check);
    element.addEventListener('error',failed,{once:true});signal.addEventListener('abort',cancel,{once:true});
    if(signal.aborted)cancel();else check();
  });
}
const timeFrame=(seconds,fps)=>Math.floor(seconds*fps+0.00005);
export function createTimelinePlayer({project:initial,jobs=[],video,onFrame=()=>{},onState=()=>{},frame:initialFrame=0,request=fetch}){
  const doc=video.ownerDocument,host=video.parentElement,buffer=doc.createElement('video'),still=doc.createElement('img');
  const videos=[video,buffer],saved=videos.map(v=>({controls:v.controls,display:v.style.display,visibility:v.style.visibility}));
  buffer.className=video.className;
  for(const v of videos){v.playsInline=true;v.preload='auto';v.controls=false;}
  still.alt='当前工程帧';still.draggable=false;
  Object.assign(still.style,{width:'100%',height:'100%',objectFit:'contain',display:'none'});
  buffer.style.display='none';host.append(buffer,still);
  let p=null,length=0,position=0,playing=false,status='empty',source=null,error=null,dead=false;
  let epoch=0,task=new AbortController(),front=0,timer=0,tick=null,readyNext=null,ended=false,full=null,jobStamp='';
  let slots=[null,null],known=new Map(),lastSeekAt=0;
  const state=()=>({status,playing,source,error,frame:position,length});
  function notify(next,origin=source,failure=null){status=next;source=origin;error=failure;onState(state());}
  function mark(next){next=Math.min(Math.max(0,next),Math.max(0,length-1));if(position!==next){position=next;onFrame(position);}}
  function present(index){still.style.display='none';videos.forEach((v,i)=>{v.style.display=i===index?'':'none';v.style.visibility=i===index?'visible':'hidden';});}
  function blank(){still.style.display='none';for(const v of videos)v.style.visibility='hidden';}
  function stopTick(){if(tick!==null){videos[front].cancelVideoFrameCallback?.(tick);tick=null;}}
  function invalidate(){
    epoch++;task.abort(aborted());task=new AbortController();clearTimeout(timer);timer=0;
    stopTick();readyNext=null;for(const v of videos)v.pause();
    return epoch;
  }
  const alive=(n)=>!dead&&n===epoch;
  function handle(e,n){if(!alive(n)||e?.name==='AbortError')return;playing=false;blank();notify('error',null,e?.message||'预览读取失败。');}
  async function describe(f,mode,signal){
    if(matches(full,f))return full;
    const cached=[...known.values()].find(d=>matches(d,f)&&(mode==='still'||d.toFrame-f>=Math.min(2*d.fps,length-f)));if(cached)return cached;
    const q=new URLSearchParams({revision:String(p.revision),frame:String(f),mode});
    const result=await request('/api/projects/'+encodeURIComponent(p.id)+'/playback?'+q,{signal,cache:'no-store'});
    const d=await result.json();signal.throwIfAborted();
    if(!result.ok)throw Error(d.error||'读取时间线预览失败。');
    if(d.revision!==p.revision||d.fps!==p.profile.fps||d.length!==length||d.fromFrame>f||f>=d.toFrame)
      throw Error('预览版本或时间码已改变。');
    if(d.source==='cut')full=d;
    else if(d.source==='window'){known.set(d.fromFrame,d);if(known.size>8)known.delete(known.keys().next().value);}
    return d;
  }
  async function loadVideo(index,d,f,paused,signal){
    const v=videos[index],reuse=slots[index]?.url===d.url;
    if(!reuse){
      v.pause();slots[index]=d;v.preload='auto';v.src=d.url;v.load();
    }
    await waitFor(v,['loadedmetadata','durationchange','loadeddata'],()=>v.readyState>=1,signal);
    // A paused scrub lands inside the frame, avoiding media time quantization on WebKit.
    // Continuous segments begin on the exact sample boundary so none of their audio is lost.
    const time=(f-d.fromFrame+(paused ? .35 : 0))/d.fps;
    if(Math.abs(v.currentTime-time)>.001)v.currentTime=time;
    await waitFor(v,['seeked','loadeddata','canplay','timeupdate'],()=>!v.seeking&&v.readyState>=2&&Math.abs(v.currentTime-time)<.5/d.fps,signal);
    return v;
  }
  async function showFrame(f,n){
    const signal=task.signal;lastSeekAt=Date.now();
    try{
      const d=await describe(f,'still',signal);if(!alive(n))return;
      if(d.source==='frame'){
        if(still.getAttribute('src')!==d.url)still.src=d.url;
        await waitFor(still,['load'],()=>still.complete&&still.naturalWidth>0,signal);
        if(!alive(n))return;
        for(const v of videos)v.style.display='none';
        still.style.display='';
      }else{
        if(slots[1-front]?.url===d.url)front=1-front;
        await loadVideo(front,d,f,true,signal);if(!alive(n))return;present(front);
      }
      notify('paused',d.source);
    }catch(e){handle(e,n);}
  }
  function seek(raw,{scrub=false}={}){
    if(dead||!p||!length)return;
    const f=Math.max(0,Math.min(length-1,Math.round(raw)));if(!Number.isFinite(f))return;
    if(!playing&&f===position&&(status==='paused'||status==='ended')&&source)return;
    const n=invalidate();playing=false;ended=false;mark(f);blank();notify('loading',null);
    if(scrub){timer=setTimeout(()=>{timer=0;showFrame(f,n);},Math.max(0,65-(Date.now()-lastSeekAt)));}
    else return showFrame(f,n);
  }
  function updateTime(index,seconds){
    if(!playing||status!=='playing'||index!==front)return;
    const d=slots[index];if(!d)return;
    mark(Math.min(d.toFrame-1,d.fromFrame+timeFrame(seconds,d.fps)));
  }
  function clock(index,n){
    const v=videos[index];if(!v.requestVideoFrameCallback)return;
    tick=v.requestVideoFrameCallback((_now,meta)=>{
      tick=null;if(!alive(n)||!playing||front!==index)return;updateTime(index,meta.mediaTime);clock(index,n);
    });
  }
  async function prepareNext(d,n){
    if(d.toFrame>=length||!alive(n))return null;
    const f=d.toFrame,index=1-front,signal=task.signal;
    const next=await describe(f,'play',signal);
    if(!alive(n))return null;
    await loadVideo(index,next,f,false,signal);
    return {index,d:next,f};
  }
  async function run(index,d,f,n){
    if(!alive(n)||!playing)return;
    if(front!==index){videos[index].muted=videos[front].muted;videos[index].volume=videos[front].volume;videos[index].playbackRate=videos[front].playbackRate;}
    front=index;present(front);mark(f);source=d.source;
    await videos[front].play();
    if(!alive(n)||!playing)return;
    notify('playing',d.source);clock(front,n);
    readyNext=prepareNext(d,n).then(value=>({value}),failure=>({failure}));
  }
  async function play(){
    if(dead||!length||playing)return;
    if(ended){mark(0);ended=false;}
    const n=invalidate(),f=position,signal=task.signal;
    playing=true;notify('loading',source);
    try{
      const d=await describe(f,'play',signal);if(!alive(n))return;
      const index=slots[1-front]?.url===d.url?1-front:front;
      await loadVideo(index,d,f,false,signal);
      await run(index,d,f,n);
    }catch(e){handle(e,n);}
  }
  function pause(){
    if(dead||!playing)return;
    const v=videos[front],d=slots[front];
    if(d&&status==='playing')updateTime(front,v.currentTime);
    const n=invalidate();playing=false;notify('loading',source);
    return showFrame(position,n);
  }
  async function advance(index){
    if(dead||!playing||index!==front||status!=='playing')return;
    const n=epoch,d=slots[index];
    stopTick();
    if(d.toFrame>=length){playing=false;ended=true;mark(length-1);notify('ended',d.source);return;}
    notify('buffering',d.source);
    try{
      const result=await (readyNext||prepareNext(d,n).then(value=>({value})));
      if(!alive(n)||!playing)return;
      if(result?.failure)throw result.failure;
      const next=result?.value;if(!next)return;
      try{await run(next.index,next.d,next.f,n);}
      catch(e){
        // Some WebKit configurations grant audible playback to the first element only.
        if(e?.name!=='NotAllowedError'||!alive(n))throw e;
        await loadVideo(index,next.d,next.f,false,task.signal);await run(index,next.d,next.f,n);
      }
    }catch(e){handle(e,n);}
  }
  const listeners=videos.map((v,i)=>{
    const end=()=>advance(i),time=()=>{if(!v.requestVideoFrameCallback)updateTime(i,v.currentTime);};
    v.addEventListener('ended',end);v.addEventListener('timeupdate',time);
    return ()=>{v.removeEventListener('ended',end);v.removeEventListener('timeupdate',time);};
  });
  function clearSources(){for(const v of videos){v.pause();v.removeAttribute('src');v.load();}slots=[null,null];still.removeAttribute('src');known.clear();full=null;}
  function setProject(next,nextJobs=[],frame){
    if(dead)return;
    const stamp=nextJobs.filter(j=>j.status==='done'&&(Array.isArray(j.files)?j.files.includes('video'):j.files?.video)).map(j=>j.id).join('/');
    if(p&&next?.id===p.id&&next.revision===p.revision){
      p=next;if(stamp!==jobStamp){known.clear();full=null;jobStamp=stamp;}
      return;
    }
    const same=next?.id===p?.id,old=position;invalidate();playing=false;ended=false;clearSources();blank();p=next;jobStamp=stamp;length=lengthOf(p);
    position=Math.min(Math.max(0,Math.round(frame??(same?old:0))),Math.max(0,length-1));onFrame(position);
    if(length){notify('loading',null);showFrame(position,epoch);}else notify('empty',null);
  }
  function destroy(){
    if(dead)return;
    dead=true;invalidate();listeners.forEach(fn=>fn());clearSources();buffer.remove();still.remove();
    Object.assign(video.style,{display:saved[0].display,visibility:saved[0].visibility});video.controls=saved[0].controls;
  }
  setProject(initial,jobs,initialFrame);
  return {setProject,seek,play,pause,toggle:()=>playing?pause():play(),step:delta=>seek(position+delta),destroy,
    get frame(){return position;},get length(){return length;},get playing(){return playing;}};
}
