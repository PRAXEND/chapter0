import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Match exact public endpoints. Always evaluate again for a redirected URL.
const hosts = new Set(['github.com', 'api.github.com', 'media.githubusercontent.com',
  'raw.githubusercontent.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

function bypasses(host, exclusions) {
  return exclusions.split(/[\s,]+/).some(entry => {
    const [name, port] = entry.toLowerCase().split(':');
    if (!name || (port && port !== '443')) return false;
    if (name === '*' || name === host) return true;
    if (name.startsWith('*.')) return host.endsWith(name.slice(1));
    return name.startsWith('.') && (host === name.slice(1) || host.endsWith(name));
  });
}

export function githubRoute(host, env = process.env, platform = process.platform) {
  if (!hosts.has(host)) return null;
  if (bypasses(host, env.no_proxy || env.NO_PROXY || '')) return 'direct';
  const proxy = env.https_proxy || env.HTTPS_PROXY;
  if (proxy) {
    if (!/^https?:\/\//.test(proxy)) throw Error('HTTPS_PROXY 需要 HTTP 或 HTTPS 代理地址。系统 SOCKS 代理可在 macOS 网络设置中配置。');
    return 'environment';
  }
  return platform === 'darwin' ? 'system' : 'direct';
}

const swiftFile = fileURLToPath(new URL('../scripts/github-media.swift', import.meta.url));

export async function macGithubResponse(url, {signal, maxBytes, accept, userAgent}) {
  const resources = process.env.VIDEO_STUDIO_RESOURCE_DIR;
  const exe = resources ? path.join(resources, 'bin', 'github-media') : '/usr/bin/xcrun';
  const args = [...(resources ? [] : ['swift', swiftFile]), url.href, String(maxBytes), accept, userAgent];
  const proc = spawn(exe, args, {signal, stdio: ['ignore', 'pipe', 'pipe', 'pipe']});
  let detail = '';
  proc.stderr.on('data', chunk => {detail = (detail + chunk).slice(-300);});
  const exited = new Promise(resolve => {
    proc.once('error', error => resolve({error}));
    proc.once('close', code => resolve({code}));
  });
  async function checkExit() {
    const {code, error} = await exited;
    signal?.throwIfAborted();
    if (error) throw error;
    if (code !== 0) throw Error('macOS 下载失败。' + detail.trim());
  }
  try {
    let header = '';
    for await (const bytes of proc.stdio[3]) {
      header += bytes.toString();
      if (header.length > 65536) throw Error('媒体响应头过大。');
    }
    if (!header) {await checkExit(); throw Error('macOS 未返回媒体响应。');}
    const meta = JSON.parse(header);
    if (meta.direct) {await checkExit(); return null;}
    const stream = Readable.from((async function* () {
      yield* proc.stdout;
      await checkExit();
    })(), {objectMode: false});
    stream.once('close', () => {if (proc.exitCode === null) proc.kill();});
    return Object.assign(stream, {statusCode: meta.status, headers: meta.headers});
  } catch (error) {
    proc.kill();
    throw error;
  }
}
