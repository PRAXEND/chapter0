// The trusted JSX currently uses only divs, CSS and text. User copy is always an escaped text node.
export function h(tag,attrs,...children){return {tag,attrs,children};}
export function interpolate(f,x,y,options={}){
  if(f<x[0]&&options.extrapolateLeft==='clamp')return y[0];
  if(f>x.at(-1)&&options.extrapolateRight==='clamp')return y.at(-1);
  let i=0;while(i<x.length-2&&f>x[i+1])i++;
  return x[i+1]===x[i]?y[i+1]:y[i]+(y[i+1]-y[i])*(f-x[i])/(x[i+1]-x[i]);
}
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const unitless=new Set(['fontWeight','opacity','flex','lineHeight']);
function css(style){
  return Object.entries(style||{}).map(([property,value])=>{
    const key=property.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());
    const raw=typeof value==='number'&&!unitless.has(property)&&value!==0?value+'px':String(value);
    // A model-supplied font name is one CSS property, never a declaration list or a resource.
    if(/[;{}<>\u0000-\u001f]/.test(raw)||/url\s*\(/i.test(raw)) return '';
    return key+':'+raw;
  }).filter(Boolean).join(';');
}
export function serialize(node){
  if(Array.isArray(node))return node.map(serialize).join('');
  if(node==null||typeof node==='boolean')return '';
  if(typeof node==='string'||typeof node==='number')return escape(node);
  if(node.tag!=='div')throw Error('未识别的受信动效元素');
  return '<div style="'+escape(css(node.attrs?.style))+'">'+node.children.map(serialize).join('')+'</div>';
}
