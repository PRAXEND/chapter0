// Install only into the current user's Studio cache. No system browser, Homebrew, or project media is used.
import { chmod, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileHash, mediaCapabilities } from '../src/media.mjs';
import { audioCapabilities } from '../src/audio.mjs';
import { executable, mediaCache, mediaTool, run, scratch } from '../src/media-runtime.mjs';

const shotcut = 'https://github.com/mltframework/shotcut/releases/download/v26.11.15/shotcut-macos-26.11.15.dmg';
const whisperSrc = 'https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.9.5';
const whisperWeights = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin';
const qwenRevision = '0d6bb6fe33f92d47a507e23b9148940e8366ab5b';
const weights = {
  'model.safetensors': '07dcb37b323614af64624af687876edd5c9a8b442da2a7b549d62f9ba2770ec1',
  'speech_tokenizer/model.safetensors': '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258'
};
const usable = async file => (await stat(file).catch(() => null))?.isFile() ?? false;

async function fetchFile(url, to, expected, signal) {
  await mkdir(path.dirname(to), { recursive: true });
  if (await usable(to) && (!expected || await fileHash(to) === expected)) return;
  await scratch(path.dirname(to), async tmp => {
    const partial = path.join(tmp, 'download');
    await run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '1500', '--retry', '2', '--output', partial, url], { signal });
    if (expected && await fileHash(partial) !== expected) throw new Error('下载文件校验不匹配，请重新准备');
    await rename(partial, to);
  });
}

async function installRender(cache, work, log, signal) {
  const bin = path.join(cache, 'bin');
  await mkdir(bin, { recursive: true });
  const zips = { ffmpeg: '1f66e9a690a7f1c9e60b012379f8869c11818d1797f45b21dbb2f2564ba61ae1', ffprobe: '6ef2df5f575042923a28537ab37adf936f28bf3e7b85de23a1447ed447ec1dbd' };
  for (const [tool, hash] of Object.entries(zips)) {
    if (await mediaTool(tool)) continue;
    log(`下载本地 ${tool}（9.1）`);
    const zip = path.join(work, tool + '.zip');
    await fetchFile(`https://ffmpeg.martin-riedl.de/download/macos/arm64/1795207104_9.1/${tool}.zip`, zip, hash, signal);
    const files = (await run('/usr/bin/unzip', ['-Z1', zip], { signal })).trim().split('\n');
    const member = files.find(name => (name === tool || name.endsWith('/' + tool)) && !name.startsWith('__MACOSX/') && !name.startsWith('/') && !name.split('/').includes('..'));
    if (!member) throw new Error(`${tool} 压缩包内缺少程序`);
    const unpacked = path.join(work, 'unpack-' + tool);
    await mkdir(unpacked);
    await run('/usr/bin/unzip', ['-qo', zip, member, '-d', unpacked], { signal });
    await chmod(path.join(unpacked, member), 0o755);
    await rename(path.join(unpacked, member), path.join(bin, tool));
  }
  if (!await mediaTool('melt')) {
    log('准备签名的 MLT 渲染运行时');
    const dmg = path.join(work, 'shotcut.dmg'), mount = path.join(work, 'volume');
    await fetchFile(shotcut, dmg, '664c6ea4195d58dbf3fd43f3d74ae46d59b6310f9ac628d5e70a8e2786a4f80b', signal);
    await mkdir(mount);
    try {
      await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { signal });
      const app = path.join(work, 'Shotcut.app');
      await run('/usr/bin/ditto', [path.join(mount, 'Shotcut.app'), app], { signal });
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { signal });
      await rename(app, path.join(cache, 'Shotcut.app'));
    } finally { await run('/usr/bin/hdiutil', ['detach', mount, '-quiet']).catch(() => {}); }
  }
  if (!(await mediaCapabilities()).ready || !await mediaTool('melt')) throw new Error('渲染工具未就绪');
}

async function pythonEnv(cache, work, signal, log) {
  const venv = path.join(cache, 'voice-runtime');
  const py = path.join(venv, 'bin/python');
  if (await executable([py])) return py;
  const supplied = await executable([process.env.VIDEO_STUDIO_SETUP_PYTHON]);
  if (supplied) {
    await run(supplied, ['-c', 'import sys; assert sys.version_info >= (3, 11)'], { signal });
    await run(supplied, ['-m', 'venv', venv], { signal });
    return py;
  }
  log('准备工作台独立的 Python 运行时');
  const tgz = path.join(work, 'uv.tar.gz');
  await fetchFile('https://github.com/astral-sh/uv/releases/download/0.13.9/uv-aarch64-apple-darwin.tar.gz', tgz, '5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca', signal);
  await run('/usr/bin/tar', ['-xzf', tgz, '-C', work], { signal });
  const uv = path.join(work, 'uv-aarch64-apple-darwin/uv');
  const env = { UV_PYTHON_INSTALL_DIR: path.join(cache, 'pythons'), UV_PYTHON_BIN_DIR: path.join(cache, 'bin'), UV_CACHE_DIR: path.join(work, 'uv-cache') };
  await run(uv, ['python', 'install', '3.12', '--no-bin'], { signal, env });
  await run(uv, ['venv', '--python', '3.12', '--managed-python', '--seed', venv], { signal, env });
  return py;
}

