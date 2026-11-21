import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CodexClient } from '../src/codex.mjs';

const [rootArg, action, srcArg] = process.argv.slice(2);
if (!rootArg || !['prepare', 'background', 'render-foreground', 'render-workbench', 'register'].includes(action)) {
  throw Error(
    '用法：node scripts/build-full-cut-pair.mjs <已含 NASA 原片的盲评库> prepare|background|render-foreground|render-workbench|register [工作台 src 目录]'
  );
}
const root = path.resolve(rootArg),
  folder = path.join(root, 'research-plan', 'full-cut'),
  packet = path.join(folder, 'packet');
const lib = path.resolve(srcArg || fileURLToPath(new URL('../src', import.meta.url)));
const load = (name) => import(pathToFileURL(path.join(lib, name + '.mjs')).href);
const exec = promisify(execFile),
  hash = (x) => createHash('sha256').update(x).digest('hex');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
async function optional(file) {
  try {
    return await json(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
async function freeze(file, data) {
  const value = Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const tmp = file + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, value, { mode: 0o600, flag: 'wx' });
  try {
    await link(tmp, file);
  } catch (e) {
    if (e.code !== 'EEXIST' || hash(Buffer.from(value)) !== hash(await readFile(file))) throw e;
  } finally {
    await rm(tmp, { force: true });
  }
}
const fixture = (filename) => fileURLToPath(new URL('./fixtures/' + filename, import.meta.url));
const { profile, ranges } = await json(fixture('artemis-windows.json')),
  fps = profile.fps;
const footage = {
  lift: 'd5164ca7ec9333e6a6ef296527606955e5e9474b26613029fe34799ae17dd860',
  launch: 'd55e43036de3fabadfcf1da87d9eba42cfd52b02d80cfff2ba97c89866c8debd',
  splash: 'df4964dfae903bcde875a85de3f96f98ac7e7e5210f3c14b52ff4ced90572b68',
};
const nasaIds = {
  lift: 'KSC-20221104-MH-CSH01_0001-Artemis_I_Rollout_for_Launch_Reupload-3317651',
  launch: 'Artemis I Launch 2022 CU tracking from Press Site_compressed',
  splash: 'KSC-20221211-VP-MWC01-001-ARTEMIS-SPLASHDOWN-3296595',
};
const sourceInfo = Object.fromEntries(
  Object.entries(nasaIds).map(([key, id]) => {
    const slug = encodeURIComponent(id);
    return [
      key,
      {
        page: 'https://images.nasa.gov/details/' + slug,
        url: 'https://images-assets.nasa.gov/video/' + slug + '/' + slug + '~mobile.mp4',
      },
    ];
  })
);
const model = 'gpt-6.2-astra',
  effort = 'max',
  voiceName = 'Tingting',
  mission = 'https://www.nasa.gov/mission/artemis-i/';
const media = await load('media');
const sourceFile = (key) => path.join(root, 'research-sources', key + '.mp4');
async function verifyInputs(fetchMissing = false) {
  for (const [key, digest] of Object.entries(footage)) {
    const file = sourceFile(key);
    let actual;
    try {
      actual = await media.fileHash(file);
    } catch (error) {
      if (!fetchMissing || error.code !== 'ENOENT') throw error;
      const response = await fetch(sourceInfo[key].url, {
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw Error('NASA 原片无法下载：' + response.status + ' ' + key);
      let size = 0;
      const chunks = [];
      for await (const part of response.body) {
        size += part.length;
        if (size > 32 * 1024 * 1024) throw Error('NASA 返回的文件超出原片大小范围。');
        chunks.push(part);
      }
      const bytes = Buffer.concat(chunks);
      actual = hash(bytes);
      if (actual === digest) {
        await mkdir(path.dirname(file), { recursive: true });
        await freeze(file, bytes);
      }
    }
    if (actual !== digest) throw Error('NASA 原片指纹不符：' + key);
  }
  return hash(JSON.stringify({ footage, ranges, profile, voiceName, duration: 54, music: false, speechRate: 1 }));
}
async function makePacket() {
  await mkdir(packet, { recursive: true });
  const inputHash = await verifyInputs(true);
  const ff = await media.mediaTool('ffmpeg'),
    cols = 6,
    w = 190,
    h = 108,
    buffer = Buffer.alloc(cols * w * 5 * h * 3);
  for (const [i, [letter, [key, lo, hi]]] of Object.entries(ranges).entries()) {
    for (const [j, t] of [lo + 2, (lo + hi) / 2, hi - 2].entries()) {
      const vf =
        'scale=' +
        w +
        ':' +
        h +
        ',drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text=' +
        letter +
        '-' +
        t +
        's:fontsize=13:fontcolor=white:box=1:boxcolor=black:x=2:y=2';
      const { stdout } = await exec(
        ff,
        [
          '-nostdin',
          '-v',
          'error',
          '-ss',
          String(t),
          '-i',
          sourceFile(key),
          '-frames:v',
          '1',
          '-vf',
          vf,
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          '-',
        ],
        { encoding: 'buffer' }
      );
      const slot = i * 3 + j;
      for (let y = 0; y < h; y++)
        stdout.copy(
          buffer,
          (Math.floor(slot / cols) * h * cols * w + y * w * cols + (slot % cols) * w) * 3,
          y * w * 3,
          (y + 1) * w * 3
        );
    }
  }
  const img = path.join(packet, '.sheet-' + randomUUID() + '.jpg'),
    raw = img + '.rgb';
  try {
    await writeFile(raw, buffer);
    await exec(ff, [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgb24',
      '-video_size',
      cols * w + 'x' + 5 * h,
      '-i',
      raw,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      img,
    ]);
    await freeze(path.join(packet, 'source-sheet.jpg'), await readFile(img));
  } finally {
    await rm(img, { force: true });
    await rm(raw, { force: true });
  }
  const brief = await readFile(fixture('artemis-first-cut.txt'));
  await freeze(path.join(packet, 'brief.txt'), brief);
  await freeze(path.join(packet, 'windows.json'), await readFile(fixture('artemis-windows.json')));
  await freeze(path.join(packet, 'manifest.json'), {
    schema: 1,
    promptHash: hash(brief),
    imageHash: await media.fileHash(path.join(packet, 'source-sheet.jpg')),
    inputHash,
    sourceHashes: footage,
    model,
    effort,
    profile,
    voiceName,
    originalAudio: false,
    music: false,
    duration: 54,
    mission,
  });
}

async function background() {
  const file = path.join(folder, 'workbench-first.json');
  if (await optional(file)) return;
  const manifest = await json(path.join(packet, 'manifest.json')),
    brief = await readFile(path.join(packet, 'brief.txt'), 'utf8'),
    image = await readFile(path.join(packet, 'source-sheet.jpg'));
  if (hash(brief) !== manifest.promptHash || hash(image) !== manifest.imageHash) throw Error('共同输入已改变。');
  const c = new CodexClient();
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let turn,
    reads = 0;
  try {
    const tool = {
      type: 'function',
      name: 'studio_reference',
      description: 'Open the contact sheet attached to this exact briefing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    };
    const thread = await c.thread(
      null,
      [tool],
      '共同任务书附有一张由 studio_reference 工具提供的源帧拼图。先打开它，再按任务书提交首版决定。',
      { model }
    );
    const raw = await c.runTurn({
      threadId: thread,
      prompt: brief,
      effort,
      signal: controller.signal,
      onStart: (id) => {
        turn = id;
      },
      tool: async (e) => {
        if (e.tool !== 'studio_reference') throw Error('只允许打开固定附图');
        reads++;
        return {
          success: true,
          contentItems: [{ type: 'inputImage', imageUrl: 'data:image/jpeg;base64,' + image.toString('base64') }],
        };
      },
    });
    const meta = await c.request('thread/resume', { threadId: thread, excludeTurns: true });
    if (meta.model !== model || reads < 1) throw Error('模型或附图输入未得到验证。');
    await freeze(file, {
      threadId: thread,
      turnId: turn,
      model,
      effort,
      source: 'Codex App Server',
      frameReads: reads,
      promptHash: hash(brief),
      imageHash: hash(image),
      raw,
    });
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    c.close();
  }
}

function validate(decision) {
  if (!decision?.title?.trim() || decision.shots?.length !== 6) throw Error('首版须含片名及六个镜头。');
  const windows = new Set(),
    groups = new Set();
  let secs = 0,
    emphases = 0;
  for (const s of decision.shots) {
    const range = ranges[s.window];
    if (
      !range ||
      windows.has(s.window) ||
      !Number.isFinite(s.sourceStart) ||
      !Number.isInteger(s.seconds) ||
      s.seconds < 7 ||
      s.seconds > 12 ||
      s.sourceStart < range[1] ||
      s.sourceStart + s.seconds > range[2] ||
      typeof s.voice !== 'string' ||
      !s.voice.trim() ||
      !s.cutReason?.trim()
    )
      throw Error('首版源窗口或镜头条件无效：' + s.window);
    windows.add(s.window);
    groups.add(range[0]);
    secs += s.seconds;
    if (s.overlay) {
      if (
        !s.overlay.text?.trim() ||
        [...s.overlay.text.trim()].length > 8 ||
        !Number.isFinite(s.overlay.at) ||
        s.overlay.at < s.sourceStart ||
        s.overlay.at > s.sourceStart + s.seconds - 1
      )
        throw Error('重点字超出约定范围：' + s.window);
      emphases++;
    }
  }
  if (secs !== 54 || groups.size !== 3 || emphases < 1 || emphases > 3)
    throw Error('首版不满足共同的时长、来源或强调次数。');
  return decision;
}
function parseRaw(raw) {
  return JSON.parse(
    raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
  );
}
async function render(side) {
  const firstPath = path.join(folder, side + '-first.json'),
    receiptPath = path.join(folder, side + '-render.json');
  const previous = await optional(receiptPath);
  if (previous) {
    if (
      (await media.fileHash(previous.videoPath)) !== previous.videoHash ||
      (await media.fileHash(firstPath)) !== previous.firstHash
    )
      throw Error('封存的首版记录已改变。');
    return previous;
  }
  const manifest = await json(path.join(packet, 'manifest.json')),
    record = await json(firstPath);
  if (
    (await verifyInputs()) !== manifest.inputHash ||
    (await media.fileHash(path.join(packet, 'source-sheet.jpg'))) !== manifest.imageHash ||
    (await media.fileHash(path.join(packet, 'brief.txt'))) !== manifest.promptHash
  )
    throw Error('原始比较条件不一致。');
  if (
    side === 'workbench' &&
    (record.model !== model ||
      record.effort !== effort ||
      record.promptHash !== manifest.promptHash ||
      record.imageHash !== manifest.imageHash ||
      record.frameReads < 1)
  )
    throw Error('后台的回合设置与共同输入不一致。');
  const plan = validate(side === 'workbench' ? parseRaw(record.raw) : record);
  const { createStore } = await load('project'),
    audio = await load('audio'),
    { reviewProject } = await load('review'),
    { portableProject } = await load('library');
  const store = createStore(root, { probeMedia: media.probeMedia });
  try {
    const producer = side === 'workbench' ? 'Video Studio Codex App Server' : 'Codex Desktop 前台主对话';
    let p = store.create({
      mode: 'script',
      title: plan.title,
      brief: await readFile(path.join(packet, 'brief.txt'), 'utf8'),
      script: plan.shots.map((s) => s.voice).join('\n'),
      profile,
      settings: {
        voiceMode: 'system',
        systemVoice: voiceName,
        voiceId: voiceName,
        musicMode: 'none',
        musicEnabled: false,
        targetDuration: 54,
        requireCaptions: true,
      },
    });
    const assets = new Map(),
      clips = [],
      board = [];
    const clip = (track, id, start, duration, props) => ({
      id,
      track,
      start,
      duration,
      sourceIn: 0,
      gain: 1,
      speed: 1,
      ...props,
    });
    const dirs = store.paths(p.id);
    let start = 0;
    for (const [i, s] of plan.shots.entries()) {
      const key = ranges[s.window][0];
      if (!assets.has(key))
        assets.set(
          key,
          await store.addAsset(p.id, sourceFile(key), {
            name: key + '.mp4',
            provider: 'NASA',
            credit: 'NASA',
            url: sourceInfo[key].page,
            license: 'NASA media usage guidelines',
            licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
          })
        );
      const a = assets.get(key),
        length = s.seconds * fps,
        sourceIn = Math.round(s.sourceStart * fps),
        out = path.join(dirs.cache, 'speech-' + i + '.wav');
      const speech = await audio.synthesize(s.voice, { mode: 'system', voice: voiceName, output: out });
      const v = await store.addAsset(p.id, speech.audioPath || speech.path || out, {
        name: '第' + (i + 1) + '段旁白.wav',
        role: 'narration',
        provider: 'macOS say',
        voiceId: voiceName,
        model: speech.model,
      });
      const n = Math.max(1, Math.round(v.duration * fps));
      if (n > length) throw Error('原速旁白超过镜头时间窗，保留首版作为验证记录：' + s.window);
      clips.push(
        clip('video', 'v' + i, start, length, { assetId: a.id, sourceIn, gain: 0 }),
        clip('narration', 'n' + i, start, n, { assetId: v.id }),
        clip('caption', 'c' + i, start, n, { text: s.voice })
      );
      if (s.overlay) {
        const srcFrame = Math.round(s.overlay.at * fps),
          at = start + srcFrame - sourceIn;
        clips.push(
          clip('graphic', 'g' + i, at, Math.min(Math.round(2.5 * fps), start + length - at), {
            text: s.overlay.text,
            geometry: { x: 0.5, y: 0.23 },
            style: { fontSize: 36, color: '#F8DC77', backgroundColor: '#142027D0' },
            actionFrame: at,
            anchorAssetId: a.id,
            anchorSourceFrame: srcFrame,
          })
        );
      }
      board.push({
        window: s.window,
        assetId: a.id,
        sourceIn,
        start,
        duration: length,
        voiceFrames: n,
        cutReason: s.cutReason,
        sourcePage: sourceInfo[key].page,
      });
      start += length;
    }
    p = store.apply(
      p.id,
      store.get(p.id).revision,
      clips.map((c) => ({ op: 'add', clip: c })),
      'user'
    );
    p = store.setMeta(p.id, {
      storyboard: board,
      facts: plan.shots.map((s, i) => ({ text: s.voice, url: mission, start: board[i].start })),
      studyProvenance: { producer, model, effort, manifest, firstHash: await media.fileHash(firstPath) },
    });
    const id = randomUUID(),
      dir = path.join(dirs.outputs, id);
    await mkdir(dir, { recursive: true });
    const result = await media.renderProject(p, { directory: dir, output: path.join(dir, 'video.mp4') });
    const probe = await media.probeMedia(result.videoPath);
    if (probe.frames !== 1296 || Math.abs(probe.duration - 54) > 1 / fps || !probe.hasAudio)
      throw Error('成片帧数、片长或音轨校验失败。');
    const qa = await reviewProject(p, {
      videoPath: result.videoPath,
      srtPath: result.srtPath,
      resolveTool: media.mediaTool,
    });
    const qaFile = path.join(dir, 'review.json');
    await freeze(qaFile, qa);
    const projectFile = await portableProject(p, path.join(dir, '工程'));
    store.snapshot(p);
    const at = new Date().toISOString();
    store.saveJob({
      id,
      projectId: p.id,
      kind: 'render',
      status: 'done',
      phase: 'done',
      revision: p.revision,
      qa,
      createdAt: at,
      updatedAt: at,
      progress: 1,
      repairs: 0,
      files: { video: result.videoPath, subtitle: result.srtPath, project: projectFile, review: qaFile },
      events: [{ at, message: '完整导演首版按共同条件冻结' }],
    });
    const receipt = {
      projectId: p.id,
      jobId: id,
      mode: p.mode,
      firstHash: await media.fileHash(firstPath),
      source: producer,
      engine: result.engine,
      videoPath: result.videoPath,
      srtPath: result.srtPath,
      projectFile,
      reviewFile: qaFile,
      videoHash: result.sha256,
      subtitleHash: await media.fileHash(result.srtPath),
      shotCount: board.length,
      overlayCount: clips.filter((c) => c.track === 'graphic').length,
      frames: probe.frames,
      duration: probe.duration,
      voice: voiceName,
      qaStatus: qa.status,
    };
    await freeze(receiptPath, receipt);
    return receipt;
  } finally {
    store.close();
  }
}
async function register() {
  const resultFile = path.join(folder, 'study.json'),
    prior = await optional(resultFile);
  if (prior) return prior;
  const f = await render('foreground'),
    w = await render('workbench'),
    m = await json(path.join(packet, 'manifest.json'));
  if (f.engine !== w.engine || f.voice !== w.voice || f.frames !== w.frames || f.videoHash === w.videoHash)
    throw Error('配对版本或渲染条件无效。');
  const { createBlindReview } = await load('blind-review'),
    blind = createBlindReview(root);
  const title = '整片初版对照 · Artemis I 从地面到返回';
  let study;
  for (const entry of await blind.list()) {
    if (entry.title !== title || entry.kind !== 'pair') continue;
    const existing = await json(path.join(root, 'blind-reviews', entry.id, 'study.json'));
    const sample = existing.samples[0];
    if (sample.clip.hash !== w.videoHash || sample.other.hash !== f.videoHash)
      throw Error('同名研究已有其他封存影片，请保留原记录。');
    study = entry;
    break;
  }
  if (!study)
    study = await blind.create({
      kind: 'pair',
      title,
      samples: [
        {
          mode: 'script',
          fps,
          videoPath: w.videoPath,
          comparisonPath: f.videoPath,
          assetHash: w.videoHash,
          comparisonHash: f.videoHash,
          primary: 'workbench',
          conditions: {
            model,
            effort,
            promptHash: m.promptHash,
            imageHash: m.imageHash,
            inputHash: m.inputHash,
            notes:
              '相同事实、原片、标注图、54秒画幅与声音设置。两端各自首次提交整片镜头选择、时序、完整旁白和重点字；工作台统一以 ' +
              w.engine +
              ' 合成。正常速度盲看事实、镜头选择、声画落点和预计返工。',
          },
        },
      ],
    });
  await freeze(resultFile, study);
  return study;
}

if (action === 'prepare') await makePacket();
else if (action === 'background') await background();
else if (action === 'register') console.log(await register());
else {
  const side = action.slice('render-'.length),
    result = await render(side);
  console.log(side, result.frames, result.duration, result.qaStatus);
}
