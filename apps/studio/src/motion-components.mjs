import {motionCues,defaultMotionGeometry} from '../www/motion-clock.js';
export {motionCues,defaultMotionGeometry};
import {motionSoundEvents,soundResources,supportsSound} from './style-sounds.mjs';
import {motionSources} from './motion-source-files.mjs';
import {readFileSync} from 'node:fs';

const packRoot = new URL('../../../user-packs/henry-video-styles/reproduction/',import.meta.url);
const originals = Object.fromEntries([...new Set(motionSources.map(s=>s.folder))].map(folder=>[folder,
  JSON.parse(readFileSync(new URL(folder+'/motion-graphics.json',packRoot),'utf8'))]));
// Frame landmarks and original placements are in the pack's 1920×1080, 30-fps coordinates.
const definitions = [
  ['动词强调',70,65], ['来源标识',110,12,[0]], ['阶段路径',260,70,[0,150,270]],
  ['三步跟随',70,210,[0,18,36]], ['纵条聚字',80,120], ['分屏标识',0,235],
  ['动作冲击线',530,300,[0]], ['事实光扫揭示',140,145,[0,10]],
  ['机制大字与环绕字',800,150,[0,65,161]], ['情绪弹字与错位裂字',1040,125,[0,10]],
  ['台面四角投影',1240,725,[0]], ['轻量来源角标',1265,20,[]], ['方向拖影重点词',250,160,[0]],
];
const labels = {font:'字体', label:'眉题', title:'标题', size:'字号', white:'文字颜色', cyan:'强调颜色',
  transparentBackground:'透明底', a:'第一句', b:'第二句', c:'第三句', lab:'来源一', hardware:'来源二',
  left:'左侧标识', right:'右侧标识', second:'第二步参考帧', third:'第三步参考帧',
  color:'文字颜色',accent:'强调色',subtitle:'副标题',ink:'描边色',kicker:'眉题',titleA:'第一段标题',titleB:'第二段标题',
  titleC:'第三段标题',subA:'第一段解释',subB:'第二段解释',subC:'第三段解释',orbit:'环绕词（用 · 分隔）',
  actionA:'动作一',actionB:'动作二',actionC:'动作三',note:'备注',text:'文字',emphasis:'首个强调字符序号',
  count:'强调字符数',crack:'裂字',tilt:'倾角（度）',glow:'光晕色'};
export const motionCatalog = motionSources.map((source,i) => {
  const [name,left,top,referenceCues=[]]=definitions[i];
  const original=originals[source.folder][Number(source.file.slice(3,5))-1];
  const {width,height}=original.dimensions;
  const fields=original.editableProperties.map(({key,type,defaultValue})=>({key,type,defaultValue,label:labels[key]||key}));
  return {...source,sourceId:original.id,index:i+1,name,version:1,width,height,referenceCues,
    referenceDuration:Math.round(original.durationMs*.03),fields,
    soundEvents:(motionSoundEvents[source.id]||[]).map(([resourceId,cue])=>({cue,resourceId})),
    soundResources:soundResources.filter(s=>supportsSound({id:source.styleId,version:source.styleVersion},s.id)).map(s=>({id:s.id,name:s.name})),
    fontFallback:fields.some(f=>f.defaultValue==='Xinqingnian Ti')?'Noto Sans SC':undefined,
    geometry:{x:(left+width/2)/1920,y:(top+height/2)/1080,width:width/1920,height:height/1080}};
});
const byId = new Map(motionCatalog.map(c => [c.id,c]));
const object = value => value && typeof value==='object' && !Array.isArray(value);
const fail = message => {throw Object.assign(new Error(message),{status:422});};

export function componentClip({id,componentId,start,duration,props={},cueFrames,geometry,soundDesign},profile) {
  const component=byId.get(componentId);
  if(!component) fail('该组件尚未注册。');
  const clip={id,track:'graphic',text:'',start,duration,sourceIn:0,speed:1,gain:1,
    ...(soundDesign?{soundDesign}:{}),geometry:geometry??defaultMotionGeometry(component,profile),motion:{version:component.version,componentId,props,...(cueFrames?{cueFrames}:{})}};
  validateMotionClip(clip,profile);
  return clip;
}

