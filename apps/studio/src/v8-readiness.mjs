import {motionCatalog} from './motion-components.mjs';
import {hasV8Presentation} from './presentation.mjs';
import {components as renderers,sourceHashes} from './motion-jsx.generated.mjs';
import {motionSources} from './motion-source-files.mjs';
const approved={
  'henry-hot-news':['1eb979b13904f87f48f7e12778b7613f3e9a94887c223ecb5eeb115e6c6afda1','2bf2e4e4f5b1afd7ec54ca658a7e34767ecc610a36c8d3a7a90c02dbaacfe45d'],
  'henry-technical-explainer':['f2c5b636abdf3862f43a8cd7edd6ba8485c3fa62537d344c4b487254e5a5c19a','eedeb259a8394fef511d9b3528c90c6b1df7d120e8c85f2ac5b4099db0c6f216']
};
export function v8Readiness(style,catalog=motionCatalog){
  if(!hasV8Presentation({style}))return null;
  const declared=[...new Set(style.components.map(c=>c.id))];
  const originals=motionSources.filter(s=>s.styleId===style.id&&s.styleVersion===style.version);
  const executable=new Set(catalog.filter(c=>{
    const i=c.index-1,src=motionSources[i];
    return src&&src.id===c.id&&src.styleId===style.id&&c.styleId===style.id&&c.styleVersion===style.version&&
      typeof renderers[i]==='function'&&/^[0-9a-f]{64}$/.test(sourceHashes[i]);
  }).map(c=>c.id));
  const missing=declared.filter(id=>!executable.has(id)),problems=[];
  const expected=originals.length;
  const [recipe,reference]=approved[style.id];
  if(style.sha256!==recipe||style.baseline?.sha256!==reference)problems.push('风格规则或基准片与内置 v8 的版本指纹不符');
  if(declared.length!==expected)problems.push('风格只声明了 '+declared.length+' / '+expected+' 个原动效');
  if(missing.length)problems.push('缺少可执行动效 '+missing.join('、'));
  if(!style.baseline?.verified||!style.baseline?.available)problems.push('基准片缺失或文件指纹不符');
  if(!style.storyboardContract||!style.recipeSections?.length)problems.push('分镜规则或风格原始章节缺失');
  return {ready:!problems.length,expected,executable:declared.length-missing.length,missing,problems,baselineVerified:!!style.baseline?.verified,styleSha256:style.sha256,baselineSha256:style.baseline?.sha256};
}
