import {randomUUID} from 'node:crypto';

const end=c=>c.start+c.duration;
export function sequenceRange(project, placement) {
  const total=project.timeline.clips.reduce((n,c)=>Math.max(n,end(c)),0);
  const mode=placement?.operation||'replace-all';
  if(!['replace-all','append','replace-range'].includes(mode))throw Error('分镜操作须选择整片替换、追加或区间替换。');
  const from=mode==='append'?total:mode==='replace-all'?0:placement.fromFrame;
  const to=mode==='replace-range'?placement.toFrame:total;
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from||to>total||(mode==='replace-range'&&to===from))
    throw Error('请用当前时间线上的半开区间 [fromFrame,toFrame) 选择要改的整段。');
  if(project.timeline.clips.some(c=>c.locked&&c.start<to&&end(c)>from))
    throw Error('所选编排区间包含用户锁定片段，请选择相邻区间或只编辑未锁定的轨道。');
  return {mode,from,to,total};
}

function shift(row,by,names) {
  const moved={...row};
  for(const k of ['start','atFrame','actionFrame','frame','toFrame'])if(Number.isSafeInteger(row[k]))moved[k]=row[k]+by;
  if(row.visualSteps)moved.visualSteps=row.visualSteps.map(s=>shift(s,by,names));
  if(names){
    for(const key of ['id','videoClipId','speechGroup','clipId'])if(row[key]&&names.has(row[key]))moved[key]=names.get(row[key]);
    if(row.evidenceAnchor)moved.evidenceAnchor={...row.evidenceAnchor,stepId:names.prefix+row.evidenceAnchor.stepId,
      ...(row.evidenceAnchor.sequenceId?{sequenceId:names.prefix+row.evidenceAnchor.sequenceId}:{})};
  }
  return moved;
}

// Work at shot/phrase boundaries so source windows and recorded speech retain their
// identities. A music bed can span either edge and keeps both outside source offsets.
export function compileSequenceEdit(project, range, block) {
  const {mode,from,to}=range, delta=block.frames-(to-from);
  const existing=project.timeline.clips, commands=[],kept=[],added=[];
  const names=new Map(),prefix=mode==='replace-all'?'':'section-'+randomUUID().slice(0,12)+'-';
  names.prefix=prefix;
  for(const c of block.clips)names.set(c.id,prefix+c.id);
  for(const c of existing){
    if(mode==='replace-all'){commands.push({op:'remove',id:c.id});continue;}
    if(end(c)<=from){kept.push(c);continue;}
    if(c.start>=to){
      if(delta&&c.locked)throw Error('本次时长变化会移动后方锁定片段，请保留该区间时长或换一处重排。');
      const moved=shift(c,delta);
      if(delta)commands.push({op:'update',id:c.id,changes:{start:moved.start,...(Number.isInteger(c.actionFrame)?{actionFrame:moved.actionFrame}:{})}});
      kept.push(moved);continue;
    }
    if(c.start>=from&&end(c)<=to){commands.push({op:'remove',id:c.id});continue;}
    const importRecording=c.track==='narration'&&project.settings?.voiceMode==='import'&&c.assetId===project.settings.narrationAssetId;
    if((c.track!=='music'&&!importRecording)||['scene-sound','sfx'].includes(c.role))
      throw Error('区间边界穿过片段 '+c.id+'（'+c.start+'–'+end(c)+' 帧），请对齐完整镜头或语句。需要局部画面时可先用 studio_edit 分割镜头。');
    const left=Math.max(0,from-c.start),right=Math.max(0,end(c)-to);
    if(left){commands.push({op:'update',id:c.id,changes:{duration:left}});kept.push({...c,duration:left});}
    else commands.push({op:'remove',id:c.id});
    if(right){
      const tail={...c,id:prefix+'tail-'+randomUUID().slice(0,12),start:to+delta,duration:right,
        sourceIn:(c.sourceIn||0)+Math.round((to-c.start)*(c.speed||1))};
      added.push(tail);
    }
  }
  for(const c of block.clips)added.push(shift(c,from,names));
  for(const clip of added)commands.push({op:'add',clip});
  const spliceRows=(old,rows,frameKey)=>[
    ...(mode==='replace-all'?[]:(old||[]).filter(r=>Number.isFinite(r[frameKey])&&r[frameKey]<from)),
    ...rows.map(r=>shift(r,from,names)),
    ...(mode==='replace-all'?[]:(old||[]).filter(r=>Number.isFinite(r[frameKey])&&r[frameKey]>=to).map(r=>shift(r,delta)))
  ].sort((a,b)=>a[frameKey]-b[frameKey]);
  // Preserve global notices and all issue locations outside the affected range.
  const globalNotes=mode==='replace-all'?[]:(project.directorNotes||[]).filter(n=>!Number.isInteger(n.frame));
  return {commands,clips:[...kept,...added],storyboard:spliceRows(project.storyboard,block.board,'start'),
    facts:spliceRows(project.facts,block.facts,'start'),notes:[...globalNotes,...spliceRows(project.directorNotes,block.notes,'frame')]};
}
