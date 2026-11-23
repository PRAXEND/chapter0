import {motionCues,defaultMotionGeometry} from '../www/motion-clock.js';
export {motionCues,defaultMotionGeometry};
// These versioned presets refer only to the six JSX files shipped with the Henry pack.
import {readFileSync} from 'node:fs';

const pack = new URL('../../../user-packs/henry-video-styles/reproduction/technical-explainer/motion-graphics.json', import.meta.url);
const originals = JSON.parse(readFileSync(pack, 'utf8'));
const definitions = [
  ['impact-title', '动词强调', 70, 65],
  ['source-label', '来源标识', 110, 12, [0]],
  ['process-rail', '阶段路径', 260, 70, [0,150,270]],
  ['staggered-explanation', '三步跟随', 70, 210, [0,18,36]],
  ['fragment-title', '纵条聚字', 80, 120],
  ['comparison-guide', '分屏标识', 0, 235],
];
const labels = {font:'字体', label:'眉题', title:'标题', size:'字号', white:'文字颜色', cyan:'强调颜色',
  transparentBackground:'透明底', a:'第一句', b:'第二句', c:'第三句', lab:'来源一', hardware:'来源二',
  left:'左侧标识', right:'右侧标识', second:'第二步参考帧', third:'第三步参考帧'};
export const motionCatalog = definitions.map(([id,name,left,top,referenceCues=[]],i) => {
  const original = originals[i];
  const {width,height} = original.dimensions;
  const fields = original.editableProperties.map(({key,type,defaultValue}) => ({key,type,defaultValue,label:labels[key]}));
  return {id,index:i+1,name,version:1,width,height,referenceCues,referenceDuration:Math.round(original.durationMs*.03),fields,
    geometry:{x:(left+width/2)/1920,y:(top+height/2)/1080,width:width/1920,height:height/1080}};
});
const byId = new Map(motionCatalog.map(c => [c.id,c]));
const object = value => value && typeof value==='object' && !Array.isArray(value);
const fail = message => {throw Object.assign(new Error(message),{status:422});};

export function componentClip({id,componentId,start,duration,props={},cueFrames,geometry},profile) {
  const component=byId.get(componentId);
  if(!component) fail('该组件尚未注册。');
  const clip={id,track:'graphic',text:'',start,duration,sourceIn:0,speed:1,gain:1,
    geometry:geometry??defaultMotionGeometry(component,profile),motion:{version:component.version,componentId,props,...(cueFrames?{cueFrames}:{})}};
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
    const valid = field.type==='number' ? Number.isFinite(value) && value>=0 && value<=(key==='size'?320:86400*30)
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
  return {id:c.id,index:c.index,props,frame,duration,width:c.width,height:c.height};
}
