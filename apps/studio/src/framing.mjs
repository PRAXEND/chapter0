import {focusKeys} from '../www/clip-automation.js';
import {visiblePanes,compositionOrder} from './viewport.mjs';
// Coordinates refer to the displayed source before any cut, including its display rotation.
export function validFraming(framing,duration=Infinity) {
  function validPoint(point) {
    return point && [point.x, point.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
      Number.isFinite(point.zoom) && point.zoom >= 1 && point.zoom <= 4;
  }
  return Boolean(validPoint(framing?.from) && (framing.to == null || validPoint(framing.to)) &&
    (framing.keys==null || Array.isArray(framing.keys)&&framing.keys.length<=30&&framing.keys.every((p,i,keys)=>
      validPoint(p)&&Number.isSafeInteger(p.frame)&&p.frame>0&&p.frame<duration-1&&(!i||keys[i-1].frame<p.frame))));
}

export function transitionEnvelope(clip) {
  const t=clip.transition;
  const duration=['fade','crossfade','dissolve','wipe-right','whip-pan','organic-dissolve'].includes(t?.type) ? Math.max(0,Math.min(clip.duration,Math.floor(t.duration||0))) : 0;
  const offset=Number.isSafeInteger(t?.offsetFrames) ? Math.max(0,t.offsetFrames) : 0;
  const total=Math.max(offset+duration,Number.isSafeInteger(t?.totalFrames)?t.totalFrames:0);
  return {duration,offset,total};
}

export function framingFilter(clip, asset, profile, first) {
  if (!validFraming(clip.framing,clip.duration)) throw new Error('取景中心须在原图内，放大倍率须为 1–4。');
  const {from, to = from} = clip.framing;
  const {width, height, fps} = profile;
  const squareWidth = Math.max(2, 2 * Math.round(asset.width * (asset.pixelAspect || 1) / 2));
  const sourceHeight = Math.max(2, 2 * Math.floor(asset.height / 2));
  const cropW = Math.min(squareWidth, Math.max(2, 2 * Math.floor(sourceHeight * width / height / 2)));
  const cropH = Math.min(sourceHeight, Math.max(2, 2 * Math.floor(squareWidth * height / width / 2)));
  const num = n => String(Number(n.toFixed(8)));
  function coord(key, counter) {
    if(clip.framing.keys?.length){
      const keys=focusKeys(clip),counterAt='('+counter+'+'+(first-clip.start)+')';
      let value=num(keys.at(-1)[key]);
      for(let i=keys.length-1;i>0;i--){
        const a=keys[i-1],b=keys[i];
        const part=a[key]===b[key]?num(a[key]):'('+num(a[key])+'+'+num(b[key]-a[key])+'*('+counterAt+'-'+a.frame+')/'+(b.frame-a.frame)+')';
        value='if(lt('+counterAt+','+b.frame+'),'+part+','+value+')';
      }
      return value;
    }
    if (!to || from[key] === to[key] || clip.duration === 1) return num(from[key]);
    return `(${num(from[key])}+${num(to[key] - from[key])}*(${counter}+${first - clip.start})/${clip.duration - 1})`;
  }
  // First extract the largest source window with the output aspect. It follows the focus
  // so edge details remain reachable. Zoom within that window, retaining original pixels.
  const inside = (key, fraction, size) => {
    const pos = coord(key, 'on'), span = num(fraction);
    return `clip(((${pos}-clip(${pos}-${span}/2,0,1-${span}))/${span}-0.5/zoom)*${size},0,${size}*(1-1/zoom))`;
  };
  const squarePixels = squareWidth !== asset.width || (asset.pixelAspect && asset.pixelAspect !== 1)
    ? `scale=${squareWidth}:${sourceHeight},setsar=1,` : '';
  return squarePixels +
    `crop=w=${cropW}:h=${cropH}:x='clip(${coord('x','n')}*iw-ow/2,0,iw-ow)':y='clip(${coord('y','n')}*ih-oh/2,0,ih-oh)':exact=1,` +
    `zoompan=z='${coord('zoom','on')}':x='${inside('x',cropW/squareWidth,'iw')}':y='${inside('y',cropH/sourceHeight,'ih')}':d=1:s=${width}x${height}:fps=${fps}`;
}

// Shots use the same start order as the renderer. The last active shot covers earlier ones.
export function visibleWindows(shots, profile) {
  shots=compositionOrder(shots,s=>s.clip);
  const edges = [...new Set(shots.flatMap(({clip}) => [clip.start, clip.start + clip.duration]))].sort((a,b) => a-b);
  const windows = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i], to = edges[i+1] - 1;
    const active = shots.filter(({clip}) => clip.start <= from && clip.start + clip.duration > from);
    if (active.some(s=>s.clip.viewport||s.clip.mask)) {
      for (const pane of visiblePanes(active,profile)) windows.push({from,to,...pane});
      continue;
    }
    const shot = active.at(-1);
    if (!shot) continue;
    const previous = windows.at(-1);
    if (previous?.shot === shot && !previous.regions && previous.to + 1 === from) previous.to = to;
    else windows.push({from, to, shot});
  }
  return windows;
}
