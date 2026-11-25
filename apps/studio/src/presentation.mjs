import {contentStage} from '../www/motion-clock.js';
import {assText,assClock,createAss} from './text-tracks.mjs';

export const hasV8Presentation = p => Number(p.style?.version) === 8 && ['henry-hot-news','henry-technical-explainer'].includes(p.style.id);
export function portraitLayout(p) {
  if (!hasV8Presentation(p) || p.profile.height <= p.profile.width) return null;
  const {width,height}=p.profile, s=width/1080;
  const contentHeight=contentStage(p.profile,p.style).height;
  return {id:'customer-portrait-v3',contentHeight,top:Math.round((height-contentHeight)/2),
    titleBottom:height/2-(316+7.8)*s,captionTop:height/2+321*s,titleSize:92*s,captionSize:54*s};
}

export function publicationFields(fields) {
  const title = String(fields.title||'').trim(), plain=title.replace(/\n/g,'');
  const emphasis = String(fields.emphasis||'').trim();
  if (emphasis && (plain===emphasis || !plain.includes(emphasis))) throw Error('黄色重点须是标题中的部分原文。');
  const out={emphasis};
  for (const key of ['cover34','cover43']) {
    const c=fields[key];
    if(c==null)continue;
    if (!Number.isSafeInteger(c.frame)||c.frame<0||![c.x,c.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)) throw Error('封面需使用工程内的帧号和 0 到 1 的取景中心。');
    out[key]={frame:c.frame,x:c.x,y:c.y};
  }
  return out;
}

