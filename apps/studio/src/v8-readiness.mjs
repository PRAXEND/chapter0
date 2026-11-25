import {motionCatalog} from './motion-components.mjs';
import {hasV8Presentation} from './presentation.mjs';
const counts={'henry-hot-news':7,'henry-technical-explainer':6};
export function v8Readiness(style,catalog=motionCatalog){
  if(!hasV8Presentation({style}))return null;
  const declared=[...new Set(style.components.map(c=>c.id))];
  const executable=new Set(catalog.filter(c=>!c.styleId||c.styleId===style.id).map(c=>c.id));
  const missing=declared.filter(id=>!executable.has(id)),problems=[];
  const expected=counts[style.id];
  if(declared.length!==expected)problems.push('风格只声明了 '+declared.length+' / '+expected+' 个原动效');
  if(missing.length)problems.push('缺少可执行动效 '+missing.join('、'));
  if(!style.baseline?.verified||!style.baseline?.available)problems.push('基准片缺失或文件指纹不符');
  if(!style.storyboardContract||!style.recipeSections?.length)problems.push('分镜规则或风格原始章节缺失');
  return {ready:!problems.length,expected,executable:declared.length-missing.length,missing,problems,baselineVerified:!!style.baseline?.verified,styleSha256:style.sha256,baselineSha256:style.baseline?.sha256};
}
