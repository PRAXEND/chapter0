import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDirector } from '../src/production.mjs';
import { applyScenes, reviseLine, durationNotes } from '../src/storyboard.mjs';
import {
  checkVisualPlan,
  requiresFourStages,
  usesVisualStages,
  motionPolicy,
  motionCoverage,
  currentReviewWindows,
  prepareVisuals,
} from '../src/director-visual.mjs';
import { alignScript } from '../src/speech-alignment.mjs';

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
test('automatic editorial review honours the chosen stages and a user can expressly require four',async t=>{
  const {p,deps}=await fixture(t,{settings:{autoReview:true,shareFrames:true},timeline:{clips:[{id:'shot',track:'video',assetId:'picture',start:0,duration:27}]}});
  const beat={assetId:'picture',visualSteps:[{stage:'verification',atSeconds:0,label:'记录',observation:'原图显示条纹。'}]};
  const frame={source:'asset',assetId:'picture',assetHash:'p',seconds:0};
  assert.equal(requiresFourStages(p),false);checkVisualPlan([beat],p,[frame]);
  assert.throws(()=>checkVisualPlan([beat],p,[]),/真实图像/);
  const drafts={open:async()=>({name:'draft.mp4',fromFrame:0})};
  deps.media.frameAt=async(_file,seconds,dest)=>writeFile(dest,'frame@'+seconds);
  const verified=await prepareVisuals({...deps,drafts},p,'verify',[],undefined,null);
  assert.deepEqual(verified.gaps,[]);assert.equal(verified.result[0].frame.stage,'shot');
  p.brief='请按四个阶段制作。';assert.equal(requiresFourStages(p),true);assert.throws(()=>checkVisualPlan([beat],p,[frame]),/四个阶段/);
});
test('an illustrated explanation is checked before and after the change on its actual shot',async t=>{
  const {p,deps}=await fixture(t);
  p.settings.shareFrames=true;
  p.timeline.clips=[
    {track:'video',id:'test-shot',assetId:'picture',start:0,duration:75},
    {track:'graphic',id:'test-anchor',start:0,duration:75,evidenceAnchor:{stage:'mechanism',assetId:'picture',sha256:'p',stepId:'phase'}}
  ];
  deps.drafts={open:async()=>({name:'draft.mp4',fromFrame:0})};
  deps.media.frameAt=async(_file,seconds,dest)=>writeFile(dest,Buffer.from('frame '+seconds));
  p.facts=[{claimKind:'explanation',visualRole:'illustration',start:0}];
  const frames=async()=>(await prepareVisuals(deps,p,'verify',[],undefined,'video-first')).result.map(x=>x.frame.frame);
  assert.deepEqual(await frames(),[11,68]);
  p.facts[0].claimKind='observation';
  assert.deepEqual(await frames(),[11]);
  p.settings.shareFrames=false;
  assert.deepEqual(await frames(),[]);
});
test('each spoken explanation is checked when heard even if its diagram appears in another shot', async t => {
  const {p, deps} = await fixture(t);
  p.settings.shareFrames = true;
  p.storyboard = [
    {claimKind:'explanation', speechGroup:'cause'},
    {claimKind:'explanation', speechGroup:'process'},
    {claimKind:'observation', speechGroup:'ending'},
    {claimKind:'explanation', speechGroup:'muted'},
  ];
  p.timeline.clips = [
    {track:'video', id:'field', assetId:'picture', start:0, duration:200},
    {track:'narration', id:'cause', start:21, duration:70},
    {track:'graphic', id:'diagram', start:105, duration:60,
      evidenceAnchor:{stage:'mechanism', assetId:'picture', sha256:'p', stepId:'diagram'}},
    {track:'narration', id:'process', start:110, duration:40},
    {track:'narration', id:'ending', start:165, duration:35},
    {track:'narration', id:'muted', muted:true, start:0, duration:25},
  ];
  deps.drafts = {open:async () => ({name:'preview.mp4', fromFrame:0})};
  deps.media.frameAt = async (_file, seconds, dest) => writeFile(dest, Buffer.from('frame ' + seconds));
  const check = async () => (await prepareVisuals(deps, p, 'verify', [])).result.map(r => r.frame);
  let frames = await check();
  assert.deepEqual(frames.filter(f => f.claimOnset).map(f => f.frame).sort((a,b) => a-b), [27,116]);
  assert.equal(frames.filter(f => f.frame === 116).length, 1);
  p.timeline.clips[1].assetId = 'picture';
  p.speechAlignments = {p:{audible:{start:.64, end:1.6}}};
  frames = await check();
  assert.ok(frames.some(f => f.claimOnset && f.frame === 43));
  p.timeline.clips[1].enabled = false;
  frames = await check();
  assert.deepEqual(frames.filter(f => f.claimOnset).map(f => f.frame), [116]);
});
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

