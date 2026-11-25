// Map project time while keeping relative cut points inside the rewritten sentence.
export function replacementClock(start, oldFrames, newFrames) {
  return frame => frame <= start ? frame : frame >= start + oldFrames ? frame + newFrames - oldFrames :
    start + Math.round((frame - start) * newFrames / oldFrames);
}
export function replacementEdits(project, voice, group, frames) {
  const at = replacementClock(voice.start, voice.duration, frames);
  const changes = [];
  for (const clip of project.timeline.clips) {
    if (group.has(clip.id)) continue;
    const start = at(clip.start);
    const oldEnd = clip.start + clip.duration;
    let duration = at(oldEnd) - start;
    if (clip.role === 'sfx') duration = clip.duration;
    if (start === clip.start && duration === clip.duration) continue;
    if (clip.locked) throw Error('新台词会移动已锁定的片段「' + clip.id + '」。');
    if (duration <= 0) throw Error('新台词过短，无法保留镜头「' + clip.id + '」的一个完整画格。');
    const update = { start, duration };
    const asset = project.assets.find(a => a.id === clip.assetId);
    if (duration !== clip.duration) {
      if (clip.track === 'narration') throw Error('此处叠有另一句独立旁白，请改写整个句群。');
      if (clip.track === 'video' && asset?.kind === 'video') {
        // Retime only the original visible source window. Never read past it or freeze its last frame.
        update.speed = (clip.speed || 1) * clip.duration / duration;
        if (update.speed < .125 || update.speed > 8) throw Error('镜头变速超出可编辑范围，请重新选镜。');
      }
      if (clip.track === 'music' && asset && (clip.sourceIn || 0) + duration * (clip.speed || 1) > Math.ceil(asset.duration * project.profile.fps) + 1)
        throw Error('配乐「' + clip.id + '」已到源文件末尾，请为新增时长选择音乐区间。');
      const local = f => Math.min(duration, Math.max(0, at(clip.start + f) - start));
      if (clip.keyframes) update.keyframes = clip.keyframes.map(k => ({...k,frame:local(k.frame)}));
      if (clip.motion?.cueFrames) {
        const cues = clip.motion.cueFrames.map(f => Math.min(duration - 1, local(f)));
        if (cues.some((f,i) => i && f <= cues[i-1])) throw Error('新台词过短，无法区分动效的各个落点。');
        update.motion = {...clip.motion, cueFrames:cues};
      }
      if (clip.transition?.duration) update.transition = {...clip.transition,duration:Math.min(duration, local(clip.transition.duration))};
    }
    if (Number.isInteger(clip.actionFrame)) update.actionFrame = at(clip.actionFrame);
    changes.push({op:'update',id:clip.id,changes:update});
  }
  return changes;
}
