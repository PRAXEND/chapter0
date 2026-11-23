import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const exec=promisify(execFile);
const round=n=>Math.round(n*1000)/1000;
const axisDifference=(a,b)=>((a-b+270)%180)-90;

async function decode(ffmpeg,file,frames,width,height){
  const numbers=[...new Set(frames)].sort((a,b)=>a-b);
  const select=numbers.map(n=>'eq(n\\,'+n+')').join('+');
  const bytes=width*height*3;
  const {stdout}=await exec(ffmpeg,['-v','error','-nostdin','-i',file,'-map','0:v:0','-vf','select='+select+',scale='+width+':'+height,'-fps_mode','passthrough','-f','rawvideo','-pix_fmt','rgb24','-threads','1','-'],{encoding:'buffer',maxBuffer:bytes*(numbers.length+1)});
  assert.equal(stdout.length,bytes*numbers.length,'取出的帧数与选择不符');
  return new Map(numbers.map((n,i)=>[n,{data:stdout.subarray(i*bytes,(i+1)*bytes),width,height}]));
}
function rect(geometry,width,height){
  return [Math.round((geometry.x-geometry.width/2)*width),Math.round((geometry.y-geometry.height/2)*height),Math.round(geometry.width*width),Math.round(geometry.height*height)];
}
function region(parent,x,y,w,h){
  const [ox,oy,ow,oh]=parent;return [ox+Math.round(ow*x),oy+Math.round(oh*y),Math.round(ow*w),Math.round(oh*h)];
}
function pixels(frame,box,fn){
  const [x,y,w,h]=box;
  for(let j=Math.max(0,y);j<Math.min(frame.height,y+h);j++)for(let i=Math.max(0,x);i<Math.min(frame.width,x+w);i++){
    const k=(j*frame.width+i)*3;
    fn(frame.data[k],frame.data[k+1],frame.data[k+2],i,j,k);
  }
}
function difference(a,b,box,threshold=25){
  let sum=0,changed=0,count=0;
  pixels(a,box,(r,g,blue,_x,_y,k)=>{
    const delta=[r-b.data[k],g-b.data[k+1],blue-b.data[k+2]].map(Math.abs);
    sum+=delta[0]+delta[1]+delta[2];if(Math.max(...delta)>=threshold)changed++;count++;
  });
  return {mean:round(sum/(3*count)),changed};
}
function colourCount(a,box,test){
  let total=0;pixels(a,box,(r,g,b)=>{if(test(r,g,b))total++;});return total;
}
const cyan=(r,g,b)=>g>125&&b>120&&g-r>55&&b-r>45&&Math.abs(g-b)<63;
const white=(r,g,b)=>Math.min(r,g,b)>178&&Math.max(r,g,b)-Math.min(r,g,b)<45;
function angle(frame,cx,cy){
  let n=0,sx=0,sy=0,sxx=0,sxy=0,syy=0;
  pixels(frame,[cx-140,cy-136,280,272],(r,g,b,x,y)=>{
    if(!white(r,g,b))return;
    const dx=x-cx,dy=y-cy;n++;sx+=dx;sy+=dy;sxx+=dx*dx;sxy+=dx*dy;syy+=dy*dy;
  });
  if(n<50)return {degrees:null,whitePixels:n};
  const degrees=.5*Math.atan2(2*(sxy-sx*sy/n),sxx-sx*sx/n-(syy-sy*sy/n))*180/Math.PI;
  return {degrees:round(degrees),whitePixels:n};
}
function sourceError(composite,source,xOffset,yOffset){
  let error=0,count=0;
  for(let y=32;y<source.height-28;y+=3)for(let x=18;x<source.width-18;x+=3){
    const a=((y+yOffset)*composite.width+x+xOffset)*3,b=(y*source.width+x)*3;
    for(let ch=0;ch<3;ch++){error+=Math.abs(composite.data[a+ch]-source.data[b+ch]);count++;}
  }
  return round(error/count);
}
async function sheet(ffmpeg,frames,file,cols){
  const tileWidth=480,tileHeight=270,rows=Math.ceil(frames.length/cols);
  const raw=Buffer.alloc(tileWidth*cols*tileHeight*rows*3);
  frames.forEach((frame,i)=>{
    const x=i%cols*tileWidth,y=Math.floor(i/cols)*tileHeight;
    for(let row=0;row<tileHeight;row++)for(let column=0;column<tileWidth;column++){
      const offset=(Math.floor(row*frame.height/tileHeight)*frame.width+Math.floor(column*frame.width/tileWidth))*3;
      const target=((y+row)*tileWidth*cols+x+column)*3;
      raw[target]=frame.data[offset];raw[target+1]=frame.data[offset+1];raw[target+2]=frame.data[offset+2];
    }
  });
  // No image libraries or external fonts are required by the acceptance script.
  const header=Buffer.from('P6\n'+tileWidth*cols+' '+tileHeight*rows+'\n255\n');
  const child=execFile(ffmpeg,['-v','error','-nostdin','-f','image2pipe','-c:v','ppm','-i','pipe:0','-frames:v','1','-q:v','2',file]);
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('联系表写入失败 '+code)));});
  child.stdin.end(Buffer.concat([header,raw]));await done;
}
export async function verifyCompositionPixels({files,evidence,ffmpeg,profile,samples,newCues,staggered}){
  const {width:w,height:h}=profile;
  const checks=[];const check=(name,pass,measurements)=>checks.push({name,pass:Boolean(pass),measurements});
  const splitTimes=[70,118,223],rotationTimes=[360,372,384,396,408,420,432],timing=[16,38,57,77];
  const globalTiming=timing.map(n=>staggered.start+n);
  const rail=samples.find(s=>s.id==='process-rail'),fragment=samples.find(s=>s.id==='fragment-title');
  const railTimes=[12,29,48].map(n=>rail.start+n);
  const all=[...samples.map(s=>s.at),...splitTimes,...rotationTimes,...globalTiming,...railTimes,fragment.start+4,fragment.start+30];
  const full=await decode(ffmpeg,files.full,all,w,h);
  const plate=await decode(ffmpeg,files.plate,samples.map(s=>s.at),w,h);
  const sources=[await decode(ffmpeg,files.atlas,splitTimes,w/2,h/2),await decode(ffmpeg,files.flight,splitTimes,w/2,h/2)];
  const sameSource=[];
  // The YUV420 canvas places the top-left sample on an even chroma coordinate.
  // A 480×270 image inside 480×540 has a mathematical top of 135, encoded at 134.
  const paneTop=2*Math.floor((h-h/2)/4);
  for(const frame of splitTimes)for(const pane of [0,1]){
    const matching=sourceError(full.get(frame),sources[pane].get(frame),pane*w/2,paneTop);
    const swapped=sourceError(full.get(frame),sources[1-pane].get(frame),pane*w/2,paneTop);
    sameSource.push({frame,pane:pane?'right':'left',matching,swapped});
  }
  check('同帧两个视口分别来自对应的实拍原片',sameSource.every(x=>x.matching<10&&x.matching<x.swapped*.4),sameSource);
  for(const s of samples){
    const box=rect(s.geometry,w,h),f=full.get(s.at),ref=plate.get(s.at);
    const impact=difference(f,ref,box);let feature=true,detail={};
    if(s.id==='impact-title'){
      // The authored cyan kicker and underline are both inside the component's own box.
      detail={upperCyan:colourCount(f,region(box,0,0,.91,.46),cyan),lowerCyan:colourCount(f,region(box,0,.58,.91,.42),cyan)};
      feature=detail.upperCyan>12&&detail.lowerCyan>35;
    }else if(s.id==='source-label'){
      const left=region(box,0,0,.4,1),right=region(box,.5,0,.5,1);
      detail={leftWhite:colourCount(f,left,white),rightWhite:colourCount(f,right,white)};
      const leftFraction=detail.leftWhite/(left[2]*left[3]),rightFraction=detail.rightWhite/(right[2]*right[3]);
      feature=detail.rightWhite>65&&rightFraction<.65&&leftFraction<rightFraction*.3;
    }else if(s.id==='fragment-title'){
      const slices=difference(full.get(fragment.start+4),full.get(fragment.start+30),box);
      detail={slices,underline:colourCount(f,region(box,0,.78,.45,.22),cyan)};feature=slices.changed>140&&detail.underline>35;
    }else if(s.id==='comparison-guide'){
      // Authored in a 1920px box at x=958, width=4. In 4:2:0 the two thin
      // output columns share chroma with the adjacent footage. Check their change
      // toward the stroke colour against the real plain plate; luma is full resolution.
      const divider=region(box,958/1920,.05,4/1920,.90);
      const target=[72,225,209],luma=(r,g,b)=>.2126*r+.7152*g+.0722*b;
      const targetLuma=luma(...target),distance=(r,g,b)=>Math.abs(r-target[0])+Math.abs(g-target[1])+Math.abs(b-target[2]);
      const changedRows=new Set();
      pixels(f,divider,(r,g,b,_x,y,k)=>{
        const oldDistance=distance(ref.data[k],ref.data[k+1],ref.data[k+2]);
        if(g>r+15&&Math.abs(luma(r,g,b)-targetLuma)<24&&distance(r,g,b)<oldDistance-30)changedRows.add(y);
      });
      detail={cyanRows:changedRows.size,dividerHeight:divider[3],dividerColumns:[divider[0],divider[0]+divider[2]-1],leftLabel:difference(f,ref,region(box,.02,0,.28,.11)).changed,rightLabel:difference(f,ref,region(box,.53,0,.36,.11)).changed};
      feature=changedRows.size>divider[3]*.90&&detail.leftLabel>30&&detail.rightLabel>30;
    }else if(s.id==='process-rail'){
      const cols=railTimes.map(n=>[0,1,2].map(i=>colourCount(full.get(n),region(box,i/3,0,1/3,1),cyan)));
      detail={frames:railTimes,activeCyanByCard:cols};
      feature=cols[0][0]>45&&cols[1][1]>cols[0][1]+40&&cols[2][2]>cols[1][2]+40;
    }else if(s.id===staggered.id){
      const cyanDots=[.04,.32,.60].map(y=>colourCount(f,region(box,0,y,.11,.31),cyan));detail={cyanDots};feature=cyanDots.every(n=>n>7);
    }
    check('原版组件 '+s.id,impact.changed>100&&feature,{frame:s.at,box,...impact,...detail});
  }
  const sets={};
  for(const name of ['before','words','draft']){
    const item=files[name],rel=globalTiming.map(n=>n-item.from);
    const decoded=await decode(ffmpeg,item.file,rel,w,h);sets[name]=new Map(globalTiming.map((n,i)=>[n,decoded.get(rel[i])]));
  }
  const box=rect(staggered.geometry,w,h);
  const rowBoxes=[.06,.36,.65].map(y=>region(box,.09,y,.89,.27));
  const before=sets.before,words=sets.words,draft=sets.draft,at=n=>staggered.start+n;
  const renderedWords=rowBoxes.map(r=>difference(before.get(at(57)),words.get(at(57)),r));
  check('只修改第二句，第一、三行像素稳定',renderedWords[1].changed>120&&renderedWords[1].changed>8*Math.max(9,renderedWords[0].changed,renderedWords[2].changed),renderedWords);
  const wordsShown=colourCount(words.get(at(38)),rowBoxes[1],white);
  const delayedEmpty=colourCount(draft.get(at(38)),rowBoxes[1],white);
  const delayedShown=colourCount(draft.get(at(57)),rowBoxes[1],white);
  const afterSettles=difference(words.get(at(77)),draft.get(at(77)),box);
  check('拖第二句出现点，原出现窗口消失，晚到以后文字完整',wordsShown>100&&delayedEmpty<wordsShown*.12&&delayedShown>wordsShown*.82&&afterSettles.mean<4,{beforeCue:staggered.cues[1],afterCue:newCues[1],at38Before:wordsShown,at38After:delayedEmpty,at57After:delayedShown,afterSettles});
  const previewDifferences=globalTiming.map(frame=>{
    const a=draft.get(frame),b=full.get(frame);return {frame,localFrame:frame-files.draft.from,whole:difference(a,b,[0,0,w,h]).mean,secondRow:difference(a,b,rowBoxes[1]).mean};
  });
  const fullBefore=colourCount(full.get(at(38)),rowBoxes[1],white),fullAfter=colourCount(full.get(at(57)),rowBoxes[1],white);
  check('非零起点的六秒草稿与正式成片同帧同字',fullAfter>100&&fullBefore<fullAfter*.12&&previewDifferences.every(x=>x.whole<5&&x.secondRow<6),previewDifferences);
  for(const [i,name] of ['上桨逆时针','下桨顺时针'].entries()){
    const points=rotationTimes.map(frame=>({frame,...angle(full.get(frame),Math.round(w*(i?.74:.26)),Math.round(h*.5))}));
    const delta=points.slice(1).map((p,j)=>p.degrees==null||points[j].degrees==null?null:round(axisDifference(p.degrees,points[j].degrees)));
    const expected=i?20.4:-20.4;
    check(name+'实际改变白色轮廓角度',points.every(p=>p.whitePixels>160)&&delta.every(n=>n!==null&&Math.abs(n-expected)<5),{points,delta,expected});
  }
  await sheet(ffmpeg,samples.map(s=>full.get(s.at)),path.join(evidence,'六个原版组件.jpg'),2);
  await sheet(ffmpeg,[before.get(at(38)),words.get(at(38)),draft.get(at(38)),draft.get(at(57))],path.join(evidence,'三步跟随的四个实拍状态.jpg'),2);
  await sheet(ffmpeg,rotationTimes.filter((_,i)=>i%2===0).map(f=>full.get(f)),path.join(evidence,'两层旋翼的相反转动.jpg'),2);
  return {checks,method:'成片解码 RGB；绝对帧在公式与项目时钟一致。时刻、色块面积、左右原片的像素误差、白色轮廓主轴均以真实输出重算。预览与导出为两种有损编码，以 RGB 误差与摘录中可见与不可见状态交叉核对。'};
}
