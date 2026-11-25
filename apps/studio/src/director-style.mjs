// The public editor uses the compact style. The director can page through the pinned
// recipe without shipping an entire historical editor session in every tool call.
export function continuousStyle(style) {
  return Boolean(style?.storyboardContract &&
    style.templates?.some(t=>['step-reveal','action-result'].includes(t.id||t))) ||
    (Number(style?.version)>=8 && ['henry-hot-news','henry-technical-explainer'].includes(style.id));
}

export function recipeSections(spec) {
  const sections=Object.fromEntries(['description','adaptation','rules','material_requirements','current_directions',
    'storyboard_contract','preferences','knownExceptions','unknown_dimensions'].filter(k=>spec[k]!==undefined).map(k=>[k,spec[k]]));
  // Keep distinct names when a portable style includes both source formats.
  for(const key of ['reproduction_bundle','reproduction_blueprint']){
    for(const [name,value] of Object.entries(spec[key]||{}))sections[key+'.'+name]=value;
  }
  return sections;
}

const privateKey=/(?:path|locator|file_?url|editor_?url|source_?url|master_scope|original_scope|token|credential|private_?key|authorization|cookie|base64|data_?url)$/i;
export function publicStyleValue(v){
  if(typeof v==='string')return v.replace(/(?:file:\/\/)?\/(?:Users|private|Volumes|home|mnt|tmp|var)\/[^\s，。；)\]"']+/gu,'[本地参考]')
    .replace(/data:[^\s,;]+(?:;[^,\s]*)?,[A-Za-z0-9+/=]{32,}/gi,'[媒体保存在本机]')
    .replace(/https?:\/\/[^\s，。；)"'\]]+/gu,s=>{
      try{const u=new URL(s);if(u.username||u.password)return '[私有地址]';u.search='';u.hash='';return u.href;}catch{return '[参考链接]';}
    });
  if(Array.isArray(v))return v.map(publicStyleValue);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!privateKey.test(k)&&!['__proto__','constructor','prototype'].includes(k)).map(([k,x])=>[k,publicStyleValue(x)]));
  return v;
}

export function stylePage(sections,name,offset=0){
  if(typeof name!=='string'||!Object.hasOwn(sections,name))throw Error('请选择当前风格目录中已登记的章节。');
  if(!Number.isSafeInteger(offset)||offset<0)throw Error('风格章节偏移需要非负整数。');
  const json=JSON.stringify(publicStyleValue(sections[name]));
  if(offset>json.length)throw Error('风格章节偏移超出正文。');
  const next=Math.min(json.length,offset+9000);
  return {section:name,offset,chars:json.length,text:json.slice(offset,next),nextOffset:next<json.length?next:null};
}