export function validateMotionClip(clip, profile) {
  const m = clip.motion;
  const component = byId.get(m?.componentId);
  if (!component || (m.version??1)!==component.version) fail('无法渲染这个动效组件或版本。');
  if (clip.track!=='graphic' || clip.shape || clip.text || (clip.speed??1)!==1 || (clip.sourceIn??0)!==0 || clip.keyframes?.length)
    fail('组件须放在独立动效层；请使用组件参数、位置和出场帧调整画面。');
  if (!object(m) || Object.keys(m).some(k=>!['componentId','version','props','cueFrames'].includes(k))) fail('组件含未支持的字段。');
  if (!object(m.props??{})) fail('组件参数必须按名称提供。');
  for (const [key,value] of Object.entries(m.props??{})) {
    const field = component.fields.find(f=>f.key===key);
    if (!field) fail('未知的组件参数：'+key);
    const valid = field.type==='number' ? Number.isFinite(value) && value>=(key==='tilt'?-180:0) && value<=(key==='size'?320:key==='tilt'?180:86400*30) && (!['emphasis','count'].includes(key)||Number.isSafeInteger(value))
      : field.type==='boolean' ? typeof value==='boolean'
      : field.type==='color' ? typeof value==='string' && /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
      : typeof value==='string' && value.length<=(field.type==='font'?120:500);
    if (!valid) fail('组件参数无效：'+field.label);
  }
  const g = clip.geometry??defaultMotionGeometry(component,profile);
  if (!['x','y','width','height'].every(k=>Number.isFinite(g[k])) || g.width<=0 || g.height<=0 || g.width>2 || g.height>2 ||
      g.x<0 || g.x>1 || g.y<0 || g.y>1) fail('组件位置须为画布上的中心及有效宽高。');
  const cues = m.cueFrames ?? motionCues(component,clip.duration,profile.fps,m.props);
  const expected = component.referenceCues.length;
  if (!Array.isArray(cues) || (component.id==='source-label' ? !cues.length || cues.length>128 : cues.length!==expected) ||
      (cues.length && cues[0]!==0) || cues.some((f,i)=>!Number.isSafeInteger(f) || f<0 || f>=clip.duration || (i>0 && f<=cues[i-1])))
    fail('出场帧须从片段第 0 帧开始，依次递增并落在片段内。');
}

// The original JSX runs at 30 fps. Keep its entry/hold/exit behaviour when a user moves
// an individual line, without stretching the nine-frame entrance over a long pause.
export function motionSample(clip,profile,absoluteFrame) {
  const m=clip.motion, c=byId.get(m.componentId);
  const props=Object.fromEntries(c.fields.map(f=>[f.key,m.props?.[f.key]??f.defaultValue]));
  const ratio=30/profile.fps;
  const elapsed=absoluteFrame-clip.start;
  const cues=m.cueFrames??motionCues(c,clip.duration,profile.fps,m.props);
  let frame=elapsed*ratio, duration=Math.max(21,clip.duration*ratio);
  if(c.id==='staggered-explanation'){
    const i=Math.max(0,cues.findLastIndex(at=>elapsed>=at));
    const nativeStart=c.referenceCues[i], next=c.referenceCues[i+1];
    const available=(cues[i+1]??clip.duration)-cues[i];
    const pace=Math.max(ratio,9/available);
    frame=nativeStart+(elapsed-cues[i])*pace;
    if(next!==undefined) frame=Math.min(next-1,frame);
    duration=Math.max(54,36+(clip.duration-cues[2])*Math.max(ratio,9/(clip.duration-cues[2])));
  }else if(c.id==='process-rail'){
    props.second=cues[1]*ratio;props.third=cues[2]*ratio;
  }else if(c.id==='source-label'){
    // The JSX selects one of two source identities using fixed Atlas time ranges.
    // Alternate those identities at this project's cues instead of leaking the Atlas cuts.
    frame=cues.findLastIndex(at=>elapsed>=at)%2===1 ? 1302 : 0;
  }
  if(c.folder==='hot-news' && !['hot-source-label','hot-directional-word'].includes(c.id)){
    // Fixed-30-fps originals contain hard-coded entrances and exits. Tie their authored
    // landmarks to project cues, including the final exit when the clip is shortened.
    const marks=c.referenceCues, i=Math.max(0,cues.findLastIndex(at=>elapsed>=at));
    const from=cues[i]??0,to=cues[i+1]??Math.max(from+1,clip.duration-1);
    const start=marks[i]??0,end=marks[i+1]??c.referenceDuration-1;
    frame=start+(end-start)*Math.min(1,Math.max(0,(elapsed-from)/(to-from)));
    duration=c.referenceDuration;
  }
  return {id:c.id,index:c.index,props,frame,duration,width:c.width,height:c.height};
}
