import {exposedMaskRegions} from './clip-mask.mjs';
// Normalized stage coordinates use a top-left origin. Snap adjoining boundaries
// together on the output's 4:2:0 chroma grid so two halves never leave a seam.
export function viewportRect(viewport, profile) {
  if (viewport == null) return { x: 0, y: 0, width: profile.width, height: profile.height };
  const { x, y, width, height } = viewport;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > 1 + Number.EPSILON || y + height > 1 + Number.EPSILON)
    throw Error('分屏窗口需要画布内的归一化左上角和正数宽高。');
  const edge = (position, size) => 2 * Math.round(position * size / 2);
  const left = edge(x, profile.width), top = edge(y, profile.height);
  const w = edge(x + width, profile.width) - left, h = edge(y + height, profile.height) - top;
  if (w < 2 || h < 2) throw Error('分屏窗口在当前画幅中至少需要 2×2 个像素。');
  return { x: left, y: top, width: w, height: h };
}

const full = {x:0,y:0,width:1,height:1};
export function normalizedViewport(viewport, profile) {
  if (!profile || !viewport) return viewport || full;
  const r = viewportRect(viewport, profile);
  return {x:r.x/profile.width,y:r.y/profile.height,width:r.width/profile.width,height:r.height/profile.height};
}

// Splitting should not raise a previously obscured shot above a later inset.
// The offset lets a subsequent intentional move still change its stacking time.
export function compositionOrder(items, getClip=item=>item) {
  const index=new Map(items.map((item,i)=>[getClip(item).id,i]));
  const key=c=>c.start-(c.stackOrigin?.offsetFrames||0);
  return [...items].sort((a,b)=>{
    const ca=getClip(a), cb=getClip(b), time=key(ca)-key(cb);
    if(time) return time;
    const idA=ca.stackOrigin?.id||ca.id, idB=cb.stackOrigin?.id||cb.id;
    if(index.has(idA)&&index.has(idB))return index.get(idA)-index.get(idB);
    return String(idA).localeCompare(String(idB));
  });
}

export function overlapOnStage(a,b,profile) {
  if(a.track!=='video'||(!a.viewport&&!b.viewport))return true;
  const x=viewportRect(a.viewport,profile), y=viewportRect(b.viewport,profile);
  return x.x<y.x+y.width&&y.x<x.x+x.width&&x.y<y.y+y.height&&y.y<x.y+x.height;
}

function uncovered(area, mask) {
  const x = Math.max(area.x,mask.x), y = Math.max(area.y,mask.y);
  const endX = area.x+area.width, endY = area.y+area.height;
  const right = Math.min(endX,mask.x+mask.width), bottom = Math.min(endY,mask.y+mask.height);
  if (right<=x || bottom<=y) return [area];
  return [
    {x:area.x,y:area.y,width:area.width,height:y-area.y},
    {x:area.x,y:bottom,width:area.width,height:endY-bottom},
    {x:area.x,y,width:x-area.x,height:bottom-y},
    {x:right,y,width:endX-right,height:bottom-y},
  ].filter(r=>r.width>1e-9 && r.height>1e-9);
}

// Work down through the stack. Keep the actual exposed parts of a backdrop
// so movement or a source in a different pane cannot be credited to this shot.
export function visiblePanes(shots, profile) {
  if(shots.some(s=>s.clip.mask))return exposedMaskRegions(shots,profile,normalizedViewport);
  const result=[], covered=[];
  for (const shot of [...shots].reverse()) {
    const rect=normalizedViewport(shot.clip.viewport,profile);
    const regions=covered.reduce((areas,mask)=>areas.flatMap(area=>uncovered(area,mask)),[rect]);
    if (!regions.length) continue;
    result.unshift({shot,regions});
    if (rect.width===1 && rect.height===1) break;
    covered.push(rect);
  }
  return result;
}
