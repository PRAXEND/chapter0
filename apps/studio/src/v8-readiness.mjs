import {currentStyle} from './style-catalog.mjs';
import {motionCatalog} from './motion-components.mjs';
import {hasV8Presentation} from './presentation.mjs';
import {components as renderers,sourceHashes} from './motion-jsx.generated.mjs';
import {motionSources} from './motion-source-files.mjs';
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
  const {sha256:recipe,baseline:reference}=currentStyle(style);
  if(style.sha256!==recipe||style.baseline?.sha256!==reference)problems.push('风格规则或基准片与内置 v8 的版本指纹不符');
  if(declared.length!==expected)problems.push('风格只声明了 '+declared.length+' / '+expected+' 个原动效');
  if(missing.length)problems.push('缺少可执行动效 '+missing.join('、'));
  if(!style.baseline?.verified||!style.baseline?.available)problems.push('基准片缺失或文件指纹不符');
  if(!style.storyboardContract||!style.recipeSections?.length)problems.push('分镜规则或风格原始章节缺失');
  return {ready:!problems.length,expected,executable:declared.length-missing.length,missing,problems,baselineVerified:!!style.baseline?.verified,styleSha256:style.sha256,baselineSha256:style.baseline?.sha256};
}
