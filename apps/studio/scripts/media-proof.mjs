// Run on Apple Silicon with prepared speech/clone/render packs:
// node scripts/media-proof.mjs <empty output directory> <Big Buck Bunny 2008 source movie>
import path from 'node:path';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createMusicBed, synthesize } from '../src/audio.mjs';
import { fileHash, frameAt, probeMedia, renderProject } from '../src/media.mjs';

const [, , dest, input] = process.argv;
if (!dest || !input) throw new Error('需要样片工程目录及获授权的 Big Buck Bunny 原片路径');
const dir = path.resolve(dest), assetsDir = path.join(dir, 'assets');
await mkdir(assetsDir, { recursive: true });
const save = (name, data) => writeFile(path.join(dir, name), JSON.stringify(data, null, 2) + '\n');
const timings = [];
async function timed(task, fn) {
  const before = performance.now();
  const value = await fn();
  timings.push({ task, seconds: Number(((performance.now() - before) / 1000).toFixed(2)), peakModelBytes: value.peakModelBytes });
  await save('timings.json', timings);
  return value;
}

const scenes = [
  [1, '空间', '先看森林的全貌。', '镜头从云端走向溪边，让我们先知道故事发生在哪里。'],
  [32, '轮廓', '再看洞口，黑暗里先露出轮廓。', '兔子慢慢挪到亮处，等我们认出主角，再让它走近。'],
  [57, '视线', '这次跟着兔子靠近花丛。', '近景让目光停在眼前，也让接下来的动静更引人注意。'],
  [94, '视角', '现在换一个观察位置。', '树枝挡住前景，兔子变小了。谁在看它？这个问题已经进了画面。'],
  [121, '距离', '树干成了一条分界线。', '前面的兔子与身后的小动物先后入画，我们比主角多知道了一点。'],
  [148, '反应', '最后，把动作留给角色。', '远景交代距离，近景给出反应。我们始终知道，下一刻该看向哪里。']
];
const referenceText = '我在工作台里录了一段测试声音，用来核对中文发音和时间。';
const refFile = path.join(assetsDir, 'synthetic-reference.wav');
await synthesize(referenceText, { mode: 'system', output: refFile });
const referenceHash = await fileHash(refFile);
const assets = [{ id: 'voice-reference', name: '本机合成的测试参考录音', kind: 'audio', path: refFile,
  sha256: referenceHash, duration: (await probeMedia(refFile)).duration, source: { type: 'system', transcript: referenceText, credit: 'macOS Tingting · 本机验证用合成参考' } }], clips = [];
const fps = 30;
const movie = path.join(assetsDir, 'big-buck-bunny' + path.extname(input));
const credit = '(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org';
for (const [i, [source, label, a, b]] of scenes.entries()) {
  const text = a + b;
  const output = path.join(assetsDir, `voice-${i + 1}.wav`);
  const sidecar = output + '.json';
  let sound;
  try {
    const stored = JSON.parse(await readFile(sidecar, 'utf8'));
    if (stored.text === text && stored.referenceHash === referenceHash && stored.sha256 === await fileHash(output)) sound = stored;
  } catch { /* A missing or outdated stem is generated below. */ }
  if (!sound) {
    sound = await timed(`克隆段落 ${i + 1}`, () => synthesize(text, { mode: 'clone', output, referencePath: refFile, referenceText }));
    await writeFile(sidecar, JSON.stringify({ ...sound, text }));
  }
  const voiceId = `voice-${i + 1}`, start = i * 450;
  const speed = Math.max(1, sound.duration / 13.6);
  const duration = Math.floor(sound.duration / speed * fps);
  assets.push({ id: voiceId, name: `段落 ${i + 1} 克隆旁白`, kind: 'audio', path: output, duration: sound.duration, sha256: sound.sha256, source: { type: 'clone', referenceHash, model: sound.model, referenceText } });
  clips.push({ id: `v-${i}`, track: 'video', assetId: 'forest', start, duration: 450, sourceIn: source * fps, speed: 1, gain: 0, locked: i === 0 });
  clips.push({ id: `n-${i}`, track: 'narration', assetId: voiceId, start: start + 10, duration, sourceIn: 0, speed, gain: 1 });
  // Captions are aligned to measured audio below, not an assumed speaking rate.
  const { transcribe } = await import('../src/audio.mjs');
  const wordCues = await transcribe(output, { directory: dir, language: 'zh' });
  // The first clause is often one ASR segment. Preserve the spoken transcript and exact known script on a single segment when necessary.
  const cueText = wordCues.length === 1 ? [text] : wordCues.map(c => c.text);
  for (const [j, cue] of wordCues.entries()) {
    const from = Math.round(cue.start / speed * fps), to = Math.min(duration, Math.round(cue.end / speed * fps));
    if (to > from) clips.push({ id: `c-${i}-${j}`, track: 'caption', start: start + 10 + from, duration: to - from, text: cueText[j], style: { fontSize: 43 }, geometry: { x: 0.5, y: 0.87 } });
  }
  clips.push({ id: `g-${i}`, track: 'graphic', start: start + 12, duration: 108, text: label, style: { fontSize: 65, color: '#FFF0B0', backgroundColor: '#192628CF' }, geometry: { x: 0.14, y: 0.17 }, keyframes: [{ frame: 0, x: 0.10, opacity: 0 }, { frame: 8, x: 0.14, opacity: 1 }, { frame: 98, opacity: 1 }, { frame: 108, opacity: 0 }] });
}
if (path.resolve(movie) !== path.resolve(input)) await copyFile(input, movie);
const sourceInfo = await probeMedia(movie);
assets.unshift({ id: 'forest', name: 'Big Buck Bunny', ...sourceInfo, path: movie, sha256: await fileHash(movie), source: { url: 'https://download.blender.org/peach/bigbuckbunny_movies/', licenseUrl: 'https://peach.blender.org/about/', credit, license: 'CC BY 3.0', changes: '选取原片片段，重排、重新配音配乐并添加中文字幕。' } });
const music = await createMusicBed(path.join(assetsDir, 'forest-score.wav'), { duration: 90, style: 'calm' });
assets.push({ id: 'score', kind: 'audio', name: '森林配乐', ...music, source: { credit: music.credit } });
clips.push({ id: 'bed', track: 'music', assetId: 'score', start: 0, duration: 2700, sourceIn: 0, gain: 0.5 });
clips.push({ id: 'credit', track: 'graphic', start: 2535, duration: 165, text: credit + '\nCC BY 3.0 · 剪辑、配音与配乐由 Video Studio 重新制作', style: { fontSize: 27, backgroundColor: '#102020BF' }, geometry: { x: 0.5, y: 0.12 } });
const project = { title: '森林的节奏', brief: '从一部开放电影的六个片段观察剪辑如何引导视线。', revision: 1, mode: 'script', profile: { width: 1920, height: 1080, fps }, assets, timeline: { clips }, settings: {
  voiceMode: 'clone', voiceReferenceAssetId: 'voice-reference', referenceHash, voiceReferenceText: referenceText, voiceConsent: true
} };
await save('media-project.json', project);
const render = await timed('1080p 全片导出', () => renderProject(project, { directory: dir, output: path.join(dir, '森林的节奏.mp4') }));
await frameAt(render.videoPath, 18, path.join(dir, '封面.jpg'));
await save('render.json', render);
console.log(JSON.stringify({ render, timings }, null, 2));
