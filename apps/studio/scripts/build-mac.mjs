import {execFileSync} from 'node:child_process';
import {access,chmod,copyFile,cp,mkdir,mkdtemp,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {motionSources} from '../src/motion-source-files.mjs';
import {sourceHashes} from '../src/motion-jsx.generated.mjs';
import {verifyMotionFont} from '../src/motion-font.mjs';
import {bundleStyles} from './bundle-styles.mjs';
import {prepareCodex,codexVersion} from './prepare-codex.mjs';
import {mediaTool} from '../src/media.mjs';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), repo=path.resolve(base,'../..');
const cache=path.join(os.homedir(),'Library/Caches/VideoStudioBuild');
const quality=process.env.STUDIO_BUILD_CHANNEL==='quality';
const bundleId='studio.local.videoworkbench'+(quality?'.quality':'');
const displayName=quality?'Video Studio 质量验证版':'Video Studio';
const toolEnv={...process.env};
try{
  await access(path.join(cache,'cargo/bin/cargo'));toolEnv.CARGO_HOME||=path.join(cache,'cargo');toolEnv.RUSTUP_HOME||=path.join(cache,'rustup');
  toolEnv.PATH=path.join(toolEnv.CARGO_HOME,'bin')+':'+toolEnv.PATH;
}catch{}
const exec=(name,args,options={})=>execFileSync(name,args,{stdio:'inherit',env:toolEnv,...options});
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('此发行包需要 Apple Silicon Mac。');
exec('cargo',['build','--release','--locked','--jobs','3'],{cwd:path.join(base,'src-tauri')});
const dist=path.resolve(process.env.STUDIO_DIST||path.join(base,'dist',quality?'quality':''));await mkdir(dist,{recursive:true});
await mkdir(cache,{recursive:true});const staging=await mkdtemp(path.join(cache,'mac-bundle-'));
const app=path.join(staging,'Video Studio.app'),contents=path.join(app,'Contents'),resources=path.join(contents,'Resources');
const clone=async(from,to)=>{await mkdir(path.dirname(to),{recursive:true});await copyFile(from,to,constants.COPYFILE_FICLONE);};
try{
  const binDir=path.join(resources,'bin');
  await mkdir(binDir,{recursive:true});
  await clone(path.join(base,'src-tauri/target/release/video-studio'),path.join(contents,'MacOS/video-studio'));
  await clone(path.join(base,'src-tauri/icons/icon.icns'),path.join(resources,'VideoStudio.icns'));
  for(const sub of ['src','www','scripts'])await cp(path.join(base,sub),path.join(resources,'apps/studio',sub),{recursive:true,filter:source=>!source.endsWith('build-mac.mjs')&&!source.includes('__pycache__')});
  const legacy=path.join('plugins','video-studio','workbench','media.mjs');
  await clone(path.join(repo,legacy),path.join(resources,legacy));
  await bundleStyles(repo,resources);
  const motionPack=path.join(resources,'user-packs','henry-video-styles','reproduction');
  for(const [i,hash] of sourceHashes.entries()){
    const {folder,file}=motionSources[i];const name=path.join(folder,file);
    if(createHash('sha256').update(await readFile(path.join(motionPack,name))).digest('hex')!==hash)
      throw Error(name+' 源码已变更，请审阅后重新编译发行组件。');
  }
  const helper=path.join(binDir,'motion-webkit');
  exec('/usr/bin/xcrun',['swiftc','-parse-as-library','-O',path.join(base,'scripts','motion-webkit.swift'),'-o',helper],
    {env:{...toolEnv,MACOSX_DEPLOYMENT_TARGET:'13.5'}});
  exec('/usr/bin/codesign',['--force','--sign',process.env.STUDIO_SIGN_IDENTITY||'-',helper]);
  const githubMedia=path.join(binDir,'github-media');
  exec('/usr/bin/xcrun',['swiftc','-O',path.join(base,'scripts','github-media.swift'),'-o',githubMedia],
    {env:{...toolEnv,MACOSX_DEPLOYMENT_TARGET:'13.5'}});
  exec('/usr/bin/codesign',['--force','--sign',process.env.STUDIO_SIGN_IDENTITY||'-',githubMedia]);
  await clone(process.execPath,path.join(binDir,'node'));
  for(const name of ['ffmpeg','ffprobe','whisper-cli']){
    const tool=await mediaTool(name);if(!tool){if(name==='whisper-cli')continue;throw Error('发行需要可用的 '+name);}
    await clone(tool,path.join(binDir,name));
  }
  const codex=await prepareCodex();
  // Keep the official executable and its adjacent support binaries in the package layout.
  const vendor=codex.slice(0,codex.indexOf('/vendor/')+8)+'aarch64-apple-darwin';
  await cp(vendor,path.join(resources,'codex-runtime'),{recursive:true,mode:constants.COPYFILE_FICLONE});
  const codexRel=path.relative(vendor,codex);
  await writeFile(path.join(resources,'codex-executable.txt'),codexRel);
  const notices=path.join(resources,'licenses');await mkdir(notices,{recursive:true});
  const motionTypeface=await verifyMotionFont();
  if(createHash('sha256').update(await readFile(motionTypeface.license)).digest('hex')!==motionTypeface.licenseSha256)
    throw Error('Noto Sans SC 的授权文件未通过指纹校验。');
  await clone(motionTypeface.license,path.join(notices,'Noto-Sans-SC-OFL.txt'));
  const nodeLicense=path.join(path.dirname(process.execPath),'../LICENSE');await clone(nodeLicense,path.join(notices,'Node.txt'));
  for(const name of ['ffmpeg','ffprobe']){
    const license=execFileSync(path.join(binDir,name),['-L'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});await writeFile(path.join(notices,name+'.txt'),license);
  }
  await writeFile(path.join(notices,'components.txt'),'Node.js · https://nodejs.org/\\nFFmpeg · https://ffmpeg.org/\\nCodex CLI '+codexVersion+' · Apache-2.0 · https://github.com/openai/codex\\nwhisper.cpp · MIT · https://github.com/ggml-org/whisper.cpp\\n'.replaceAll('\\n','\n'));
  if(quality)await writeFile(path.join(resources,'quality-channel'),'quality\n');
  const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>${displayName}</string><key>CFBundleDisplayName</key><string>${displayName}</string>
<key>CFBundleExecutable</key><string>video-studio</string><key>CFBundleIconFile</key><string>VideoStudio</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>CFBundleVersion</key><string>1</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>13.5</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`;
  await writeFile(path.join(contents,'Info.plist'),plist);
  // macOS refuses to sign Finder metadata copied from a File Provider checkout.
  for(const name of ['com.apple.FinderInfo','com.apple.ResourceFork']){
    try{execFileSync('/usr/bin/xattr',['-r','-d',name,app],{stdio:'pipe'});}catch(e){if(!String(e.stderr||'').includes('No such xattr'))throw e;}
  }
  exec('/usr/bin/codesign',['--force','--sign',process.env.STUDIO_SIGN_IDENTITY||'-',app]);
  exec('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  const final=path.join(dist,'Video Studio.app');
  try{await access(final);const id=execFileSync('/usr/libexec/PlistBuddy',['-c','Print CFBundleIdentifier',path.join(final,'Contents/Info.plist')],{encoding:'utf8'}).trim();if(id!==bundleId)throw Error('构建目录已有其他应用。');await rm(final,{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
  await rename(app,final);console.log(final);
}finally{await rm(staging,{recursive:true,force:true});}