export function balancedRows(raw, maxUnits) {
  const chars=[...String(raw||'').trim()];
  const units=c=>c.codePointAt(0)<256?.56:1;
  if(chars.includes('\n')) return chars.join('').split('\n');
  const sum=chars.reduce((a,c)=>a+units(c),0);
  if(sum<=maxUnits) return [chars.join('')];
  const count=Math.ceil(sum/maxUnits), result=[];let line='',length=0;
  for(const char of chars){
    if(line&&length+units(char)>sum/count+.48){result.push(line);line='';length=0;}
    line+=char;length+=units(char);
  }
  if(line)result.push(line);
  return result;
}
export function headline(project) {
  const title=project.publication?.title || project.title || '';
  return {title,emphasis:project.publication?.emphasis || ''};
}
export function coloredTitle(rows, emphasis) {
  const flat=rows.join(''), index=emphasis?flat.indexOf(emphasis):-1;
  let offset=0;
  return rows.map(row=>{
    const start=Math.max(0,index-offset),end=Math.min(row.length,index+emphasis.length-offset);
    offset+=row.length;
    return index<0||end<=start?assText(row):assText(row.slice(0,start))+'{\\1c&H00FFF0&}'+assText(row.slice(start,end))+'{\\1c&HFFFFFF&}'+assText(row.slice(end));
  }).join('\\N');
}
const precise=n=>Number(n.toFixed(2));
export function typeLine({text,x,y,size,align=2,weight=900}) {
  return '{\\an'+align+'\\pos('+precise(x)+','+precise(y)+')\\q2\\fnNoto Sans SC\\b'+weight+'\\fs'+precise(size)+'\\bord0\\shad0\\1c&HFFFFFF&}'+text;
}
const event=(layer,from,to,fps,body)=>'Dialogue: '+layer+','+assClock(from,fps)+','+assClock(to,fps)+',Caption,,0,0,0,,'+body;
const hash=n=>{const v=Math.sin(n*127.1+311.7)*43758.5453;return v-Math.floor(v);};
// Same seeds, six SVG groups and five-segment paths as the approved portrait_design.py.
function backgroundPaths(width,height) {
  const s=width/1080, field=height/s+440;
  return Array.from({length:6},(_,g)=>{
    const paths=[];
    for(let i=0;i<20;i++){
      const seed=g*211+i*17+1;
      let x=-190+i%4*380+hash(seed)*270,y=-210+Math.floor(i/4)*field/5+hash(seed+1)*330, angle=hash(seed+2)*2*Math.PI;
      for(let j=0;j<5;j++){
        angle+=(hash(seed+j*11+3)-.5)*1.8;
        const length=130+hash(seed+j*7+5)*230, dx=Math.cos(angle),dy=Math.sin(angle),nx=x+dx*length,ny=y+dy*length;
        const point=(a,b)=>Math.round((a+1000)*s*4)+' '+Math.round((b+1000)*s*4);
        paths.push('m '+point(x-.7*dy,y+.7*dx)+' l '+point(nx-.7*dy,ny+.7*dx)+' '+point(nx+.7*dy,ny-.7*dx)+' '+point(x+.7*dy,y-.7*dx));
        x=nx;y=ny;
      }
    }
    // Include the drawing origin so libass uses the correct bounding box.
    return 'm 0 0 l 0 0 '+paths.join(' ');
  });
}
export function portraitScript(project,layout,from,to,total) {
  const {width,height,fps}=project.profile, s=width/1080, lines=[createAss([],project.profile)];
  const paths=backgroundPaths(width,height);
  const step=Math.max(1,Math.round(fps/2));
  for(let a=Math.floor(from/step)*step;a<to;a+=step) {
    const b=Math.min(total,a+step);
    for(let g=0;g<6;g++) {
      const pos=f=>{
        const t=f/fps;
        return [s*(-1000+Math.sin(t*(.11+g*.017)+g*2.1)*36+Math.sin(t*.043+g)*15),s*(-1000+Math.cos(t*(.09+g*.013)+g*1.3)*28)].map(precise);
      };
      const angle=f=>precise(-Math.sin(f/fps*.035+g)*2.4);
      const alpha=Math.round(255*(1-.12*(.64+g*.065))).toString(16);
      lines.push(event(0,a,b,fps,'{\\an7\\move('+[...pos(a),...pos(b)].join(',')+')\\org('+width/2+','+height/2+')\\frz'+angle(a)+'\\t(\\frz'+angle(b)+')\\bord0\\shad0\\1c&HADA59C&\\1a&H'+alpha+'&\\p3}'+paths[g]));
    }
  }
  const {title,emphasis}=headline(project);
  const rows=balancedRows(title,10.55);
  lines.push(event(3,0,total,fps,typeLine({text:coloredTitle(rows,emphasis),x:width/2,y:layout.titleBottom,size:layout.titleSize})));
  for(const c of project.timeline.clips.filter(c=>c.track==='caption'&&c.enabled!==false&&!c.hidden&&c.start<to&&c.start+c.duration>from)){
    const rows=balancedRows(c.text,18);
    lines.push(event(4,c.start,c.start+c.duration,fps,typeLine({text:rows.map(assText).join('\\N'),align:5,x:width/2,y:layout.captionTop+(rows.length===1?34:67.5)*s,size:layout.captionSize,weight:600})));
  }
  return lines.join('\n')+'\n';
}
export function portraitEnding(total,fps) {
  const black=Math.max(0,total-Math.round(.6*fps)),fade=Math.max(0,black-Math.round(1.2*fps));
  return {black,fade,musicFade:Math.max(0,black-Math.round(1.4*fps))};
}
export function portraitGraph(project,layout,base,from,total) {
  const {width,height,fps}=project.profile,{black,fade}=portraitEnding(total,fps);
  const t='clip((N-1+'+from+'-'+fade+')/'+Math.max(1,black-fade)+',0,1)';
  // Draw the texture underneath the complete footage window, then title/captions above the base.
  const clock='settb=1/'+fps+',setpts=N+'+from;
  return 'color=c=0x030405:s='+width+'x'+height+':r='+fps+','+clock+',ass=portrait.ass:fontsdir=fonts,setpts=N[paper];[paper]'+base+'overlay=x=0:y='+layout.top+':shortest=1[stage];[stage]split[f][b];[b]drawbox=c=black:t=fill[black];[f][black]blend=all_expr=\'A*(1-('+t+')*('+t+')*(3-2*('+t+')))+B*('+t+')*('+t+')*(3-2*('+t+'))\':shortest=1[outportrait]';
}
