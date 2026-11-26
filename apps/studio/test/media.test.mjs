import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createSrt, createAss } from '../src/text-tracks.mjs';
import { renderProject, renderPreviewWindow, mediaCapabilities, probeMedia, frameAt, fileHash } from '../src/media.mjs';
import { ffBase, mediaSlot, run } from '../src/media-runtime.mjs';
import { createMusicBed } from '../src/audio.mjs';

const exec = promisify(execFile);
const profile = { width: 160, height: 96, fps: 30 };

test('closing the app stops the preparation worker and releases its cache lock', { timeout: 20000, skip: process.platform !== 'darwin' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-stop-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'python');
  await writeFile(fake, '#!' + process.execPath + '\n' +
    'const fs=require("node:fs"); process.on("SIGTERM",()=>{fs.writeFileSync(process.env.STAGE_MARKER,"stopped");process.exit(0)});' +
    'fs.writeFileSync(process.env.STAGE_MARKER,String(process.pid));setInterval(()=>{},1000);', { mode: 0o755 });
  for (const [interrupt, expected] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    const marker = path.join(dir, interrupt);
    const cli = spawn(process.execPath, [fileURLToPath(new URL('../scripts/prepare-media.mjs', import.meta.url)), 'clone'], {
      env: { ...process.env, VIDEO_STUDIO_MEDIA_HOME: dir, VIDEO_STUDIO_MLX_PYTHON: fake, STAGE_MARKER: marker }, stdio: 'ignore'
    });
    const closed = once(cli, 'close');
    try {
      let pid;
      for (let tries = 0; tries < 100 && !pid; tries++) { await wait(25); pid = Number(await readFile(marker, 'utf8').catch(() => '')); }
      assert.ok(pid > 0, 'installer started a child worker');
      cli.kill(interrupt);
      assert.equal((await closed)[0], expected);
      assert.equal(await readFile(marker, 'utf8'), 'stopped');
      assert.equal(await stat(path.join(dir, 'prepare.pid')).catch(() => null), null);
    } finally {
      cli.kill('SIGKILL');
      const pid = Number(await readFile(marker, 'utf8').catch(() => ''));
      if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* already reaped */ } }
    }
  }
});

