// Original variable TTF and complete license from google/fonts at the pinned revision.
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export const motionFont={
  family:'Noto Sans SC',
  path:fileURLToPath(new URL('./fonts/NotoSansSC.ttf',import.meta.url)),
  sha256:'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',bytes:17772300,
  license:fileURLToPath(new URL('./fonts/NotoSansSC-OFL.txt',import.meta.url)),
  licenseSha256:'1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9',
  revision:'a85815a42757630ce188fdad368c2dfc444d4773'
};
let verified;
export async function verifyMotionFont(){
  const info=await stat(motionFont.path);
  if(!info.isFile() || info.size!==motionFont.bytes)throw Error('工作台内置 Noto Sans SC 字体缺失或不完整。');
  if(verified===info.mtimeMs)return motionFont;
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(motionFont.path))hash.update(chunk);
  if(hash.digest('hex')!==motionFont.sha256)throw Error('工作台内置 Noto Sans SC 字体指纹不匹配。');
  verified=info.mtimeMs;
  return motionFont;
}
