import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executable, mediaCache, mediaSlot, mediaTool, requiredTool, run, scratch, ffBase, inputArgs } from './media-runtime.mjs';
import { fileHash, probeMedia } from './media.mjs';
export { createMusicBed } from './music-library.mjs';

const worker = fileURLToPath(new URL('../scripts/clone-voice.py', import.meta.url));
const present = async file => {
  const info = await stat(file).catch(() => null);
  return Boolean(info?.isFile() && info.size > 0);
};
const pythonChecks = new Map();
async function speechPython(candidates) {
  for (const candidate of candidates) {
    if (!await executable([candidate])) continue;
    const key = candidate + ':' + (await stat(candidate)).mtimeMs;
    if (!pythonChecks.has(key)) {
      pythonChecks.set(key, run(candidate, ['-c', 'from mlx_audio.tts.utils import load_model; import soundfile, mlx.core'],
        { env: { HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' } }).then(() => true, () => false));
    }
    if (await pythonChecks.get(key)) return candidate;
    pythonChecks.delete(key);
  }
  return null;
}

export async function audioCapabilities() {
  const cache = mediaCache();
  const cloneModel = process.env.VIDEO_STUDIO_QWEN_MODEL || path.join(cache, 'models/qwen3-tts-0.6b-base-4bit');
  const whisperModel = process.env.VIDEO_STUDIO_WHISPER_MODEL || path.join(cache, 'models/whisper/ggml-base.bin');
  const [whisper, voiceTool, weights, codec, asrWeights] = await Promise.all([
    mediaTool('whisper-cli'), executable(['/usr/bin/say']), present(path.join(cloneModel, 'model.safetensors')),
    present(path.join(cloneModel, 'speech_tokenizer/model.safetensors')), present(whisperModel)
  ]);
  const python = weights && codec ? await speechPython(process.env.VIDEO_STUDIO_MLX_PYTHON ? [process.env.VIDEO_STUDIO_MLX_PYTHON] : [path.join(cache, 'voice-runtime/bin/python'), path.join(cache, 'venv/bin/python')]) : null;
  return { system: Boolean(voiceTool), clone: Boolean(python && weights && codec), transcription: Boolean(whisper && asrWeights),
    voiceTool, python, cloneModel, whisper, whisperModel };
}

export async function synthesize(text, { mode = 'system', referencePath, referenceText, output, signal, voice = 'Tingting', language = 'Chinese' }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new Error('请提供长度适合单段生成的配音稿');
  if (!path.isAbsolute(output) || path.extname(output).toLowerCase() !== '.wav') throw new Error('配音目标须为 WAV 的绝对路径');
  const caps = await audioCapabilities();
  const ffmpeg = await requiredTool('ffmpeg');
  return scratch(path.dirname(output), async tmp => {
    const rendered = path.join(tmp, 'result.wav');
    let referenceHash, peakModelBytes;
    if (mode === 'system') {
      if (!caps.voiceTool) throw new Error('未找到 macOS 系统语音');
      const input = path.join(tmp, 'input.txt');
      const aiff = path.join(tmp, 'speech.aiff');
      await writeFile(input, text, { mode: 0o600 });
      await run(caps.voiceTool, ['-v', voice, '-f', input, '-o', aiff], { signal });
      await run(ffmpeg, [...ffBase, ...inputArgs(aiff), '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', rendered], { signal });
    } else if (mode === 'clone') {
      if (!caps.clone) throw new Error('需先准备本地 Qwen3-TTS Base 模型与 MLX 运行时');
      if (!referencePath || !referenceText?.trim()) throw new Error('克隆音色需要已授权的参考录音和对应原文');
      const reference = path.join(tmp, 'reference.wav');
      await run(ffmpeg, [...ffBase, ...inputArgs(path.resolve(referencePath)), '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', reference], { signal });
      const meta = await probeMedia(reference, { signal });
      if (meta.duration < 2 || meta.duration > 30) throw new Error('请截取 2–30 秒清晰的人声作为音色参考');
      referenceHash = await fileHash(referencePath);
      const request = path.join(tmp, 'request.json');
      await writeFile(request, JSON.stringify({ model: caps.cloneModel, reference, referenceText, text, language, output: rendered }), { mode: 0o600 });
      const log = await mediaSlot(() => run(caps.python, [worker, request], { signal, env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' } }), signal);
      peakModelBytes = JSON.parse(log.trim().split('\n').at(-1)).peakModelBytes;
    } else {
      throw new Error('未识别的配音方式');
    }
    const info = await probeMedia(rendered, { signal });
    if (!info.hasAudio || info.duration <= 0) throw new Error('生成的语音为空');
    const sha256 = await fileHash(rendered);
    signal?.throwIfAborted();
    await rename(rendered, output);
    return { path: output, audioPath: output, duration: info.duration, sha256, mode, referenceHash, model: mode === 'clone' ? path.basename(caps.cloneModel) : voice, peakModelBytes };
  });
}

export async function transcribe(file, { directory = path.dirname(file), signal, language = 'auto', maxChars } = {}) {
  const caps = await audioCapabilities();
  if (!caps.transcription) throw new Error('需先准备 whisper.cpp 与多语言模型');
  const ffmpeg = await requiredTool('ffmpeg');
  return scratch(directory, async tmp => {
    const wav = path.join(tmp, 'source.wav');
    const stem = path.join(tmp, 'transcript');
    await run(ffmpeg, [...ffBase, ...inputArgs(path.resolve(file)), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal });
    const { duration } = await probeMedia(wav, { signal });
    const length = Number.isInteger(maxChars) && maxChars > 0 ? ['-ml', String(Math.min(maxChars, 160))] : [];
    await mediaSlot(() => run(caps.whisper, ['-m', caps.whisperModel, '-f', wav, '-l', language, '-t', '2', ...length, '-oj', '-of', stem], { signal }), signal);
    const data = JSON.parse(await readFile(stem + '.json', 'utf8'));
    if (!Array.isArray(data.transcription)) throw new Error('转录文件缺少时间码');
    let lastEnd = 0;
    const segments = [];
    for (const segment of data.transcription) {
      const start = Math.max(lastEnd, Number(segment.offsets?.from) / 1000);
      const end = Math.min(duration, Number(segment.offsets?.to) / 1000);
      const text = String(segment.text ?? '').trim();
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      segments.push({ text, start, end });
      lastEnd = end;
    }
    return segments;
  });
}
