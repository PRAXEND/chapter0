import {isDeepStrictEqual as same} from 'node:util';
import {overlapOnStage} from './viewport.mjs';

const titles={add:'添加片段',update:'修改片段',remove:'删除片段',lock:'锁定片段',move:'移动片段',split:'分割片段',
  trim:'裁切片段',speed:'调整倍速','ripple-remove':'同轨波纹删除'};
const conflict=message=>Object.assign(new Error(message),{status:409});
const byId=clips=>new Map(clips.map(c=>[c.id,c]));
const overlaps=(a,b,profile)=>a.track===b.track&&a.start<b.start+b.duration&&b.start<a.start+a.duration&&overlapOnStage(a,b,profile);
const sourceFields=['track','assetId','sourceIn','speed','duration','sampleWindow'];

// Body snapshots already exist for every committed revision. This journal just
// indexes user transactions. Undo writes a NEW revision on top of the live project.
// Jobs, project settings, new assets and later independent director edits stay live.
export function createEditHistory(db,{revision,validateClip,sortClips}){
  db.exec('CREATE TABLE IF NOT EXISTS timeline_edits(project TEXT NOT NULL, revision INTEGER NOT NULL, label TEXT NOT NULL, applied INTEGER NOT NULL, PRIMARY KEY(project,revision))');
  const undo=db.prepare('SELECT revision,label FROM timeline_edits WHERE project=? AND applied=1 ORDER BY revision DESC LIMIT 1');
  const redo=db.prepare('SELECT revision,label FROM timeline_edits WHERE project=? AND applied=0 ORDER BY revision ASC LIMIT 1');
  function record(project,commands){
    db.prepare('DELETE FROM timeline_edits WHERE project=? AND applied=0').run(project.id);
    const label=commands.length>1?'批量编辑（'+commands.length+' 项）':
      commands[0].op==='lock'&&!commands[0].locked?'解锁片段':titles[commands[0].op]||'编辑时间线';
    db.prepare('INSERT INTO timeline_edits(project,revision,label,applied) VALUES(?,?,?,1)').run(project.id,project.revision+1,label);
  }
  function replay(p,entry,forward){
    const original=revision(p.id,entry.revision-1), edited=revision(p.id,entry.revision);
    const expected=byId((forward?original:edited).timeline.clips), wanted=byId((forward?edited:original).timeline.clips);
    const live=byId(p.timeline.clips), changes=new Map();
    for(const id of new Set([...expected.keys(),...wanted.keys()])){
      const a=expected.get(id),b=wanted.get(id),current=live.get(id);
      if(same(a,b))continue;
      const reject=()=>{throw conflict('片段「'+id+'」已有其他改动，请保留当前版本或单独修改。');};
      const locked=()=>{throw conflict('片段「'+id+'」已锁定，请先解锁。');};
      if(!a||!b){
        // A deletion must not erase a later edit. An insertion must not reuse an occupied ID.
        if(current?.locked && !a?.locked)locked();
        if(!same(current,a))reject();
        changes.set(id,b??null);
        continue;
      }
      if(!current)reject();
      const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>!same(a[k],b[k])||Object.hasOwn(a,k)!==Object.hasOwn(b,k));
      // The user may reverse the very transaction that locked this clip.
      if(current.locked && !(a.locked&&!b.locked&&keys.includes('locked')))locked();
      if(keys.some(k=>sourceFields.includes(k))&&sourceFields.some(k=>!same(a[k],current[k])))reject();
      const next={...current};
      for(const key of keys){
        if(!same(current[key],a[key])||Object.hasOwn(current,key)!==Object.hasOwn(a,key))reject();
        if(Object.hasOwn(b,key))next[key]=b[key];else delete next[key];
      }
      changes.set(id,next);
    }
    const locked=p.timeline.clips.filter(c=>c.locked&&!changes.has(c.id));
    for(const [id,clip] of changes){
      if(!clip){live.delete(id);continue;}
      if(clip.soundBinding&&(p.settings?.sceneSound===false||clip.styleId&&clip.styleId!==p.style?.id||
        clip.styleVersion!=null&&clip.styleVersion!==p.style?.version))
        throw conflict('恢复音效将与当前工程的声音或风格设置冲突。');
      // New or moved locks on overlapping media take precedence over an old edit.
      for(const other of locked){
        if(!overlaps(clip,other,p.profile))continue;
        const earlier=wanted.get(other.id);
        if(!earlier?.locked||!same(earlier,other))throw conflict('恢复片段「'+id+'」会覆盖已锁定片段「'+other.id+'」。');
      }
      live.set(id,clip);
    }
    const result=sortClips([...live.values()]);
    try{for(const c of changes.values())if(c)validateClip(c,p);}
    catch(e){throw conflict('当前素材或时间线已改变，无法恢复本次编辑。'+e.message);}
    return result;
  }
  function state(p){
    const s={revision:p.revision,canUndo:false,canRedo:false,undoLabel:null,redoLabel:null};
    for(const [query,forward,label,can,why] of [[undo,false,'undoLabel','canUndo','undoReason'],[redo,true,'redoLabel','canRedo','redoReason']]){
      const q=query.get(p.id);if(!q)continue;
      s[label]=q.label;
      try{replay(p,q,forward);s[can]=true;}catch(e){if(e.status!==409)throw e;s[why]=e.message;}
    }
    return s;
  }
  function apply(p,forward){
    const entry=(forward?redo:undo).get(p.id);
    if(!entry)throw conflict(forward?'没有可重做的时间线编辑。':'没有可撤销的时间线编辑。');
    p.timeline.clips=replay(p,entry,forward);
    db.prepare('UPDATE timeline_edits SET applied=? WHERE project=? AND revision=?').run(forward?1:0,p.id,entry.revision);
  }
  return {record,state,apply};
}
