import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileHash } from './media.mjs';
import { mediaCache } from './media-runtime.mjs';

export const presetId = 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit';
export const presetRevision = '08c72cad5e2fd0f41730c8bd1f28149585e46361';
export const presetVoices = Object.freeze(['dylan']);
export const presetDirectory = () => process.env.VIDEO_STUDIO_QWEN_PRESET_MODEL ||
  path.join(mediaCache(), 'models/qwen3-tts-0.6b-customvoice-4bit');

// Pinned to the publisher revision above, including the codec and tokenizer configuration.
export const presetFiles = Object.freeze({
  'config.json': [6058, '612cb591b44547319e5c68a78c0e93e4defb57882a4aa9ef5f06cc2f071ed036'],
  'generation_config.json': [245, 'f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa'],
  'merges.txt': [1671839, '599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3'],
  'model.safetensors': [1006772520, '4ab02a20be381700f6e73dbb5efdc424cadf9f1d0652cbffd662872ea41e296a'],
  'model.safetensors.index.json': [71447, 'f3b84ec5c1b38220008c3a300b8a73502f7d4ec67b232e0193d9376909fc4e3e'],
  'preprocessor_config.json': [127, 'efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119'],
  'speech_tokenizer/config.json': [2336, 'ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167'],
  'speech_tokenizer/configuration.json': [76, '6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd'],
  'speech_tokenizer/model.safetensors': [682293092, '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258'],
  'speech_tokenizer/preprocessor_config.json': [234, 'fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb'],
  'tokenizer_config.json': [7344, 'dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670'],
  'vocab.json': [2776833, 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910'],
});

const verified = new Map();
export async function presetModelReady(directory) {
  const entries = Object.entries(presetFiles);
  const signatures = await Promise.all(entries.map(async ([name, [size]]) => {
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (info?.isFile() && info.size === size) return [info.dev, info.ino, size, info.mtimeMs, info.ctimeMs].join(':');
    return null;
  }));
  if (signatures.includes(null)) { verified.delete(directory); return false; }
  const key = signatures.join('/');
  if (verified.get(directory)?.key === key) return verified.get(directory).result;
  const result = (async () => {
    for (const [name, [, hash]] of entries) {
      if (await fileHash(path.join(directory, name)) !== hash) return false;
    }
    return true;
  })().catch(() => false);
  verified.set(directory, { key, result });
  return result;
}
