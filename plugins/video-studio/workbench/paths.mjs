import os from 'node:os';
import path from 'node:path';

export function workbenchDataDirectory(env=process.env, home=os.homedir(), platform=process.platform) {
  if (env.VIDEO_STUDIO_WEB_DATA) return path.resolve(env.VIDEO_STUDIO_WEB_DATA);
  const base=platform==='darwin' ? path.join(home,'Library','Application Support')
    : platform==='win32' ? env.LOCALAPPDATA || path.join(home,'AppData','Local')
    : env.XDG_DATA_HOME || path.join(home,'.local','share');
  return path.join(base,'Video Studio','workbench');
}