async function installSpeech(cache, work, log, signal) {
  if (!await mediaTool('whisper-cli')) {
    log('编译独立 whisper.cpp 命令行');
    try { await run('/usr/bin/xcrun', ['--find', 'clang'], { signal }); }
    catch { throw new Error('此源码安装需要 Xcode Command Line Tools；桌面发行包可内置 whisper-cli'); }
    const python = await pythonEnv(cache, work, signal, log);
    await run(python, ['-m', 'pip', '--disable-pip-version-check', 'install', '--no-cache-dir', '--quiet', 'cmake==4.4.5'], { signal });
    const cmake = path.join(path.dirname(python), 'cmake'), src = path.join(work, 'whisper.tar.gz'), build = path.join(work, 'build');
    await fetchFile(whisperSrc, src, 'ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720', signal);
    await run('/usr/bin/tar', ['-xzf', src, '-C', work], { signal });
    await run(cmake, ['-S', path.join(work, 'whisper.cpp-1.9.5'), '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF', '-DGGML_METAL_EMBED_LIBRARY=ON', '-DGGML_NATIVE=OFF'], { signal });
    await run(cmake, ['--build', build, '--target', 'whisper-cli', '--parallel', '2'], { signal });
    await mkdir(path.join(cache, 'bin'), { recursive: true });
    await rename(path.join(build, 'bin/whisper-cli'), path.join(cache, 'bin/whisper-cli'));
  }
  log('校验多语言转录模型');
  if (!process.env.VIDEO_STUDIO_WHISPER_MODEL) await fetchFile(whisperWeights, path.join(cache, 'models/whisper/ggml-base.bin'), '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', signal);
  if (!(await audioCapabilities()).transcription) throw new Error('转录工具或模型未就绪');
}

async function installClone(cache, work, log, signal) {
  log('准备 Apple Silicon 本地语音依赖');
  const python = process.env.VIDEO_STUDIO_MLX_PYTHON || await pythonEnv(cache, work, signal, log);
  if (!process.env.VIDEO_STUDIO_MLX_PYTHON) {
    await run(python, ['-m', 'pip', '--disable-pip-version-check', 'install', '--quiet', '--no-cache-dir', 'mlx-audio==0.6.7', 'mlx-lm==0.32.2', 'soundfile==0.14.0'], { signal });
  }
  await run(python, ['-c', 'from mlx_audio.tts.utils import load_model; import soundfile, mlx.core'], { signal });
  if (!process.env.VIDEO_STUDIO_QWEN_MODEL) {
    const model = path.join(cache, 'models/qwen3-tts-0.6b-base-4bit');
    const files = ['config.json', 'generation_config.json', 'merges.txt', 'model.safetensors.index.json', 'preprocessor_config.json', 'speech_tokenizer/config.json', 'speech_tokenizer/configuration.json', 'speech_tokenizer/preprocessor_config.json', 'tokenizer_config.json', 'vocab.json', ...Object.keys(weights)];
    for (const file of files) {
      log('校验音色模型 ' + file);
      await fetchFile(`https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit/resolve/${qwenRevision}/${file}?download=true`, path.join(model, file), weights[file], signal);
    }
  }
  if (!(await audioCapabilities()).clone) throw new Error('克隆模型未就绪');
}

export async function prepareMedia(group, { signal, onProgress = () => {} } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('此媒体包面向 Apple Silicon Mac');
  if (!['render', 'speech', 'clone', 'all'].includes(group)) throw new Error('准备项目应为 render、speech、clone 或 all');
  const cache = mediaCache();
  await mkdir(cache, { recursive: true });
  const lock = path.join(cache, 'prepare.pid');
  signal?.throwIfAborted();
  // shlock(1) uses link(2) and verifies the previous owner's PID during stale-lock recovery.
  try { await run('/usr/bin/shlock', ['-p', String(process.pid), '-f', lock]); }
  catch (error) {
    if (await usable(lock)) throw new Error('另一个媒体准备任务正在运行');
    throw error;
  }
  try {
    signal?.throwIfAborted();
    await scratch(cache, async work => {
      if (group === 'render' || group === 'all') await installRender(cache, work, onProgress, signal);
      if (group === 'speech' || group === 'all') await installSpeech(cache, work, onProgress, signal);
      if (group === 'clone' || group === 'all') await installClone(cache, work, onProgress, signal);
    });
    return { media: await mediaCapabilities(), audio: await audioCapabilities() };
  } finally {
    if (Number((await readFile(lock, 'utf8').catch(() => '')).trim()) === process.pid) await unlink(lock);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  prepareMedia(process.argv[2] || 'all', { onProgress: msg => console.error(msg) })
    .then(state => console.log(JSON.stringify(state, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
