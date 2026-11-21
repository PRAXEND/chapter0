import {constants} from 'node:fs';
import {copyFile,mkdir,mkdtemp,readFile,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const digest=/^[a-f0-9]{64}$/;
const itemPath=/^media\/([a-f0-9]{64})\.([a-z0-9]{1,5})$/;
const exactDigest=spec=>createHash('sha256').update(JSON.stringify(spec)).digest('hex');
function specDigest(spec) {
  // Old installs expanded pack-relative references into the user's home directory.
  const match=/^([a-z0-9_.-]+)@(\d+)$/.exec(spec.distribution?.pack||'');
  if(!match) return exactDigest(spec);
  const root='/user-packs/'+match[1]+'/'+match[2]+'/';
  const portable=value=>{
    if(typeof value!=='string'||!path.isAbsolute(value)) return value;
    const offset=value.lastIndexOf(root),rel=offset>=0?value.slice(offset+root.length):'';
    return rel&&path.posix.normalize(rel)===rel&&!rel.startsWith('../')?'pack:'+rel:value;
  };
  const normalized=structuredClone(spec);
  if(normalized.distribution.resources) normalized.distribution.resources=portable(normalized.distribution.resources);
  if(Array.isArray(normalized.distribution.text_evidence)) normalized.distribution.text_evidence=normalized.distribution.text_evidence.map(portable);
  for(const ref of normalized.references||[]) if(digest.test(ref.sha256)&&ref.locator) ref.locator=portable(ref.locator);
  return exactDigest(normalized);
}
export {specDigest};

async function fileUnder(root,relative) {
  const directory=await realpath(root),file=await realpath(path.join(directory,relative));
  const rel=path.relative(directory,file);
  if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||!(await stat(file)).isFile()) throw Error('风格工程中的文件越界');
  return file;
}
async function readIndex(root,name) {
  const file=await fileUnder(root,name);
  if((await stat(file)).size>8_000_000) throw Error('风格工程清单过大');
  return JSON.parse(await readFile(file,'utf8'));
}
export async function readPortableStyle(selector,directory,parseStyle,fileSha256) {
  if(selector.manifest&&selector.manifest!=='style/manifest.json') throw Error('风格清单相对位置无效');
  const manifest=await readIndex(directory,'style/manifest.json');
  if(manifest.schema!==1||manifest.spec!=='spec.json'||manifest.id!==selector.id||manifest.version!==selector.version||!digest.test(manifest.sha256)||(selector.sha256&&manifest.sha256!==selector.sha256)) throw Error('工程与风格清单不一致');
  const spec=await readIndex(directory,'style/spec.json');
  if(spec.id!==selector.id||spec.version!==selector.version||specDigest(spec)!==manifest.sha256||exactDigest(spec)!==manifest.specSha256) throw Error('工程的风格版本或指纹不符');
  const expected=new Map(parseStyle(spec).references.filter(r=>r.locator&&digest.test(r.sha256)).map(r=>[r.id,r]));
  if(!Array.isArray(manifest.references)||manifest.references.length!==expected.size) throw Error('风格的参考清单不完整');
  const references=[];
  for(const row of manifest.references) {
    const ref=expected.get(row.id);
    if(!ref||ref.sha256!==row.sha256||!['included','bundled','unavailable'].includes(row.status)) throw Error('风格参考及原指纹不符');
    expected.delete(row.id);
    if(row.status!=='included') {
      if(row.path||ref.locator.startsWith('library:')) throw Error('工程缺少个人风格参考');
      references.push({...row,ref});continue;
    }
    const found=itemPath.exec(row.path||'');
    if(!found||found[1]!==ref.sha256) throw Error('风格参考的相对文件名或指纹无效');
    const file=await fileUnder(directory,'style/'+row.path);
    if(await fileSha256(file)!==ref.sha256) throw Error('风格参考文件的指纹不符');
    references.push({...row,ref,file,extension:'.'+found[2]});
  }
  return {spec,manifest,references};
}

export async function writePortableStyle(directory,spec,items,parseStyle,fileSha256) {
  const sha256=specDigest(spec),selector={id:spec.id,version:spec.version,sha256,manifest:'style/manifest.json'};
  await mkdir(directory,{recursive:true});const tmp=await mkdtemp(path.join(directory,'.style-export-'));
  try {
    await mkdir(path.join(tmp,'media'),{mode:0o700});
    const references=[];
    for(const {id,sha256,status,source,extension} of items) {
      const row={id,sha256,status};
      if(source) {
        row.path='media/'+sha256+extension;
        if(!itemPath.test(row.path)) throw Error('参考文件类型无法归档');
        const dest=path.join(tmp,row.path);
        await copyFile(source,dest,constants.COPYFILE_FICLONE);
        if(await fileSha256(dest)!==sha256) throw Error('参考文件在归档期间发生变化');
      }
      references.push(row);
    }
    const manifest={schema:1,id:spec.id,version:spec.version,sha256,specSha256:exactDigest(spec),spec:'spec.json',references};
    await writeFile(path.join(tmp,'spec.json'),JSON.stringify(spec,null,2),{mode:0o600});
    await writeFile(path.join(tmp,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
    try {await rename(tmp,path.join(directory,'style'));} catch(e) {
      if(!['EEXIST','ENOTEMPTY'].includes(e.code)) throw e;
      await readPortableStyle(selector,directory,parseStyle,fileSha256);
    }
    return selector;
  } finally {await rm(tmp,{recursive:true,force:true});}
}
