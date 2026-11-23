// Refresh the release module after reviewing changes to the six trusted JSX sources.
// TypeScript is required only for this maintenance command. Production uses the checked-in module.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const ts=require(process.argv[2]||'typescript');
const sourceRoot=new URL('../../../user-packs/henry-video-styles/reproduction/technical-explainer/',import.meta.url);
const compiled=[],hashes=[];
for(let index=1;index<=6;index++){
  const name='mg-'+String(index).padStart(2,'0')+'.jsx';
  const source=await readFile(new URL(name,sourceRoot),'utf8');
  hashes.push(createHash('sha256').update(source).digest('hex'));
  const input='function component'+index+'(item,frame,duration){\n'+
    'const useCurrentFrame=()=>frame;const useVideoConfig=()=>({fps:30,durationInFrames:duration});\n'+
    source+'\nreturn Component({item});\n}';
  const result=ts.transpileModule(input,{fileName:name,reportDiagnostics:true,compilerOptions:{
    target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,jsxFactory:'h',removeComments:false}});
  if(result.diagnostics.length)throw Error(name+' '+result.diagnostics.map(d=>d.messageText).join(' '));
  compiled.push(result.outputText.trim());
}
const header="// Generated from the six shipped Henry JSX components by scripts/compile-motion-jsx.mjs.\nimport {h, interpolate} from './motion-dom.mjs';\n";
await writeFile(new URL('../src/motion-jsx.generated.mjs',import.meta.url),header+'export const sourceHashes = '+JSON.stringify(hashes,null,2)+';\n'+
  compiled.join('\n\n')+'\nexport const components = ['+compiled.map((_,i)=>'component'+(i+1)).join(', ')+'];\n');
