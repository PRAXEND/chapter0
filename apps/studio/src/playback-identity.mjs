import {createHash} from 'node:crypto';
import {portraitLayout,headline} from './presentation.mjs';

export const timelineFrames=p=>(p.timeline?.clips||[]).reduce((n,c)=>c.hidden||c.enabled===false?n:Math.max(n,c.start+c.duration),0);
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
export function playbackIdentity(p){
  // Only visible/enabled clips contribute. An unrelated import, lock or publication
  // copy edit can coexist with an identical frozen picture and mix.
  const clips=(p.timeline?.clips||[]).filter(c=>!c.hidden&&c.enabled!==false).map(({locked,...clip})=>clip);
  const ids=new Set(clips.map(c=>c.assetId).filter(Boolean));
  const sources=(p.assets||[]).filter(a=>ids.has(a.id)).map(a=>[a.id,a.sha256,a.kind]).sort((a,b)=>a[0].localeCompare(b[0]));
  const layout=portraitLayout(p);
  const graph=[p.profile,clips,sources,p.settings?.captionDisplay==='sidecar',layout&&[layout.id,headline(p)]];
  return createHash('sha256').update(JSON.stringify(canonical(graph))).digest('hex');
}
