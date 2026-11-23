import path from 'node:path';
import {stat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {fault} from './project.mjs';

// Projects can be reopened at the same revision after upgrading the compositor.
const inputs=['./media.mjs','./motion-components.mjs','./motion-dom.mjs','./motion-render.mjs','./motion-font.mjs',
  './motion-jsx.generated.mjs','../scripts/motion-webkit.swift','../www/motion-clock.js',
  './framing.mjs','./graphic-keys.mjs','./text-tracks.mjs','./polygon.mjs','./viewport.mjs'];
const rendererVersion=Promise.all(inputs.map(name=>readFile(new URL(name,import.meta.url)))).then(parts=>{
  const hash=createHash('sha256').update(os.release());
  for(const bytes of parts)hash.update(bytes);
  return hash.digest('hex').slice(0,16);
});

export function draftPreviews(store, media) {
  const active = new Map();
  async function open(project, frame = 0, signal) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(frame) || frame < 0) throw fault('请选择有效的预览帧。');
    const length = project.timeline.clips.filter(c=>!c.hidden&&c.enabled!==false).reduce((end, c) => Math.max(end, c.start + c.duration), 0);
    if (!length) throw fault('画面尚在编排中。时间线出现片段后即可预览。', 409);
    const span = 6 * project.profile.fps;
    const fromFrame = Math.max(0, Math.min(frame, length - span));
    const toFrame = Math.min(length, fromFrame + span);
    const name = [await rendererVersion, project.revision, fromFrame, toFrame].join('-') + '.mp4';
    const directory = store.paths(project.id).cache;
    const output = path.join(directory, 'drafts', name);
    const result = {name, revision:project.revision, fromFrame, toFrame};
    if ((await stat(output).catch(() => null))?.size) return result;
    if (!active.has(output)) {
      const controller = new AbortController();
      const promise = media.renderProject(project, {directory, output, preview:true, window:{fromFrame,toFrame}, signal:controller.signal})
        .finally(() => active.delete(output));
      active.set(output, {controller,promise});
    }
    const work=active.get(output).promise;
    if(signal){
      let abort;
      try{
        await Promise.race([work,new Promise((_,reject)=>{
          abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
          if(signal.aborted)abort();
        })]);
      }finally{signal.removeEventListener('abort',abort);}
    }else await work;
    return result;
  }
  async function close() {
    const pending = [...active.values()];
    for (const draft of pending) draft.controller.abort();
    await Promise.allSettled(pending.map(draft => draft.promise));
  }
  return {open,close};
}
