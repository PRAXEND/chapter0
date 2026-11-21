import path from 'node:path';
import {stat} from 'node:fs/promises';
import {fault} from './project.mjs';

export function draftPreviews(store, media) {
  const active = new Map();
  async function open(project, frame = 0) {
    if (!Number.isSafeInteger(frame) || frame < 0) throw fault('请选择有效的预览帧。');
    const length = project.timeline.clips.reduce((end, c) => Math.max(end, c.start + c.duration), 0);
    if (!length) throw fault('画面尚在编排中。时间线出现片段后即可预览。', 409);
    const span = 6 * project.profile.fps;
    const fromFrame = Math.max(0, Math.min(frame, length - span));
    const toFrame = Math.min(length, fromFrame + span);
    const name = [project.revision, fromFrame, toFrame].join('-') + '.mp4';
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
    await active.get(output).promise;
    return result;
  }
  async function close() {
    const pending = [...active.values()];
    for (const draft of pending) draft.controller.abort();
    await Promise.allSettled(pending.map(draft => draft.promise));
  }
  return {open,close};
}