test('synthetic captions follow actual voice windows, preserve approved words and revise a single cue group', async (t) => {
  const { p, deps, counts } = await fixture(t);
  const first = '请先观察红色指示灯，',
    second = '再确认蓝色灯光。',
    secondLine = '列车已经到站。';
  let recognized = first;
  let calls = 0;
  deps.audio.transcribe = async (file, opts) => {
    assert.equal(opts.maxChars, 8);
    assert.ok(file);
    calls++;
    if (calls === 2) return [{ text: secondLine, start: 0.3, end: 1.65 }];
    return [
      { text: recognized.replace('灯', '登'), start: 0.2, end: 0.85 },
      { text: second, start: 1.12, end: 1.83 },
    ];
  };
  const beats = [first + second, secondLine].map((narration) => ({ assetId: picture.id, narration }));
  await applyScenes(deps, clone(p), beats);
  const cues = () =>
    p.timeline.clips
      .filter((c) => c.track === 'caption' && c.speechGroup === 'scene-0-narration')
      .sort((a, b) => a.start - b.start);
  assert.deepEqual(
    cues().map((c) => [c.text, c.start, c.duration]),
    [
      [first, 5, 16],
      [second, 28, 18],
    ]
  );
  assert.equal(p.timeline.clips.find((c) => c.id === 'scene-0-narration').duration, 50);
  assert.ok(cues().every((c) => c.cueTiming === 'asr-segments'));
  await applyScenes(deps, clone(p), beats);
  assert.equal(calls, 2, 'a matching audio hash and approved-script hash reuses measured timing');
  assert.equal(counts().syntheses, 2);
  const protectedVoice = p.timeline.clips.find((c) => c.id === 'scene-1-narration');
  protectedVoice.locked = true;
  const otherGroup = clone(p.timeline.clips.filter((c) => c.id.startsWith('scene-1-')));
  const revised = '请先观察绿色指示灯，';
  recognized = revised;
  await reviseLine(deps, clone(p), 'scene-0-caption', revised);
  assert.deepEqual(
    cues().map((c) => c.text),
    [revised, second]
  );
  assert.deepEqual(
    p.timeline.clips.filter((c) => c.id.startsWith('scene-1-')),
    otherGroup
  );
  assert.equal(calls, 3);
  assert.ok(p.assets.some((a) => a.source.text === revised + second));
  p.timeline.clips.find((c) => c.id === 'scene-0-caption-2').locked = true;
  await assert.rejects(reviseLine(deps, clone(p), 'scene-0-caption', '再改一遍'), /锁定/);
  assert.equal(calls, 3);
});

