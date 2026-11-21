import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDirector } from '../src/production.mjs';
import { applyScenes, reviseLine } from '../src/storyboard.mjs';

const picture = {
  id: 'picture',
  kind: 'image',
  name: '镜头.png',
  path: '/private/fixture-not-for-model.png',
  duration: 0,
  sha256: 'p',
  source: {},
};
const clone = (v) => structuredClone(v);
async function fixture(t, config = {}) {
  const cache = await mkdtemp(path.join(tmpdir(), 'studio-director-test-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const p = {
    id: 'movie',
    mode: 'script',
    title: '两段',
    script: '先看红色。再看蓝色。',
    brief: '测试',
    profile: { fps: 25, width: 640, height: 360 },
    revision: 1,
    style: { id: 'neutral', version: 1 },
    settings: { voiceMode: 'system', musicEnabled: false },
    assets: [clone(picture)],
    timeline: { clips: [] },
    ...config,
  };
  let syntheses = 0,
    transcriptions = 0;
  const store = {
    get: () => clone(p),
    paths: () => ({ cache }),
    setMeta: (_id, meta) => Object.assign(p, clone(meta)),
    async addAsset(_id, file, source) {
      const a = {
        id: 'asset-' + p.revision,
        name: path.basename(file),
        kind: 'audio',
        path: file,
        duration: 2,
        sha256: 'hash-' + p.revision,
        source: clone(source),
      };
      p.assets.push(a);
      p.revision++;
      return clone(a);
    },
    async apply(_id, base, commands) {
      assert.equal(base, p.revision, 'revision write conflict');
      const clips = clone(p.timeline.clips);
      for (const c of commands) {
        const i = clips.findIndex((x) => x.id === c.id);
        if (i >= 0 && clips[i].locked) throw Error('locked');
        if (c.op === 'add') clips.push(clone(c.clip));
        else if (c.op === 'remove') clips.splice(i, 1);
        else if (c.op === 'update') Object.assign(clips[i], clone(c.changes));
      }
      p.timeline.clips = clips;
      p.revision++;
      return clone(p);
    },
  };
  const deps = {
    store,
    media: {},
    audio: {
      async synthesize(_text, { output }) {
        syntheses++;
        await writeFile(output, 'audio');
      },
      async transcribe() {
        transcriptions++;
        return [
          { text: '第一句。', start: 1, end: 3 },
          { text: '第二句。', start: 4, end: 6 },
          { text: '第一句！', start: 7, end: 9 },
        ];
      },
    },
    styleLibrary: {
      async get() {
        return { id: 'neutral', templates: [], references: [] };
      },
    },
  };
  return { p, deps, counts: () => ({ syntheses, transcriptions }) };
}

test('local script measures each generated phrase and reuses unchanged recordings on retry', async (t) => {
  const { p, deps, counts } = await fixture(t);
  const d = createDirector(deps);
  t.after(() => d.close());
  const first = await d.run(p.id, { engine: 'local' });
  assert.equal(first.engine, 'local');
  assert.deepEqual(
    first.project.timeline.clips.filter((c) => c.track === 'narration').map((c) => [c.start, c.duration]),
    [
      [0, 50],
      [50, 50],
    ]
  );
  assert.deepEqual(
    first.project.timeline.clips.filter((c) => c.track === 'caption').map((c) => c.text),
    ['先看红色。', '再看蓝色。']
  );
  await d.run(p.id, { engine: 'local' });
  assert.equal(counts().syntheses, 2);
  assert.equal(p.storyboard.length, 2);
  const unchanged = p.timeline.clips.find((c) => c.id === 'scene-1-narration').assetId;
  await reviseLine(deps, clone(p), 'scene-0-caption', '换一句。');
  assert.equal(counts().syntheses, 3);
  assert.equal(p.timeline.clips.find((c) => c.id === 'scene-1-narration').assetId, unchanged);
});

test('interview keeps the last repeated take, uses the original source window and can restore a deleted utterance', async (t) => {
  const footage = { ...picture, id: 'video', kind: 'video', duration: 12, hasAudio: true };
  const { p, deps, counts } = await fixture(t, {
    mode: 'interview',
    assets: [footage],
    settings: { voiceMode: 'original', musicEnabled: false },
  });
  const d = createDirector(deps);
  t.after(() => d.close());
  await d.run(p.id, { engine: 'local' });
  assert.deepEqual(
    p.timeline.clips
      .filter((c) => c.track === 'video')
      .map((c) => [c.assetId, c.start, c.sourceIn, c.duration, c.gain]),
    [
      ['video', 0, 100, 50, 1],
      ['video', 50, 175, 50, 1],
    ]
  );
  assert.equal(counts().transcriptions, 1);
  assert.equal(counts().syntheses, 0);
  await d.restoreUtterance(p.id, { assetId: 'video', utteranceId: 'video-s0', baseRevision: p.revision });
  const positions=p.timeline.clips.filter(c=>c.track==='video').sort((a,b)=>a.start-b.start).map(c=>[c.start,c.sourceIn]);
  assert.deepEqual(positions,[[0,25],[50,100],[100,175]]);
  const revision=p.revision;
  await d.restoreUtterance(p.id,{assetId:'video',utteranceId:'video-s0',baseRevision:revision});
  assert.equal(p.revision,revision);
});

test('topic claims retain real source links and editorial and visual sources can differ', async (t) => {
  const asset = {
    ...picture,
    source: { url: 'https://example.org/primary', title: '观测结果', statement: '设备在此处采样。' },
  };
  const { p, deps } = await fixture(t, {
    mode: 'topic',
    assets: [asset],
    settings: { voiceMode: 'original', musicEnabled: false },
  });
  const d = createDirector(deps);
  t.after(() => d.close());
  await d.run(p.id, { engine: 'local' });
  assert.equal(p.facts[0].url, asset.source.url);
  await assert.rejects(
    applyScenes(deps, clone(p), [{ assetId: asset.id, narration: '错误。', claimUrl: 'https://elsewhere.test' }]),
    /出处/
  );
  p.factSources = [{ url: 'https://doi.org/verified', excerpt: '独立研究。' }];
  await applyScenes(deps, clone(p), [
    { assetId: asset.id, narration: '独立研究。', claimUrl: p.factSources[0].url },
  ]);
  assert.equal(p.facts[0].visualRole, 'illustration');
  assert.equal(p.facts[0].sourceExcerpt, '独立研究。');
});

test('a concurrent manual edit survives audio synthesis and the old plan is rejected', async (t) => {
  const { p, deps } = await fixture(t);
  deps.audio.synthesize = async (_text, { output }) => {
    await writeFile(output, 'audio');
    p.timeline.clips.push({ id: 'manual', track: 'caption', text: '保留我', start: 0, duration: 10 });
    p.revision++;
  };
  await assert.rejects(
    applyScenes(deps, clone(p), [{ assetId: picture.id, narration: '重新编排' }]),
    /工程已修改/
  );
  assert.deepEqual(
    p.timeline.clips.map((c) => c.id),
    ['manual']
  );
});

test('Codex tools redact local paths and disabled transcripts, reject cross-project edits and preserve locks', async (t) => {
  const { p, deps } = await fixture(t, {
    settings: { voiceMode: 'original', shareFrames: false, shareTranscript: false },
    transcript: { picture: [{ id: 'r', start: 1, end: 2, text: '私有转录' }] },
    timeline: { clips: [{ id: 'cap', track: 'caption', text: '私有转录', locked: true, start: 0, duration: 25 }] },
  });
  deps.client = {
    account: async () => ({ connected: true }),
    thread: async () => 'thread',
    close() {},
    async runTurn({ onStart, tool }) {
      await onStart('turn');
      const ctx = JSON.parse((await tool({ tool: 'studio_context', arguments: {} })).contentItems[0].text);
      assert.equal(ctx.assets[0].path, undefined);
      assert.equal(ctx.transcript.picture[0].text, undefined);
      assert.equal(ctx.timeline.clips[0].text, undefined);
      await assert.rejects(
        tool({ tool: 'studio_frame', arguments: { source: 'asset', id: 'picture', seconds: 0 } }),
        /未开启/
      );
      await assert.rejects(
        tool({ tool: 'studio_edit', arguments: { baseRevision: 0, commandsJson: '[]' } }),
        /版本/
      );
      await assert.rejects(
        tool({
          tool: 'studio_edit',
          arguments: { baseRevision: p.revision, commandsJson: JSON.stringify([{ op: 'remove', id: 'cap' }]) },
        }),
        /锁定/
      );
      return '保留已锁定片段。';
    },
  };
  const d = createDirector(deps);
  const result = await d.run(p.id, { kind: 'revise' });
  assert.equal(result.changed, false);
  assert.equal(p.threadId, 'thread');
  assert.equal(p.timeline.clips.length, 1);
});

test('local mode never substitutes a different voice when clone consent or reference is missing', async (t) => {
  const { p, deps, counts } = await fixture(t, { settings: { voiceMode: 'clone', musicEnabled: false } });
  await assert.rejects(applyScenes(deps, clone(p), [{ assetId: picture.id, narration: '需克隆' }]), /授权/);
  assert.equal(counts().syntheses, 0);
  assert.equal(p.timeline.clips.length, 0);
});

test('visible OCR can anchor a matching graphic, a brightness change alone cannot', async (t) => {
  const { p, deps } = await fixture(t, { settings: { voiceMode: 'original', musicMode: 'none' } });
  deps.styleLibrary.get = async () => ({ id: 'news', templates: [{ id: 'action-result' }] });
  deps.styleLibrary.compileScene = (s) => [
    { id: 'temp', track: 'graphic', text: s.text, start: s.actionFrame, duration: 10 },
  ];
  const beat = {
    assetId: picture.id,
    narration: '灯点亮。',
    actionSourceSeconds: 0.4,
    emphasis: '亮了',
    anchorText: '已点亮',
  };
  await applyScenes(deps, clone(p), [beat]);
  assert.equal(p.timeline.clips.filter((c) => c.track === 'graphic').length, 0);
  await applyScenes(deps, clone(p), [beat], { observedText: new Map([['picture:10', '设备已点亮']]) });
  const graphic = p.timeline.clips.find((c) => c.track === 'graphic');
  assert.equal(graphic.start, 10);
  assert.equal(graphic.anchorSourceFrame, 10);
});

test('explicit original or selected music remains a required gap until a track is selected', async (t) => {
  const { p, deps } = await fixture(t, { settings: { voiceMode: 'original', musicMode: 'original' } });
  deps.audio.createMusicBed = () => assert.fail('an original composition must not resolve to a library bed');
  const result = await applyScenes(deps, clone(p), [{ assetId: picture.id, narration: '画面。' }]);
  assert.equal(p.timeline.clips.filter((c) => c.track === 'music').length, 0);
  assert.equal(
    result.notes.some((n) => n.type === 'required'),
    true
  );
});

test('imported narration remains one original clip including silences; subtitles keep measured timings', async (t) => {
  const audio = { ...picture, kind: 'audio', id: 'recording', duration: 12, hasAudio: true };
  const { p, deps } = await fixture(t, {
    assets: [picture, audio],
    settings: { voiceMode: 'import', narrationAssetId: audio.id, musicMode: 'none' },
  });
  const director = createDirector(deps);
  t.after(() => director.close());
  await director.run(p.id, { engine: 'local' });
  const voices = p.timeline.clips.filter((c) => c.track === 'narration');
  assert.deepEqual(
    voices.map((c) => [c.assetId, c.start, c.sourceIn, c.duration]),
    [['recording', 0, 0, 300]]
  );
  assert.deepEqual(
    p.timeline.clips.filter((c) => c.track === 'caption').map((c) => [c.start, c.duration]),
    [
      [25, 50],
      [100, 50],
      [175, 50],
    ]
  );
  assert.equal(
    p.timeline.clips.filter((c) => c.track === 'video').reduce((n, c) => n + c.duration, 0),
    300
  );
});

test('a new direction goes only to the active project job after its Codex turn receipt exists', async (t) => {
  const { p, deps } = await fixture(t);
  const waiting = Promise.withResolvers(),
    release = Promise.withResolvers(),
    started = Promise.withResolvers(),
    finish = Promise.withResolvers();
  const received = [];
  deps.client = {
    account: async () => ({ connected: true }),
    thread: async () => 'project-chat',
    close() {},
    steer: async (threadId, turnId, text) => {
      received.push([threadId, turnId, text]);
      return { turnId };
    },
    runTurn: async ({ onStart }) => {
      waiting.resolve();
      await release.promise;
      await onStart('active-turn');
      started.resolve();
      await finish.promise;
      return '结束';
    },
  };
  const d = createDirector(deps);
  const running = d.run(p.id, { kind: 'revise', jobId: 'current-job' });
  await waiting.promise;
  const options = { jobId: 'current-job', message: '  换成黄色  ' };
  await assert.rejects(d.steer(p.id, options), (e) => e.status === 409);
  release.resolve();
  await started.promise;
  await assert.rejects(d.steer('other-project', options), (e) => e.status === 409);
  await assert.rejects(d.steer(p.id, { ...options, jobId: 'stale-job' }), (e) => e.status === 409);
  await assert.rejects(d.steer(p.id, { ...options, message: '  ' }), (e) => e.status === 422);
  assert.deepEqual(await d.steer(p.id, options), { turnId: 'active-turn' });
  assert.deepEqual(received, [['project-chat', 'active-turn', '换成黄色']]);
  finish.resolve();
  await running;
  await assert.rejects(d.steer(p.id, options), (e) => e.status === 409);
});
test('the director verifies and opens a registered personal style frame on demand', async t => {
  const {p,deps} = await fixture(t,{settings:{voiceMode:'original',shareFrames:true}});
  deps.styleLibrary.get = async () => ({id:'neutral',version:1,references:[{id:'frame-2',kind:'image',locator:'local:frame',available:null}]});
  let opened;
  deps.styleLibrary.getReference = async (style,version,id) => {
    opened=[style,version,id];return {available:true,verified:true,kind:'image',path:'verified-local-file'};
  };
  deps.media.frameAt=async (file,seconds,target)=>{assert.equal(file,'verified-local-file');await writeFile(target,'test-pixels');};
  deps.client={account:async()=>({connected:true}),thread:async()=>'thread',close(){},async runTurn({onStart,tool}){
    await onStart('turn');
    const ctx=JSON.parse((await tool({tool:'studio_context',arguments:{}})).contentItems[0].text);
    assert.equal(ctx.style.references[0].resolvable,true);
    const response=await tool({tool:'studio_frame',arguments:{source:'style',id:'frame-2',seconds:0}});
    assert.equal(response.contentItems[0].type,'inputImage');return '已核对参考。';
  }};
  const director=createDirector(deps);t.after(()=>director.close());
  await director.run(p.id,{kind:'revise'});assert.deepEqual(opened,['neutral',1,'frame-2']);
});
