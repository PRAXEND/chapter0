import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const mediaCache = () => process.env.VIDEO_STUDIO_MEDIA_HOME ||
  path.join(os.homedir(), 'Library', 'Caches', 'Video Studio', 'standalone-media');

export async function executable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next installation. */ }
  }
  return null;
}

const checks = new Map();
export async function mediaTool(name) {
  if (!['ffmpeg', 'ffprobe', 'melt', 'whisper-cli', 'yt-dlp'].includes(name)) throw new Error('未知媒体工具');
  const override = process.env[`VIDEO_STUDIO_${name.toUpperCase().replaceAll('-', '_')}`];
  const resourceDir = process.env.VIDEO_STUDIO_RESOURCE_DIR;
  const cache = mediaCache();
  const bundle = 'Shotcut.app/Contents/MacOS';
  const candidates = [
    override,
    name==='yt-dlp'&&path.join(os.homedir(),'Library/Application Support/Video Studio/runtime/bin/yt-dlp'),
    resourceDir && path.join(resourceDir, 'bin', name),
    process.env.VIDEO_STUDIO_NATIVE_BIN && path.join(process.env.VIDEO_STUDIO_NATIVE_BIN, name),
    path.join(cache, 'bin', name),
    path.join(os.homedir(), 'Library/Application Support/Video Studio/native-bin', name),
    name === 'whisper-cli' && path.join(cache, 'whisper-build/bin/whisper-cli'),
    path.join(cache, bundle, name),
    path.join('/Applications', bundle, name),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, name))
  ];
  for (const item of (override ? [override] : candidates)) {
    const candidate = await executable([item]);
    if (!candidate) continue;
    const key = candidate + ':' + (await stat(candidate)).mtimeMs;
    if (!checks.has(key)) {
      checks.set(key, (async () => {
        if (name === 'ffmpeg') {
          const filters = await run(candidate, ['-hide_banner', '-filters']);
          return /\bass\s+V->V/.test(filters) && filters.includes('sidechaincompress');
        }
        if (name === 'ffprobe') await run(candidate, ['-version']);
        return true;
      })().catch(() => false));
    }
    if (await checks.get(key)) return candidate;
  }
  if (override) throw new Error(`指定的 ${name} 不可用或缺少所需滤镜`);
  return null;
}

export async function requiredTool(name) {
  const tool = await mediaTool(name);
  if (!tool) throw new Error(`未安装 ${name}。请在工作台准备本地媒体工具。`);
  return tool;
}

export async function scratch(parent, task) {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, '.media-'));
  try { return await task(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// Apple Silicon shares one memory pool across all open projects.
let busy = false;
const waiting = [];
export function mediaSlot(task, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const start = () => {
      signal?.removeEventListener('abort', abort);
      busy = true;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        const next = waiting.shift();
        if (next) next(); else busy = false;
      });
    };
    const abort = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      reject(signal.reason);
    };
    if (!busy) start();
    else { waiting.push(start); signal?.addEventListener('abort', abort, { once: true }); }
  });
}

export function run(exe, args, { cwd, signal, env, progress, maxOutput = 16 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const group = process.platform !== 'win32';
    const child = spawn(exe, args, { cwd, env: { ...process.env, ...env }, detached: group, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer;
    let exceeded = false;
    function kill(sig) {
      if (!child.pid) return;
      try { if (group) process.kill(-child.pid, sig); else child.kill(sig); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    function stop() {
      kill('SIGTERM');
      timer = setTimeout(() => kill('SIGKILL'), 1800);
      timer.unref();
    }
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8').on('data', part => {
      if (exceeded) return;
      stdout += part;
      if (stdout.length > maxOutput) { exceeded = true; stop(); }
      else if (progress) progress(part);
    });
    child.stderr.setEncoding('utf8').on('data', part => { stderr = (stderr + part).slice(-8192); });
    child.once('error', error => {
      signal?.removeEventListener('abort', stop);
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, killed) => {
      signal?.removeEventListener('abort', stop);
      clearTimeout(timer);
      if (signal?.aborted) return reject(signal.reason ?? new Error('已取消'));
      if (exceeded) return reject(new Error('媒体工具返回过多数据'));
      if (code !== 0) return reject(new Error(`${path.basename(exe)} 未完成（${code ?? killed}） ${stderr.trim().slice(-2500)}`));
      resolve(stdout);
    });
  });
}

export const ffBase = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex_threads', '2', '-filter_threads', '2'];
export function inputArgs(file) {
  // A local container can itself refer to other URLs. Limit all demuxers to local files.
  return ['-protocol_whitelist', 'file', '-threads', '2', '-i', file];
}
