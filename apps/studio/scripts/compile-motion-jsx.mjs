// Refresh after reviewing the two pinned packs. TypeScript is a maintainer dependency only.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {motionSources} from '../src/motion-source-files.mjs';
const ts=createRequire(import.meta.url)(process.argv[2]||'typescript');
const root=new URL('../../../user-packs/henry-video-styles/',import.meta.url);
const hot=JSON.parse(await readFile(new URL('styles/henry-hot-news-v8.json',root))).reproduction_bundle;

// The archive redacted long fractional matrix coefficients. Reconstruct its exact homography
// from the four measured stage corners and the original component's transform origin and box.
function surfaceMatrix(){
  const placement=hot.native_items.find(i=>i.asset===hot.specific_edit_recipe.projection_asset);
  const [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]=hot.specific_edit_recipe.projection_corners
    .map(([x,y])=>[x-placement.properties.left,y-placement.properties.top]);
  const dx=x0-x1+x2-x3,dy=y0-y1+y2-y3, det=(x1-x2)*(y3-y2)-(x3-x2)*(y1-y2);
  const g=(dx*(y3-y2)-(x3-x2)*dy)/det, h=((x1-x2)*dy-dx*(y1-y2))/det;
  const values=[(x1-x0+g*x1)/500,(y1-y0+g*y1)/500,0,g/500,(x3-x0+h*x3)/150,(y3-y0+h*y3)/150,0,h/150,0,0,1,0,x0,y0,0,1];
  if(!values.every(Number.isFinite))throw Error('投影原件的四角无效');
  return 'matrix3d('+values.join(',')+')';
}
const compiled=[],hashes=[];
for(const [i,spec] of motionSources.entries()){
  const name=spec.folder+'/'+spec.file;
  let source=await readFile(new URL('reproduction/'+name,root),'utf8');
  hashes.push(createHash('sha256').update(source).digest('hex'));
  if(spec.id==='hot-surface-projection' && source.includes('matrix3d(0.ref-')){
    const matrices=source.match(/matrix3d\([0-9a-f.,ref-]+\)/g);
    if(matrices?.length!==1 || !source.includes('width:500,height:150,transformOrigin:"0px 0px"'))throw Error('台面投影原稿已改变，请重新核对四角');
    source=source.replace(matrices[0],surfaceMatrix());
  }
  const input='function component'+(i+1)+'(item,frame,duration){\n'+
    'const useCurrentFrame=()=>frame;const useVideoConfig=()=>({fps:30,durationInFrames:duration});\n'+
    source+'\nreturn Component({item});\n}';
  const result=ts.transpileModule(input,{fileName:name,reportDiagnostics:true,compilerOptions:{
    target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,jsxFactory:'h',removeComments:false}});
  if(result.diagnostics.length)throw Error(name+' '+result.diagnostics.map(d=>d.messageText).join(' '));
  compiled.push(result.outputText.trim());
}
const header="// Generated from the shipped Henry JSX sources by scripts/compile-motion-jsx.mjs.\nimport {h, interpolate} from './motion-dom.mjs';\n";
await writeFile(new URL('../src/motion-jsx.generated.mjs',import.meta.url),header+'export const sourceHashes = '+JSON.stringify(hashes,null,2)+';\n'+
  compiled.join('\n\n')+'\nexport const components = ['+compiled.map((_,i)=>'component'+(i+1)).join(', ')+'];\n');