test('visible SRT and composed graphics use the same half-open frame clock', () => {
  const clips = [
    { track: 'caption', start: 2, duration: 3, text: '灯芯{点亮}' },
    { track: 'caption', start: 5, duration: 2, hidden: true, text: '隐藏' },
    { track: 'graphic', start: 0, duration: 8, text: '观察', keyframes: [{ frame: 0, opacity: 0, x: 0.2 }, { frame: 4, opacity: 1, x: 0.5 }] }
  ];
  assert.equal(createSrt(clips, 30), '1\n00:00:00,067 --> 00:00:00,167\n灯芯{点亮}\n');
  const ass = createAss(clips, profile);
  assert.match(ass, /0:00:00\.06,0:00:00\.16/);
  assert.match(ass, /灯芯\\\{点亮\\\}/);
  assert.match(ass, /\\move\(/);
  assert.doesNotMatch(ass, /隐藏/);
});

test('queued inference and renders can be cancelled before acquiring the shared GPU budget', async () => {
  let release;
  const first = mediaSlot(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const second = mediaSlot(() => assert.fail('cancelled job started'), controller.signal);
  controller.abort();
  await assert.rejects(second);
  release(); await first;
  assert.equal(await mediaSlot(() => 3), 3);
});

test('render two cuts and a dissolve, measure pixels, mix audio, read subtitles and reopen', { timeout: 90000 }, async t => {
  const caps = await mediaCapabilities();
  if (!caps.ready) { t.skip('FFmpeg/ffprobe with libass required'); return; }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-media-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const color of ['blue', 'red']) {
    await run(caps.ffmpeg, [...ffBase, '-f', 'lavfi', '-i', `color=c=${color}:s=160x96:r=30:d=3`, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, color + '.mp4')]);
  }
  const bed = await createMusicBed(path.join(dir, 'bed.wav'), { duration: 3, style: 'pulse' });
  const assets = [{ id: 'blue', path: 'blue.mp4' }, { id: 'red', path: 'red.mp4' }, { id: 'audio', path: 'bed.wav' }];
  const clips = [
    { id: 'a', track: 'video', assetId: 'blue', start: 0, duration: 60, sourceIn: 10, speed: 0.7 },
    { id: 'b', track: 'video', assetId: 'red', start: 45, duration: 45, sourceIn: 5, speed: 1.3, transition: { type: 'crossfade', duration: 15 } },
    { id: 'n', track: 'narration', assetId: 'audio', start: 30, duration: 40, sourceIn: 5, gain: 1 },
    { id: 'm', track: 'music', assetId: 'audio', start: 0, duration: 90, gain: 0.3 },
    { id: 'first-cue', track: 'caption', text: '渐变', start: 43, duration: 13, style: { fontSize: 12 } },
    { id: 'moving', track: 'graphic', start: 42, duration: 36, geometry: { x: 0.1, y: 0.36, width: 0.1, height: 0.2 }, keyframes: [{ frame: 36, x: 0.9, scale: 1.4 }], style: { color: '#00ff00' } },
    { id: 't', track: 'caption', text: '进入下一幕', start: 62, duration: 15, style: { fontSize: 12 } }
  ];
  const project = { revision: 2, profile, assets, timeline: { clips } };
  const output = path.join(dir, '样片.mp4');
  const result = await renderProject(project, { output, directory: dir });
  assert.equal(result.frames, 90);
  assert.equal(result.engine, caps.engine);
  assert.equal(result.sha256, await fileHash(output));
  assert.equal(bed.sha256, await fileHash(path.join(dir, 'bed.wav')));
  const info = await probeMedia(output);
  assert.equal(info.duration, 3); assert.equal(info.audioCodec, 'aac');
  assert.match(await readFile(result.srtPath, 'utf8'), /00:00:02,067 --> 00:00:02,567/);
  async function sample(seconds) {
    const { stdout } = await exec(caps.ffmpeg, [...ffBase, '-ss', String(seconds), '-i', output, '-an', '-frames:v', '1', '-vf', 'crop=2:2:0:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
    return Array.from(stdout.subarray(0, 3));
  }
  const [before, mid, after] = await Promise.all([sample(0.5), sample(1.7), sample(2.7)]);
  assert.ok(before[2] > 220 && before[0] < 25, 'outgoing shot is blue');
  assert.ok(mid[0] > 30 && mid[2] > 30, 'both shots visible during dissolve');
  assert.ok(after[0] > 220 && after[2] < 25, 'incoming shot is red');
  const { stdout } = await exec(caps.ffmpeg, [...ffBase, '-i', output, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer' });
  assert.ok([...new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2))].some(n => Math.abs(n) > 600), 'mixed track carries an audible signal');
  const window = { fromFrame: 50, toFrame: 69 };
  const trim = await renderProject(project, { directory: dir, output: path.join(dir, '区间.mp4'), window });
  assert.deepEqual(trim.window, window);
  assert.equal(trim.frames, 19);
  assert.equal((await probeMedia(trim.videoPath)).frames, 19);
  assert.equal(await readFile(trim.srtPath, 'utf8'), '1\n00:00:00,000 --> 00:00:00,200\n渐变\n\n2\n00:00:00,400 --> 00:00:00,633\n进入下一幕\n');
  const adjusted={...project,timeline:{clips:clips.map(c=>c.track==='narration'?{...c,muted:true}:c)}};
  const options={directory:dir,window:{fromFrame:49,toFrame:68}};
  const fromPicture=path.join(dir,'current-mix.mp4'),composed=path.join(dir,'current-composed.mp4');
  await renderPreviewWindow(adjusted,{...options,output:fromPicture,frozenPicture:output});
  await renderPreviewWindow(adjusted,{...options,output:composed});
  const pcm=async file=>(await exec(caps.ffmpeg,[...ffBase,'-i',file,'-map','0:a:0','-f','s16le','pipe:1'],{encoding:'buffer'})).stdout;
  assert.deepEqual(await pcm(fromPicture),await pcm(composed));
  assert.equal((await probeMedia(fromPicture)).frames,19);
  assert.equal(await readFile(fromPicture.replace('.mp4','.srt'),'utf8'),await readFile(composed.replace('.mp4','.srt'),'utf8'));
  async function pixels(file, frame) {
    const { stdout } = await exec(caps.ffmpeg, [...ffBase, '-i', file, '-an', '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
    return stdout;
  }
  const expectedStart=await pixels(output,options.window.fromFrame);
  const actualStart=await pixels(fromPicture,0);
  assert.equal(actualStart.length,expectedStart.length);
  assert.ok(actualStart.reduce((sum,n,i)=>sum+Math.abs(n-expectedStart[i]),0)/actualStart.length<2);
  let priorX = -Infinity;
  for (const frame of [0, 4, 10, 18]) {
    const [original, excerpt] = await Promise.all([pixels(output, window.fromFrame + frame), pixels(trim.videoPath, frame)]);
    assert.equal(excerpt.length, profile.width * profile.height * 3);
    let error = 0, green = 0, x = 0;
    for (let i = 0; i < excerpt.length; i++) error += Math.abs(excerpt[i] - original[i]);
    for (let i = 0; i < excerpt.length; i += 3) {
      if (excerpt[i + 1] > 150 && excerpt[i] < 60 && excerpt[i + 2] < 60) { green++; x += (i / 3) % profile.width; }
    }
    assert.ok(error / excerpt.length < 2.5, 'excerpt pixels match the same full-project dissolve, keyframe and subtitle position');
    assert.ok(green > 100 && x / green > priorX + 5, 'the original keyframed shape continues moving');
    priorX = x / green;
  }
  const { stdout: excerptPcm } = await exec(caps.ffmpeg, [...ffBase, '-i', trim.videoPath, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer' });
  const excerptAudio = new Int16Array(excerptPcm.buffer, excerptPcm.byteOffset, Math.floor(excerptPcm.length / 2));
  const wholeAudio = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
  let aa = 0, ab = 0, bb = 0;
  for (let n = 400; n < excerptAudio.length - 400; n++) {
    const a = excerptAudio[n], b = wholeAudio[Math.round(8000 * window.fromFrame / profile.fps) + n];
    aa += a * a; ab += a * b; bb += b * b;
  }
  assert.ok(ab / Math.sqrt(aa * bb) > 0.97, 'excerpt preserves the source and ducked mix clock');
  await assert.rejects(renderProject(project, { directory: dir, output, window: { fromFrame: 72, toFrame: 95 } }), /工程内/);
  const jpg = path.join(dir, 'frame.jpg');
  await frameAt(output, 2.5, jpg, { maxWidth: 80 });
  assert.equal((await probeMedia(jpg)).width, 80);
  const bad = structuredClone(project); bad.timeline.clips[0].sourceIn = 99999;
  await assert.rejects(renderProject(bad, { output, directory: dir }), /超出原素材时长/);
  assert.equal(await fileHash(output), result.sha256, 'invalid edit never replaces previous delivery');
  const ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(async () => renderProject(project, { output: path.join(dir, 'cancel.mp4'), directory: dir, signal: ctrl.signal }));
  assert.equal(await stat(path.join(dir, 'cancel.mp4')).catch(() => null), null);
});
test('a single-frame JPEG can supply the cover and the first source preview',async t=>{
  const {ffmpeg}=await mediaCapabilities();if(!ffmpeg){t.skip('requires FFmpeg');return;}
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-single-picture-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,'original.jpg'), preview=path.join(dir,'cover.png');
  await run(ffmpeg,[...ffBase,'-f','lavfi','-i','color=c=blue:s=180x120','-frames:v','1','-update','1',source]);
  await frameAt(source,0,preview);
  const info=await probeMedia(preview);assert.equal(info.kind,'image');assert.equal(info.width,180);assert.equal(info.height,120);
});
