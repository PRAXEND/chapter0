// Only these authored releases belong to the current production catalogue.
// The hash is the canonical portable-style digest of the unmodified published spec.
export const currentStyles=Object.freeze([
  Object.freeze({id:'henry-hot-news',version:8,name:'热点资讯型',sha256:'1eb979b13904f87f48f7e12778b7613f3e9a94887c223ecb5eeb115e6c6afda1',baseline:'2bf2e4e4f5b1afd7ec54ca658a7e34767ecc610a36c8d3a7a90c02dbaacfe45d'}),
  Object.freeze({id:'henry-technical-explainer',version:8,name:'技术科普型',sha256:'f2c5b636abdf3862f43a8cd7edd6ba8485c3fa62537d344c4b487254e5a5c19a',baseline:'eedeb259a8394fef511d9b3528c90c6b1df7d120e8c85f2ac5b4099db0c6f216'})
]);

export function currentStyle(selector) {
  if(!selector || typeof selector!=='object')return undefined;
  return currentStyles.find(s=>s.id===selector.id&&(s.version===selector.version||String(s.version)===selector.version));
}

export function selectedStyle(selector=currentStyles[0]) {
  const style=selector?.version===undefined ? currentStyles.find(s=>s.id===selector?.id) : currentStyle(selector);
  if(!style)throw Object.assign(Error('该风格版本已退出制作目录，请选择热点资讯型 v8 或技术科普型 v8。'),{status:422});
  if(selector.sha256!=null&&selector.sha256!==style.sha256)throw Object.assign(Error('所选风格与发行版本的指纹不同。'),{status:422});
  return {id:style.id,name:style.name,version:style.version};
}