test('long phrases retain unrecognized proper names, expose estimated subsegment boundaries and recover without ASR', async (t) => {
  const { p, deps } = await fixture(t);
  const words = '火箭朝夜色中的发射场慢慢移动，镜头跟着运输车一直走到开阔的场地。';
  const timed = alignScript(words, [{ text: words.replace('运输车', '运树车'), start: 0, end: 7 }], 7.5, {
    start: 0.31,
    end: 6.48,
  });
  assert.equal(timed.method, 'whisper.cpp');
  assert.ok(timed.cues.length >= 2);
  assert.equal(timed.cues[0].start, 0.31);
  assert.equal(timed.cues.at(-1).end, 6.48);
  assert.equal(timed.cues.map((c) => c.text).join(''), words);
  assert.ok(timed.cues.some((c) => c.timing === 'within-segment'));
  deps.audio.transcribe = async () => {
    throw Error('离线模型未准备');
  };
  await applyScenes(deps, clone(p), [{ assetId: picture.id, narration: words }]);
  assert.equal(Object.values(p.speechAlignments)[0].method, 'duration-fallback');
  assert.ok(p.directorNotes.some((n) => n.kind === 'speech-alignment' && n.message.includes('总时长')));
  const c = p.timeline.clips.find((c) => c.track === 'caption'),
    v = p.timeline.clips.find((c) => c.track === 'narration');
  p.timeline.clips = p.timeline.clips.filter((x) => x.track !== 'caption' || x === c);
  delete c.speechGroup;
  delete v.speechGroup;
  c.start = v.start;
  c.duration = v.duration;
  c.text = words;
  await reviseLine(deps, clone(p), v.id, '旧工程新旁白。');
  assert.equal(p.timeline.clips.find((c) => c.track === 'caption').speechGroup, v.id);
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

test('sharing interview transcripts omits dedicated voice recordings and deleted assets from legacy projects', async (t) => {
  const { p, deps } = await fixture(t, {
    settings: { voiceMode: 'original', shareTranscript: true },
    assets: [clone(picture), { id: 'speaker', kind: 'video', source: { sourceVoice: 'enrolled' } }],
    transcript: {
      picture: [{ id: 'line', text: '已授权的采访', start: 0, end: 1 }],
      speaker: [{ id: 'private', text: '音色样本中的旧转录', start: 0, end: 2 }],
      removed: [{ id: 'old', text: '已移除的采访', start: 0, end: 2 }],
    },
  });
  deps.client = {
    account: async () => ({ connected: true }), thread: async () => 'thread', close() {},
    async runTurn({ onStart, tool }) {
      await onStart('turn');
      const ctx = JSON.parse((await tool({ tool: 'studio_context', arguments: {} })).contentItems[0].text);
      assert.deepEqual(ctx.utteranceCounts, { picture: 1 });
      assert.deepEqual(Object.keys(ctx.transcript), ['picture']);
      assert.equal(ctx.transcript.picture[0].text, '已授权的采访');
      assert.ok(!JSON.stringify(ctx).includes('音色样本中的旧转录'));
      await assert.rejects(tool({ tool: 'studio_transcript', arguments: { assetId: 'speaker' } }), /专用音色参考/);
      await assert.rejects(tool({ tool: 'studio_transcript', arguments: { assetId: 'removed' } }), /没有该素材/);
      return '已查看采访。';
    },
  };
  const director = createDirector(deps);
  t.after(() => director.close());
  assert.equal((await director.run(p.id, { kind: 'revise' })).changed, false);
});

test('local mode never substitutes a different voice when clone consent or reference is missing', async (t) => {
  const { p, deps, counts } = await fixture(t, { settings: { voiceMode: 'clone', musicEnabled: false } });
  await assert.rejects(applyScenes(deps, clone(p), [{ assetId: picture.id, narration: '需克隆' }]), /授权/);
  assert.equal(counts().syntheses, 0);
  assert.equal(p.timeline.clips.length, 0);
});

test('fixed project sources bypass every external lookup and the director can inspect any source interval with time labels',async t=>{
  const fact={url:'https://example.org/experiment',title:'试验说明',excerpt:'A repeatable pattern.'};
  const film={...picture,id:'candidate-source',kind:'video',duration:75,source:{url:'https://example.org/footage'}};
  const {p,deps}=await fixture(t,{mode:'topic',assets:[film],factSources:[fact],brief:'固定素材。https://example.org/avoid',
    settings:{sourceScope:'project',shareFrames:true,voiceMode:'original',musicMode:'none',factUrls:['https://example.org/avoid'],sourceUrls:['https://example.org/avoid.mov']}});
  const style={id:'test',rules:[{id:'video-first',instruction:'实拍优先'},{id:'first-five-seconds',instruction:'自订开场条件'},{id:'deduplicate-source-windows',instruction:'自订复用条件'}],templates:[],references:[]};
  deps.styleLibrary.get=async()=>style;deps.scanMotionWindows=async()=>({candidates:[]});
  deps.media.frameAt=async(_file,seconds,target)=>writeFile(target,Buffer.from('source@'+seconds));
  let calls=0,external=0;const net=async()=>{external++;throw Error('unexpected external request');};
  Object.assign(deps,{searchSources:net,importSource:net,searchFacts:net,readBriefSources:net,
    client:{account:async()=>({connected:true}),thread:async()=>'thread',close(){},async runTurn({onStart,prompt,tool}){
      calls++;await onStart('turn');
      const call=(name,args)=>tool({tool:name,arguments:args});
      assert.ok(prompt.includes('自订开场条件')&&prompt.includes('自订复用条件')&&prompt.includes('任意原片'));
      const ctx=JSON.parse((await call('studio_context',{})).contentItems[0].text);
      assert.equal(ctx.sourceScope,'project');assert.deepEqual(ctx.factSources,[fact]);
      await assert.rejects(call('studio_find',{query:'example'}),/固定/);
      await assert.rejects(call('studio_import',{candidateId:'anything'}),/固定/);
      const cached=JSON.parse((await call('studio_research',{query:'example',readUrl:fact.url})).contentItems[0].text);
      assert.deepEqual(cached.sources,[fact]);
      const seq=await call('studio_frames',{source:'asset',id:film.id,startSeconds:58,count:3});
      assert.deepEqual(seq.contentItems.map(x=>x.type),['inputText','inputImage','inputText','inputImage','inputText','inputImage']);
      assert.ok(seq.contentItems[0].text.includes('58')&&seq.contentItems[4].text.includes('58.08'));
      assert.equal(Buffer.from(seq.contentItems[5].imageUrl.split(',')[1],'base64').toString(),'source@58.08');
      const result=JSON.parse((await call('studio_sequence',{baseRevision:p.revision,beats:[{assetId:film.id,sourceStart:58,sourceEnd:60,durationSeconds:2,narration:'试验出现图案。',claimUrl:film.source.url}],motionGap:'短镜头仅能说明可见现象。'})).contentItems[0].text);
      assert.ok(result.timing.seconds>=1);
      return '已提交。';
    }}});
  const director=createDirector(deps);t.after(()=>director.close());await director.run(p.id,{jobId:'fixed-composition'});
  assert.equal(external,0);assert.equal(calls,1);assert.deepEqual(p.factSources,[fact]);
  assert.ok(p.visualDirection.frames.some(f=>f.delivery==='tool'&&f.seconds===58.08));
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
test('timeline inspection requests the exact frame from the same versioned preview used in the workbench',async t=>{
  const {p,deps}=await fixture(t,{settings:{voiceMode:'original',shareFrames:true},timeline:{clips:[{id:'shot',track:'video',assetId:'picture',start:0,duration:300}]}});
  let checked=false;
  deps.drafts={async open(project,from){assert.equal(project.revision,p.revision);assert.equal(from,150);return {name:'cached.mp4',fromFrame:150};}};
  deps.media.frameAt=async(file,seconds,target)=>{assert.ok(file.endsWith('/drafts/cached.mp4'));assert.equal(seconds,1.2);checked=true;await writeFile(target,'test-pixels');};
  deps.client={account:async()=>({connected:true}),thread:async()=>'t',close(){},async runTurn({onStart,tool}){
    await onStart('turn');
    await tool({tool:'studio_frame',arguments:{source:'timeline',seconds:7.2}});
    await assert.rejects(tool({tool:'studio_frame',arguments:{source:'timeline',seconds:12}}),/超出|超过/);return '已核对。';
  }};
  const director=createDirector(deps);t.after(()=>director.close());
  await director.run(p.id,{kind:'revise'});assert.equal(checked,true);
});

test('the registered storyboard accepts per-event mute or a project audio asset without requiring either', async (t) => {
  const { p, deps } = await fixture(t);
  const client = {
    account: async () => ({ connected: true }),
    thread: async (_id, tools) => {
      const shape = tools.find((tool) => tool.name === 'studio_sequence').inputSchema.properties.beats.items;
      assert.equal(shape.properties.soundEnabled.type, 'boolean');
      assert.equal(shape.properties.soundAssetId.type, 'string');
      assert.equal(shape.required.includes('soundEnabled'), false);
      assert.equal(shape.required.includes('soundAssetId'), false);
      assert.equal(shape.additionalProperties, false);
      return 'test-thread';
    },
    runTurn: async ({ onStart }) => {
      await onStart('test-turn');
      return '已读取工程。';
    },
    close() {},
  };
  const director = createDirector({ ...deps, client });
  t.after(() => director.close());
  await director.run(p.id, { kind: 'revise', message: '查看可用的动作音效' });
});

test('Chinese local topic drafts preserve foreign captions only as sources and honor supplied scripts', async (t) => {
  const a = {
    ...picture,
    source: { url: 'https://images.nasa.gov/details/x', statement: 'Close-up of a footprint.' },
  };
  const { p, deps, counts } = await fixture(t, {
    mode: 'topic',
    script: '',
    brief: '请用中文旁白解释这个印迹。',
    assets: [a],
  });
  const director = createDirector(deps);
  t.after(() => director.close());
  const draft = await director.run(p.id, { engine: 'local' });
  assert.equal(counts().syntheses, 0);
  assert.equal(
    p.timeline.clips.some((c) => c.track === 'caption' || c.track === 'narration'),
    false
  );
  assert.equal(p.facts[0].text, a.source.statement);
  assert.ok(draft.notes.some((x) => x.kind === 'narration-language'));
  p.script = '这是地面留下的印迹。';
  await director.run(p.id, { engine: 'local' });
  assert.equal(counts().syntheses, 1);
  assert.equal(p.timeline.clips.find((c) => c.track === 'caption').text, p.script);
});

for (const sharing of [true, false])
  test('derived science styles submit a witnessed sequence with shareFrames=' + sharing, async (t) => {
    const { p, deps } = await fixture(t, {
      style: { id: 'my-science', version: 1 },
      settings: { voiceMode: 'original', musicMode: 'none', shareFrames: sharing },
    });
    const stages = ['problem', 'detail', 'mechanism', 'verification'];
    const baseline = {
      id: 'trusted',
      kind: 'video',
      duration: 8,
      available: true,
      path: '/private/local/base.mp4',
      sha256: 'refhash',
    };
    const actualStyle = {
      ...p.style,
      sha256: 'versionhash',
      baseline,
      references: [baseline],
      templates: [{ id: 'step-reveal' }],
      executionPlan: {
        template: 'step-reveal',
        stages: Object.fromEntries(stages.map((s) => [s, {}])),
        notes: '按动作配合逐段作证',
      },
      rules: [
        { id: 'proof', instruction: '观察具体部位', check: '切点后可见', evidence: '/Users/hidden/private.mov' },
      ],
    };
    assert.ok(usesVisualStages(actualStyle));
    assert.equal(usesVisualStages({ id: 'neutral', version: 8 }), false);
    deps.styleLibrary.get = async () => actualStyle;
    deps.media.frameAt = async (file, seconds, dest) => {
      assert.ok(sharing);
      await writeFile(dest, Buffer.from(file + ' ' + seconds));
    };
    deps.drafts = { open: async (_p, from) => ({ fromFrame: from, name: 'approved.mp4' }), close: async () => {} };
    deps.compileSceneWithSound = async (_styles, _store, _proj, scene) => ({
      clips: scene.visualSteps.map((s) => ({
        track: 'graphic',
        text: s.label,
        start: s.atFrame,
        duration: 5,
        visualStage: s.stage,
      })),
    });
    const beats = stages.map((stage) => ({
      assetId: picture.id,
      narration: '原图里看见纹路。',
      durationSeconds: 3,
      visualSteps: [
        {
          stage,
          atSeconds: 0,
          label: '纹路',
          observation: '纹路中间有相间的亮暗',
          region: { x: 0.42, y: 0.47, width: 0.18, height: 0.13 },
        },
      ],
    }));
    let turns = 0;
    const call = (tool, name, args = {}) => tool({ tool: name, arguments: args });
    deps.client = {
      account: async () => ({ connected: true }),
      thread: async () => 'project-thread',
      close() {},
      modelForThread: () => 'matched-model',
      runTurn: async ({ tool, onStart, images, prompt }) => {
        await onStart('turn-' + ++turns);
        if (turns === 1) {
          assert.equal(images.length, sharing ? 5 : 0);
          const context = JSON.parse((await call(tool, 'studio_context')).contentItems[0].text);
          assert.equal(context.style.rules[0].check, '切点后可见');
          assert.ok(!JSON.stringify(context.style).includes('/Users/hidden'));
          await call(tool, 'studio_sequence', { baseRevision: p.revision, beats });
        } else {
          assert.ok(prompt.includes('真实合成图'));
          const fs = p.visualDirection.frames.filter((f) => f.source === 'timeline');
          assert.deepEqual(new Set(fs.map((f) => f.stage)), new Set(stages));
          await call(tool, 'studio_visual_review', {
            baseRevision: p.revision,
            checks: fs.map((f) => ({
              stage: f.stage,
              frame: f.frame,
              observation: '框内保留亮暗细节',
              needsFix: false,
            })),
          });
        }
        return '完成';
      },
    };
    const director = createDirector(deps);
    t.after(() => director.close());
    const result = await director.run(p.id, { jobId: 'test-job' });
    assert.equal(p.visualDirection.status, sharing ? 'reviewed' : 'blocked-by-privacy');
    assert.equal(turns, sharing ? 2 : 1);
    assert.equal(p.timeline.clips.filter((c) => c.track === 'graphic').length, 4);
    assert.ok(p.storyboard.every((s) => !!s.visualSteps[0].witnessFrameHash === sharing));
    if (!sharing) assert.ok(result.notes.some((n) => n.kind === 'visual-evidence'));
    if (sharing) assert.throws(() => checkVisualPlan(beats, p, []), /真实图像/);
  });

test('material mechanisms bind their research excerpt while a photograph keeps its own credit',async t=>{
  const photo={...picture,source:{url:'https://example.org/camera',statement:'A photograph of two damp fibers.'}};
  const research={url:'https://example.org/research',title:'Fiber measurements',excerpt:'Capillary pressure draws liquid into spaces between the fibers.',type:'paper'};
  const {p,deps}=await fixture(t,{mode:'topic',script:'',settings:{voiceMode:'original',musicMode:'none'},assets:[photo],factSources:[research]});
  const beat={assetId:photo.id,narration:'在小间隙中，毛细压差带动液体移动。',claimKind:'explanation',claimUrl:photo.source.url,claimQuote:research.excerpt};
  await assert.rejects(applyScenes(deps,clone(p),[beat]),/摄影图注/);await assert.rejects(applyScenes(deps,clone(p),[{...beat,claimUrl:research.url,claimQuote:'这段文字没有出现在论文中。'}]),/逐字/);
  await applyScenes(deps,clone(p),[{...beat,claimUrl:research.url}]);assert.equal(p.facts[0].url,research.url);assert.equal(p.facts[0].sourceExcerpt,research.excerpt);assert.equal(p.facts[0].visualSourceUrl,photo.source.url);assert.equal(p.facts[0].visualRole,'illustration');
});

test('edits move the actual rendered geometry and preserve keyframed movement and existing colors',async t=>{
  const {p,deps}=await fixture(t,{timeline:{clips:[{id:'focus',track:'graphic',start:0,duration:50,text:'看这处',geometry:{x:.3,y:.7,width:.25},style:{color:'#aabbcc',fontSize:30},keyframes:[{frame:0,x:.3,y:.7},{frame:38,x:.4,y:.7}]}]}});
  deps.client={account:async()=>({connected:true}),thread:async()=> 'c',close(){},runTurn:async({tool,onStart})=>{await onStart('t');const edit=(changes)=>tool({tool:'studio_edit',arguments:{baseRevision:p.revision,commandsJson:JSON.stringify([{op:'update',id:'focus',changes}])}});await assert.rejects(edit({x:-54,y:192}),/像素/);await edit({x:.5,y:.7,fontSize:42});return '完成';}};
  const d=createDirector(deps);t.after(()=>d.close());await d.run(p.id,{kind:'revise'});const c=p.timeline.clips[0];assert.equal(c.geometry.x,.5);assert.equal(c.geometry.width,.25);assert.equal(c.x,undefined);assert.equal(c.style.fontSize,42);assert.equal(c.style.color,'#aabbcc');assert.ok(Math.abs(c.keyframes[1].x-.6)<1e-6);
});

test('video-first distinguishes returning to an image from images-only; real motion needs two source witnesses and a concrete observation', () => {
  const style = { rules: [{ id: 'video-first' }] },
    p = {
      brief: '请自己找任务原照，最后回到照片。',
      profile: { fps: 24 },
      assets: [
        { id: 'movie', kind: 'video', sha256: 'sha' },
        { id: 'image', kind: 'image', sha256: 'still' },
      ],
      storyboard: [
        {
          assetId: 'movie',
          start: 500,
          videoClipId: 'moving',
          motionEvidence: { fromSeconds: 2, toSeconds: 3, observation: '两只前轮离开蓝线，移动到标尺下方。' },
        },
      ],
      timeline: {
        clips: [
          { id: 'moving', assetId: 'movie', track: 'video', start: 0, duration: 168, sourceIn: 48 },
          { id: 'still', assetId: 'image', track: 'video', start: 168, duration: 432 },
        ],
      },
    };
  assert.equal(motionPolicy(style, p), 'video-first');
  assert.equal(motionPolicy(style, { ...p, brief: '全片只使用提供的照片。' }), 'images-only');
  assert.equal(motionPolicy(style, { ...p, brief: '不要只用照片。' }), 'video-first');
  const frames = [
    { source: 'asset', assetId: 'movie', assetHash: 'sha', seconds: 2, sha256: 'first' },
    { source: 'asset', assetId: 'movie', assetHash: 'sha', seconds: 3, sha256: 'second' },
  ];
  const low = motionCoverage(
    p,
    frames,
    'video-first',
    [{ kind: 'video', query: 'model cart flag crossing', found: 2 }],
    '缺少车轮离地后的完整窗口'
  );
  assert.deepEqual([low.videoFrames, low.stillFrames, low.witnessedFrames, low.totalFrames], [168, 432, 168, 600]);
  assert.ok(low.gap.includes('7.0 / 25.0'));
  assert.equal(low.windows[0].fromHash, 'first');
  p.timeline.clips[0].duration = 432;
  p.timeline.clips[1].start = 432;
  p.timeline.clips[1].duration = 168;
  assert.equal(motionCoverage(p, frames, 'video-first').gap, '');
  assert.equal(
    motionCoverage(p, [frames[0], { ...frames[1], sha256: 'first' }], 'video-first').witnessedFrames,
    0
  );
  assert.equal(motionCoverage(p, [], 'images-only').gap, '');
});

test('actual cut and visible anchored layers determine present review windows after trimming; stale duration hints clear', () => {
  const p = {
    profile: { fps: 24 },
    settings: { targetDuration: 25 },
    assets: [{ id: 'a', sha256: 'h', kind: 'image' }],
    storyboard: [
      {
        videoClipId: 'shot',
        assetId: 'a',
        start: 516,
        duration: 162,
        visualSteps: [{ stage: 'verification', atFrame: 654, assetHash: 'h' }],
      },
    ],
    timeline: {
      clips: [
        { id: 'before', track: 'video', assetId: 'a', start: 0, duration: 462 },
        { id: 'shot', track: 'video', assetId: 'a', start: 462, duration: 138 },
        {
          id: 'mark',
          track: 'graphic',
          start: 515,
          duration: 60,
          evidenceAnchor: { assetId: 'a', sha256: 'h', stage: 'verification', stepId: 'one' },
        },
      ],
    },
    directorNotes: [
      { message: '当前成片长 28.3 秒，本期目标为 25 秒。' },
      { kind: 'speech-alignment', message: '另项仍在' },
    ],
  };
  assert.deepEqual(
    currentReviewWindows(p).slots.map((s) => [s.stage, s.atFrame, s.end]),
    [['verification', 515, 575]]
  );
  assert.deepEqual(durationNotes(p), [p.directorNotes[1]]);
  p.timeline.clips[1].duration = 6;
  assert.equal(
    currentReviewWindows(p).slots.some((s) => s.atFrame >= 468 || s.end > 468),
    false
  );
});

for (const sharing of [true, false])
  test('video-first without a science template sees actual paired windows before writing, shareFrames=' + sharing, async t => {
    const film = { ...picture, id: 'lab', kind: 'video', duration: 52, sha256: 'hash-of-lab' };
    const { p, deps } = await fixture(t, { style: { id: 'field-films', version: 3 }, assets: [film],
      settings: { voiceMode: 'original', musicMode: 'none', shareFrames: sharing } });
    deps.styleLibrary.get = async () => ({ ...p.style, rules: [{ id: 'video-first' }], templates: [], references: [] });
    let scans = 0;
    deps.scanMotionWindows = async () => {
      scans++;
      return { decoded: 104, plan: [{ start: 0, duration: 52 }], counts: { still: 57 }, quiet: [[0, 20]],
        candidates: [{ sourceStart: 23, sourceEnd: 29, fromSeconds: 23, toSeconds: 25, activeFraction: 1 },
          { sourceStart: 34, sourceEnd: 40, fromSeconds: 34, toSeconds: 36, activeFraction: .8 }] };
    };
    deps.media.frameAt = async (file, sec, dest) => writeFile(dest, Buffer.from('pixel-frame:' + sec));
    deps.client = { account: async () => ({ connected: true }), thread: async () => 'motion-project', close() {},
      runTurn: async ({ prompt, tool, images, onStart }) => {
        await onStart('motion-first-turn');
        assert.equal(images.length, sharing ? 4 : 0);
        assert.equal(prompt.includes('本地低分辨率运动线索'), sharing);
        assert.ok(!prompt.includes('/private/fixture'));
        const submit = beat => tool({ tool: 'studio_sequence', arguments: { baseRevision: p.revision, beats: [beat] } });
        const at = (start, end) => ({ assetId: film.id, narration: '留意屏幕右侧装置的位置。', sourceStart: start, sourceEnd: end,
          durationSeconds: 5, motionEvidence: { fromSeconds: start, toSeconds: start + 2, observation: '装置从右侧移向标线。' } });
        if (sharing) {
          await assert.rejects(submit(at(5, 9)), /所选源区间.*其他候选/);
          assert.equal(p.storyboard, undefined);
          assert.equal(p.timeline.clips.length, 0);
          assert.equal(p.visualDirection.motionScans[0].candidates[0].fromHash.length, 64);
        }
        await submit(at(23, 29));
        return { message: '初版' };
      } };
    const d = createDirector(deps); t.after(() => d.close());
    await d.run(p.id, { kind: 'produce', jobId: 'motion-job' });
    assert.equal(scans, sharing ? 1 : 0);
    assert.equal(p.timeline.clips.find(c => c.track === 'video').sourceIn, 575);
    assert.equal(p.visualDirection.status, sharing ? 'motion-planned' : 'blocked-by-privacy');
  });

test('the director can place a native JSX beat on first cut and revise its second cue without stale or locked writes',async t=>{
  const {p,deps}=await fixture(t);
  deps.client={account:async()=>({connected:true}),thread:async()=> 'thread',close(){},
    async runTurn({onStart,tool}){
      await onStart('turn');
      const call=async(name,args)=>JSON.parse((await tool({tool:name,arguments:args})).contentItems[0].text);
      assert.equal((await call('studio_context',{})).motionComponents.length,6);
      await call('studio_sequence',{baseRevision:p.revision,beats:[{assetId:'picture',narration:'沿着刻度移动。',
        motionComponent:{componentId:'staggered-explanation',props:{a:'起点',b:'读数',c:'归零'},cueFrames:[0,10,20]}}]});
      const first=p.timeline.clips.find(c=>c.motion),rev=p.revision;
      assert.deepEqual(first.motion.cueFrames,[0,10,20]);
      const patch={clipId:first.id,baseRevision:rev,cueFrames:[0,15,20],props:{b:'核对读数'}};
      await call('studio_component',patch);await assert.rejects(call('studio_component',patch),/版本/);
      assert.equal(p.timeline.clips.find(c=>c.id===first.id).motion.props.a,'起点');
      p.timeline.clips.find(c=>c.id===first.id).locked=true;
      await assert.rejects(call('studio_component',{...patch,baseRevision:p.revision}),/locked/);
      return '编辑完毕';
    }};
  await createDirector(deps).run(p.id,{kind:'produce'});
  assert.deepEqual(p.timeline.clips.find(c=>c.motion).motion.props,{a:'起点',b:'核对读数',c:'归零'});
});

test('opening an old project for an ordinary edit registers newly added tools once',async t=>{
  const {p,deps}=await fixture(t,{threadId:'old-thread',directorToolSignature:'previous-tools'});
  const starts=[];
  deps.client={account:async()=>({connected:true}),close(){},
    async thread(id,tools){starts.push(id);assert.ok(tools.some(t=>t.name==='studio_component'));return 'updated-thread';},
    async runTurn({onStart}){await onStart('new-turn');return '已读取工程';}};
  const director=createDirector(deps);
  await director.run(p.id,{kind:'revise'});
  await director.run(p.id,{kind:'revise'});
  assert.deepEqual(starts,[null,'updated-thread']);
  assert.deepEqual(p.previousDirectorThreads,['old-thread']);
});

test('a first cut can apply independently editable headline and credit components to the same shot',async t=>{
  const {p,deps}=await fixture(t);let schemas;
  deps.client={account:async()=>({connected:true}),thread:async(_id,tools)=>{schemas=tools;return 'thread';},close(){},
    async runTurn({onStart,tool}){
      await onStart('turn');
      const schema=schemas.find(t=>t.name==='studio_sequence').inputSchema.properties.beats.items.properties.motionComponents;
      assert.equal(schema.maxItems,8);
      await tool({tool:'studio_sequence',arguments:{baseRevision:p.revision,beats:[{assetId:'picture',narration:'测试开始。',motionComponents:[
        {componentId:'impact-title',props:{label:'原片',title:'启动'}},
        {componentId:'source-label',props:{lab:'台架记录',hardware:'检验原件'},atSeconds:.25},
      ]}]}});
      return '已加入标题与来源。';
    }};
  const director=createDirector(deps);t.after(()=>director.close());await director.run(p.id);
  const layers=p.timeline.clips.filter(c=>c.motion);
  assert.deepEqual(layers.map(c=>[c.id,c.motion.componentId,c.start]),[['scene-0-motion','impact-title',0],['scene-0-motion-1','source-label',6]]);
});

test('first-cut JSX uses this shot’s observed action frames at the actual project rate',async t=>{
  const {p,deps}=await fixture(t,{settings:{voiceMode:'original',musicEnabled:false}});
  const beat={assetId:'picture',narration:'逐次转动。',durationSeconds:4,
    visualSteps:[.4,1,2].map((atSeconds,i)=>({atSeconds,stage:'detail',label:'细节'+i,observation:'标记发生转动'})),
    motionComponent:{componentId:'staggered-explanation',props:{a:'起点',b:'转动',c:'停稳'},cueSource:'visualSteps'}};
  await applyScenes(deps,p,[beat]);
  const c=p.timeline.clips.find(c=>c.motion);
  assert.equal(c.start,10);assert.deepEqual(c.motion.cueFrames,[0,15,40]);
  await assert.rejects(applyScenes(deps,p,[{...beat,motionComponent:{...beat.motionComponent,cueFrames:[0,1,2]}}]),/只指定/);
});

for(const [styleId,template] of [['henry-hot-news','action-result'],['henry-technical-explainer','step-reveal']]){
  test(styleId+' uses reference, sources and current draft together, extends a trial and rewrites the whole spoken structure during review',async t=>{
    const settings={shareFrames:true,shareTranscript:true,voiceMode:'system',voiceSelection:'user',musicMode:'none',
      sourceScope:'project',autoReview:false,durationMinSeconds:2,durationMaxSeconds:8};
    const {p,deps,counts}=await fixture(t,{settings,style:{id:styleId,version:8}});
    const baseline={id:'benchmark',kind:'video',duration:6,path:'/private/baseline',available:true,sha256:'baseline-hash'};
    deps.styleLibrary.get=async()=>({...p.style,templates:[{id:template}],baseline,references:[baseline],
      storyboardContract:{core_rule_ids:['cut-important'],planning_guidance:'依本期证据处理'},recipeSections:['timing'],
      rules:[{id:'cut-important',instruction:'确认原片中发生了变化。',check:'按动作起落判断。'}]});
    deps.styleLibrary.readDirectorSection=async(_id,_v,section)=>({section,text:'可按原片调整的节拍'});
    deps.drafts={open:async(project,from)=>({name:'stub-'+project.revision,fromFrame:from})};
    deps.media.frameAt=async(file,seconds,dest)=>writeFile(dest,'fixture:'+file+':'+seconds);
    let calls=0;
    deps.client={account:async()=>({connected:true}),thread:async()=> 'single-thread',close(){},
      runTurn:async({onStart,tool,prompt,images})=>{
        await onStart('round-'+ ++calls);
        const call=(name,args={})=>tool({tool:name,arguments:args});
        const ctx=async()=>JSON.parse((await call('studio_context')).contentItems[0].text);
        const sequence=(operation,lines,opts={})=>call('studio_sequence',{baseRevision:p.revision,operation,
          beats:lines.map(narration=>({assetId:picture.id,narration})),...opts});
        assert.ok(images.some(i=>i.frame.source==='asset')&&images.some(i=>i.frame.source==='style'));
        assert.match(prompt,/确认原片中发生了变化/);
        assert.equal((await ctx()).style.rules[0].check,'按动作起落判断。');
        assert.match((await call('studio_style',{section:'timing'})).contentItems[0].text,/节拍/);
        await assert.rejects(call('studio_find',{query:'no network'}),/固定/);
        if(calls===1){
          await sequence('replace-all',['第一句试剪'],{intent:'trial'});
          const sampled=await call('studio_review_cut',{baseRevision:p.revision});
          assert.ok(sampled.contentItems.some(i=>i.type==='inputImage'));
          return '已有试剪，继续';
        }
        if(calls===2){
          await sequence('append',['第二句','第三句']);
          const firstClip=p.timeline.clips.find(c=>c.track==='video'&&c.start===0);
          firstClip.locked=true;
          await assert.rejects(sequence('replace-all',['不能改锁']),/锁定/);
          await sequence('replace-range',['合并后重新说'],{fromFrame:50,toFrame:150});
          assert.ok(p.timeline.clips.find(c=>c.id===firstClip.id).locked);
          p.timeline.clips.find(c=>c.id===firstClip.id).locked=false;
          await assert.rejects(call('studio_edit',{baseRevision:p.revision-1,commandsJson:'[]'}),/版本/);
          await call('studio_cut_ready',{baseRevision:p.revision});
          return '首版齐了';
        }
        assert.equal(calls,3);
        assert.ok(images.some(i=>i.frame.source==='timeline'));
        await sequence('replace-all',['重新开场','已核对的结果。']);
        const voice=p.timeline.clips.find(c=>c.track==='narration'&&c.start===50);
        await call('studio_narrate',{baseRevision:p.revision,clipId:voice.id,text:'复查之后说清楚结果。'});
        const read=await call('studio_review_cut',{baseRevision:p.revision});
        const samples=JSON.parse(read.contentItems[0].text).samples;
        await call('studio_visual_review',{baseRevision:p.revision,checks:samples.map(f=>({frame:f.frame,stage:f.stage,observation:'试件保留在画面中央。',needsFix:false}))});
        const timing=(await ctx()).timing;
        assert.equal(timing.seconds,4);assert.equal(timing.withinRequestedRange,true);
        return '已复查当前版';
      }};
    const d=createDirector(deps);t.after(()=>d.close());
    const result=await d.run(p.id,{kind:'produce',jobId:'continuous-test'});
    assert.equal(calls,3);assert.equal(p.visualDirection.status,'reviewed');assert.equal(result.changed,true);
    assert.ok(p.timeline.clips.some(c=>c.track==='caption'&&c.text.includes('复查之后')));
    assert.ok(counts().syntheses>=6);assert.equal(p.storyboard.length,2);
  });
}
