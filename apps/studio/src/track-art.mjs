import path from 'node:path';
import {mkdir, rename, rm, stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ffBase, inputArgs, requiredTool, run} from './media-runtime.mjs';
import {fault} from './project.mjs';

// Immutable source media can share thumbnails between trims and project revisions.
export function trackArtwork() {
  const pending = new Map();
  let tail = Promise.resolve();
  return async function artwork(cache, asset, type, milliseconds) {
    const wave = type === 'waveform';
    if (wave ? !asset.hasAudio : !['video','image'].includes(asset.kind)) throw fault('素材没有此轨道的预览。',404);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw fault('无效的原片时间。');
    const at = wave || asset.kind === 'image' ? 0 : Math.min(Math.round(milliseconds/100)*100, Math.max(0,Math.floor((asset.duration-.12)*1000)));
    const directory=path.join(cache,'track-art-v1');
    const file=path.join(directory,asset.sha256+'-'+type+'-'+at+(wave?'.png':'.jpg'));
    if ((await stat(file).catch(()=>null))?.size) return file;
    if (pending.has(file)) return pending.get(file);
    if (pending.size >= 160) throw fault('轨道缩略图正在载入。',503);
    const build = async () => {
      await mkdir(directory,{recursive:true});
      const temp=path.join(directory,randomUUID()+path.extname(file));
      try {
        const ffmpeg=await requiredTool('ffmpeg');
        const rate=Math.max(32, Math.min(3000, Math.floor(3000000/Math.max(1,asset.duration))));
        const args=wave ? [...inputArgs(asset.path),'-filter_complex','[0:a:0]aformat=channel_layouts=mono,aresample='+rate+',showwavespic=s=1200x38:colors=white:draw=full[v]','-map','[v]'] :
          [...(at?['-ss',String(at/1000)]:[]),...inputArgs(asset.path),'-map','0:v:0','-vf','scale=112:56:force_original_aspect_ratio=increase,crop=112:56','-q:v','5'];
        await run(ffmpeg,[...ffBase,...args,'-frames:v','1','-threads','1',temp]);
        await rename(temp,file);return file;
      } finally {await rm(temp,{force:true});}
    };
    const work=tail.then(build);
    tail=work.catch(()=>{});
    pending.set(file,work);
    try{return await work;}finally{pending.delete(file);}
  };
}
