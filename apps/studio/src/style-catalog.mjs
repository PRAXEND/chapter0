// Only these authored releases belong to the current production catalogue.
// The hash is the canonical portable-style digest of the unmodified published spec.
export const currentStyles=Object.freeze([
  Object.freeze({id:'henry-hot-news',version:8,name:'热点资讯型',sha256:'1eb979b13904f87f48f7e12778b7613f3e9a94887c223ecb5eeb115e6c6afda1'}),
  Object.freeze({id:'henry-technical-explainer',version:8,name:'技术科普型',sha256:'f2c5b636abdf3862f43a8cd7edd6ba8485c3fa62537d344c4b487254e5a5c19a'})
]);

export function currentStyle(selector) {
  if(!selector || typeof selector!=='object')return undefined;
  return currentStyles.find(s=>s.id===selector.id&&(s.version===selector.version||String(s.version)===selector.version));
}

export function selectedStyle(selector=currentStyles[0]) {
  const style=currentStyle(selector?.version===undefined ? {...selector,version:currentStyles.find(s=>s.id===selector?.id)?.version} : selector);
  if(!style)throw Object.assign(Error('该风格版本已退出制作目录，请选择热点资讯型 v8 或技术科普型 v8。'),{status:422});
  return {id:style.id,name:style.name,version:style.version};
}
