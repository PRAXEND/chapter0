import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyFinalReview,
  createFinalReviewer,
  finalReviewApplies,
  finalSamplePlan,
} from '../src/independent-review.mjs';
import { refreshMotionWitnesses } from '../src/semantic-refresh.mjs';
import { createQueue } from '../src/jobs.mjs';
import { createStore } from '../src/project.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const hashFile = async (f) => sha(await readFile(f));
const fx = { id: 'henry-technical-explainer', version: 8, sha256: sha('locked style') };
const profile = { fps: 25, width: 320, height: 180 };
const dims = ['opening', 'explanation', 'ending', 'style'];
function reply(samples, review = 'supported') {
  const candidates = samples.filter((s) => s.kind === 'candidate'),
    reference = samples.find((s) => s.kind === 'reference');
  const first = candidates.reduce((a, b) => (a.frame < b.frame ? a : b)),
    last = candidates.reduce((a, b) => (a.frame > b.frame ? a : b));
  return JSON.stringify({
    comparisons: dims.map((d) => ({
      dimension: d,
      verdict: d === 'style' ? review : 'supported',
      candidateIds: [(d === 'ending' ? last : first).id],
      referenceIds: [reference.id],
      observation: '候选画面显示旋转中的器件',
      comparison: '基准用实拍呈现连续搬运动作',
    })),
    motion: [
      {
        group: 'W1',
        verdict: 'supports',
        subject: '转轴',
        change: '从水平转向下方',
        relation: '可见部件确实转向',
      },
    ],
  });
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-readonly-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { outputs: path.join(root, 'outputs'), cache: path.join(root, 'cache') };
  await mkdir(paths.outputs);
  const video = path.join(paths.outputs, 'candidate.mp4'),
    ref = path.join(root, 'baseline.mp4'),
    input = path.join(root, 'source.mp4');
  for (const [f, data] of [
    [video, 'final frozen bytes'],
    [ref, 'style bytes'],
    [input, 'source bytes'],
  ])
    await writeFile(f, data);
  const view = {
    sourceWindows: [],
    motion: [
      { assetId: 'a', clipId: 'v', fromFrame: 0, toFrame: 49, result: 'changing-footage' },
      { assetId: 'a', clipId: 'v', fromFrame: 50, toFrame: 99, result: 'changing-footage' },
    ],
    motionCoverage: { informativeFrames: 0 },
    styleExecution: { informativeWindows: [] },
  };
  const qa = {
    revision: 10,
    artifactSha256: await hashFile(video),
    candidatePlayable: true,
    issues: [],
    evidence: { duration: 4, visual: view },
    deliverable: true,
    status: 'deliverable',
    repairs: [],
  };
  const project = {
    id: 'p',
    threadId: 'creative-author',
    revision: 10,
    settings: { shareFrames: true, shareTranscript: false, autoReview: true, model: 'fixture' },
    brief: 'UNSHARED_PROJECT_TEXT',
    style: fx,
    profile,
    assets: [{ id: 'a', kind: 'video', path: input, sha256: await hashFile(input), duration: 10 }],
    timeline: {
      clips: [
        { id: 'v', track: 'video', assetId: 'a', start: 0, duration: 100 },
        { id: 'sub', track: 'caption', start: 0, duration: 100, text: 'PRIVATE_TRANSCRIPT' },
      ],
    },
  };
  const job = {
    id: 'B',
    kind: 'revise',
    projectId: project.id,
    cutRole: 'self-review',
    firstCutId: 'A',
    revision: 10,
    files: { video },
    snapshot: project,
    qa,
  };
  const style = {
    ...fx,
    baseline: { kind: 'video', available: true, verified: true, path: ref, sha256: await hashFile(ref) },
    rules: [{ id: 'video-first', instruction: '观察真实画面' }],
  };
  const calls = [],
    writes = [];
  let current = structuredClone(project),
    state;
  const store = { get: () => current, getJob: () => job, paths: () => paths };
  const media = {
    fileHash: hashFile,
    probeMedia: async (f) => ({
      kind: 'video',
      duration: f === video ? 4 : 10,
      frames: f === video ? 100 : 250,
    }),
    frameAt: (file, at, to) => writeFile(to, path.basename(file) + ' at ' + at),
  };
  const client = {
    storeId: 'private-review-store',
    async thread(id, tools, _instructions, _settings, scope) {
      calls.push({ type: 'thread', id, tools, scope });
      return id || 'independent-reader';
    },
    async runTurn(args) {
      calls.push({ type: 'turn', args });
      await args.onStart('T');
      return reply(state.samples, 'suggestion');
    },
    close() {},
    modelForThread: () => 'read-only-fixture',
  };
  return {
    job,
    project,
    qa,
    style,
    media,
    store,
    client,
    calls,
    writes,
    video,
    ref,
    change: (patch) => {
      current = { ...current, ...patch };
    },
    get state() {
      return state;
    },
    run: (options = {}) =>
      createFinalReviewer({ store, media, createClient: () => client, ...options.deps })({
        job,
        project,
        style,
        signal: new AbortController().signal,
        checkpoint: state,
        persist: async (s) => {
          state = s;
          writes.push(s.status);
        },
        ...options,
      }),
  };
}

test('a new isolated turn compares signed final frames to the signed baseline without project tools or private text', async (t) => {
  const f = await fixture(t);
  const got = await f.run();
  assert.equal(got.status, 'completed');
  assert.equal(got.candidate.sha256, f.qa.artifactSha256);
  assert.equal(got.style.referenceSha256, f.style.baseline.sha256);
  assert.notEqual(got.threadId, f.project.threadId);
  assert.deepEqual(f.calls[0], { type: 'thread', id: null, tools: [], scope: {allowLegacy:false, legacyTurnId:undefined} });
  const args = f.calls[1].args;
  assert.match(args.prompt, /projectIntent/);
  assert.doesNotMatch(args.prompt, /UNSHARED_PROJECT_TEXT|PRIVATE_TRANSCRIPT|creative-author|\/Users\//);
  assert.equal(args.images.length, got.samples.length);
  assert.ok(got.samples.length <= 16);
  for (const [i, image] of args.images.entries())
    assert.equal(sha(Buffer.from(image.url.split(',')[1], 'base64')), got.samples[i].sha256);
  assert.equal((await args.tool({ tool: 'studio_edit' })).success, false);
  assert.deepEqual(f.writes, ['starting', 'running', 'completed']);
  assert.equal(got.comparisons.length, 4);
  assert.equal(got.motionWindows.length, 1);
  const graded = applyFinalReview(f.qa, got);
  assert.equal(graded.status, 'advisory');
  assert.equal(graded.deliverable, true);
  assert.ok(graded.evidence.visual.motionCoverage.informativeFrames > 0);
  assert.deepEqual(await f.run(), got);
  assert.equal(f.calls.length, 2);
});

test('zero budget, revoked sharing, stale revision and unknown start receipts never initiate a reader turn', async (t) => {
  const f = await fixture(t);
  for (const [change, wanted] of [
    [{ settings: { ...f.project.settings, finalReviewMaxTurns: 0 } }, 'budget-disabled'],
    [{ settings: { ...f.project.settings, shareFrames: false } }, 'frames-disabled'],
    [{ settings: f.project.settings, revision: 11 }, 'superseded'],
  ]) {
    f.change(change);
    const r = await f.run();
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, wanted);
  }
  f.change(f.project);
  const result = await f.run();
  const count = f.calls.length;
  const lost = await f.run({ checkpoint: { ...result, status: 'starting', turnId: undefined } });
  assert.equal(lost.reason, 'ambiguous-turn-receipt');
  const wrong = await f.run({
    checkpoint: { ...result, candidate: { ...result.candidate, sha256: sha('different') } },
  });
  assert.equal(wrong.reason, 'receipt-mismatch');
  assert.equal(f.calls.length, count);
  assert.equal(finalReviewApplies({ ...f.job, cutRole: 'first' }, f.project, f.style), false);
  assert.equal(finalReviewApplies(f.job, f.project, { id: 'neutral', version: 1 }), false);
});

test('after restart the reader resumes the recorded read-only turn, and the charged deadline stays fixed', async (t) => {
  const f = await fixture(t);
  const done = await f.run();
  const prior = { ...done, status: 'running' };
  const resumed = await f.run({ checkpoint: prior });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.threadStore, 'private-review-store');
  assert.equal(f.calls.at(-2).id, 'independent-reader');
  assert.deepEqual(f.calls.at(-2).scope, {allowLegacy:false, legacyTurnId:'T'});
  assert.equal(f.calls.at(-1).args.existingTurnId, 'T');
  assert.deepEqual(f.calls.at(-1).args.images, []);
  const calls = f.calls.length;
  const stopped = await f.run({ checkpoint: { ...prior, deadline: Date.now() - 1 } });
  assert.equal(stopped.reason, 'time-budget-exhausted');
  assert.equal(f.calls.filter((c) => c.type === 'turn').length, 2);
  f.client.findTurn = async () => ({
    turn: { status: 'completed', items: [{ type: 'agentMessage', text: reply(done.samples) }] },
  });
  const recovered = await f.run({ checkpoint: { ...prior, deadline: Date.now() - 1 } });
  assert.equal(recovered.status, 'completed');
  assert.equal(f.calls.filter((c) => c.type === 'turn').length, 2);
});

test('a new artifact, changed reference or malformed citations do not receive invented comparison results', async (t) => {
  const f = await fixture(t);
  await writeFile(f.video, 'other cut');
  assert.equal((await f.run()).status, 'unavailable');
  assert.equal(f.calls.length, 0);
  await writeFile(f.video, 'final frozen bytes');
  await writeFile(f.ref, 'replacement');
  assert.equal((await f.run()).reason, 'reference-changed');
  assert.equal(f.calls.length, 0);
  await writeFile(f.ref, 'style bytes');
  f.client.runTurn = async (args) => {
    await args.onStart('T');
    return JSON.stringify({
      comparisons: [{ dimension: 'style', observation: 'generic', candidateIds: ['C1000'] }],
    });
  };
  const absent = await f.run();
  assert.equal(absent.status, 'unavailable');
  assert.deepEqual(absent.comparisons, []);
  const serious = applyFinalReview(
    { ...f.qa, issues: [{ id: 'decode', severity: 'blocker', message: '无法播放' }] },
    absent,
  );
  assert.equal(serious.status, 'repair');
});

test('privacy can be revoked while images are prepared, and dedicated voice-reference video is never selected as an original', async (t) => {
  const f = await fixture(t);
  const p = structuredClone(f.project);
  p.assets[0].source = { role: 'voice-reference' };
  const plan = finalSamplePlan(p, f.qa, f.style, 10);
  assert.equal(plan.groups.length, 0);
  const original = f.media.frameAt;
  f.media.frameAt = async (...args) => {
    await original(...args);
    f.change({ settings: { ...f.project.settings, shareFrames: false } });
  };
  const skipped = await f.run();
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'frames-disabled');
  assert.equal(f.calls.filter((c) => c.type === 'turn').length, 0);
});

function witnessFixture() {
  const asset = { id: 'a', kind: 'video', sha256: sha('source'), width: 320, height: 180, path: 'source' };
  const clip = { id: 'shot', assetId: 'a', track: 'video', sourceIn: 0, start: 0, duration: 24 };
  const old = {
    id: 'p',
    revision: 1,
    style: fx,
    profile,
    assets: [asset],
    timeline: { clips: [clip] },
    storyboard: [
      {
        assetId: 'a',
        visualSteps: [
          {
            stage: 'mechanism',
            witnessFrameHash: 'source-frame',
            region: { x: 0.15, y: 0.15, width: 0.5, height: 0.5 },
            observation: '转轴从左侧推向中心',
          },
        ],
      },
    ],
    visualDirection: { checks: [{ stage: 'mechanism', frame: 8, observation: '原稿观察到转轴' }] },
  };
  const sample = { assetId: 'a', clipId: 'shot', fromFrame: 0, toFrame: 23, result: 'changing-footage' };
  const previous = {
    snapshot: old,
    files: { video: 'A' },
    qa: {
      revision: 1,
      artifactSha256: sha('A'),
      candidatePlayable: true,
      evidence: {
        visual: {
          motionCoverage: { informativeFrames: 24 },
          motion: [sample],
          witnessedShots: [
            { assetId: 'a', clipId: 'shot', frame: 8, stage: 'mechanism', witnessFrameHash: 'source-frame' },
          ],
        },
      },
    },
  };
  const current = structuredClone(old);
  current.revision = 2;
  current.timeline.clips[0].duration = 20;
  const pixels = (s, w, h) =>
    Buffer.from(
      Array.from({ length: w * h * 3 }, (_, i) => ((i * 7 + Math.round(s * 25) * 13) ^ (i >> 4)) % 247),
    );
  const options = {
    videoPath: 'B',
    hashFile: async (x) => sha(x),
    readFrame: async (_, s, w, h) => pixels(s, w, h),
  };
  return { previous, current, measurement: [{ ...sample, toFrame: 19 }], options, pixels };
}

test('a changed shot/split can revalidate a bounded source observation only against the new composite and its source window', async () => {
  const { current, previous, measurement, options, pixels } = witnessFixture();
  const matched = await refreshMotionWitnesses(current, previous, measurement, options);
  assert.equal(matched.length, 1);
  assert.deepEqual([matched[0].fromFrame, matched[0].toFrame], [0, 19]);
  assert.equal(matched[0].samples.length, 3);
  assert.equal(matched[0].scope, 'observed-source-action');
  for (const testCase of [
    { ...options, hashFile: async (x) => (x === 'A' ? sha('modified') : sha(x)) },
    {
      ...options,
      readFrame: async (file, s, w, h) =>
        file === 'B' && s > 0.35 ? Buffer.alloc(w * h * 3) : pixels(s, w, h),
    },
    { ...options, readFrame: async (_, s, w, h) => Buffer.alloc(w * h * 3, 70) },
  ])
    assert.deepEqual(await refreshMotionWitnesses(current, previous, measurement, testCase), []);
  const other = structuredClone(current);
  other.timeline.clips[0].sourceIn = 200;
  assert.deepEqual(await refreshMotionWitnesses(other, previous, measurement, options), []);
  const noObservation = structuredClone(previous);
  noObservation.qa.evidence.visual.witnessedShots = [];
  assert.deepEqual(await refreshMotionWitnesses(current, noObservation, measurement, options), []);
});

// Start at the persisted B-review checkpoint. The queue must never call the author or render again.
test('durable B final review writes its report beside the frozen candidate without launching another edit or render', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-final-queue-'));
  const store = createStore(root);
  let reads = 0,
    reviews = 0;
  const p = store.create({
    title: 'read-only fixture',
    mode: 'topic',
    style: fx,
    settings: { autoReview: true, shareFrames: true },
  });
  const dir = path.join(store.paths(p.id).outputs, 'B');
  await mkdir(dir, { recursive: true });
  const video = path.join(dir, 'video.mp4'),
    srt = path.join(dir, 'captions.srt');
  await writeFile(video, 'frozen');
  await writeFile(srt, '');
  const id = 'B',
    qa = {
      revision: p.revision,
      artifactSha256: sha('frozen'),
      candidatePlayable: true,
      issues: [],
      repairs: [],
      status: 'deliverable',
      deliverable: true,
      evidence: { duration: 4 },
    };
  store.saveJob({
    id: 'A',
    projectId: p.id,
    kind: 'produce',
    cutRole: 'first',
    reviewJobId: id,
    status: 'done',
    phase: 'done',
    files: { video },
    qa,
    snapshot: p,
  });
  store.saveJob({
    id,
    projectId: p.id,
    kind: 'revise',
    firstCutId: 'A',
    cutRole: 'self-review',
    input: { engine: 'codex' },
    createdAt: '1',
    status: 'running',
    phase: 'independent-review',
    revision: p.revision,
    files: { video, subtitle: srt },
    snapshot: p,
    qa,
    finalReviewState: { status: 'running', turnId: 'known' },
  });
  const queue = createQueue({
    store,
    director: { run: () => assert.fail('unexpected creative run') },
    media: { renderProject: () => assert.fail('unexpected rendering') },
    reviewProject: () => {
      reviews++;
      assert.fail('unexpected technical run');
    },
    finalReviewer: async ({ checkpoint, project, job }) => {
      reads++;
      assert.equal(checkpoint.turnId, 'known');
      assert.equal(project.revision, p.revision);
      return { status: 'completed', candidate: { jobId: job.id }, comparisons: [], motionWindows: [] };
    },
  });
  t.after(async () => {
    await queue.close();
    store.close();
    await rm(root, { force: true, recursive: true });
  });
  queue.recover();
  const until = Date.now() + 3000;
  while (store.getJob(id).status !== 'done' && Date.now() < until) await delay(10);
  const b = store.getJob(id);
  assert.equal(b.status, 'done', b.error);
  assert.equal(reads, 1);
  assert.equal(reviews, 0);
  assert.equal(store.listJobs(p.id).length, 2);
  assert.equal(store.get(p.id).revision, p.revision);
  assert.equal(
    JSON.parse(await readFile(b.files.review, 'utf8')).evidence.independentReview.status,
    'completed',
  );
});

test('the news director receives a separate action/result comparison and can inspect real footage without a science motion score', async (t) => {
  const f = await fixture(t);
  const hot = {
    ...f.style,
    id: 'henry-hot-news',
    rules: [{ id: 'visible-hook', instruction: '先看发生的事。' }],
  };
  f.project.style = { id: hot.id, version: hot.version, sha256: hot.sha256 };
  f.change(f.project);
  f.qa.evidence.visual = {
    sourceWindows: [{ kind: 'video', assetId: 'a', clipId: 'v', fromFrame: 0, toFrame: 99 }],
    motion: [],
  };
  assert.equal(finalReviewApplies(f.job, f.project, hot), true);
  f.client.runTurn = async (args) => {
    assert.match(args.prompt, /行动发展/);
    assert.doesNotMatch(args.prompt, /explanation（/);
    await args.onStart('T');
    return reply(f.state.samples).replace('"dimension":"explanation"', '"dimension":"action"');
  };
  const r = await f.run({ style: hot });
  assert.equal(r.status, 'completed');
  assert.equal(r.style.form, 'action-result');
  assert.equal(r.comparisons[1].dimension, 'action');
  assert.equal(r.motionWindows[0].measuredMotion, false);
  assert.equal(applyFinalReview(f.qa, r).evidence.visual.motionCoverage, undefined);
});

test('a carried source ROI uses both frozen portrait footage windows and rejects an old outer-canvas witness', async () => {
  const { current, previous, measurement, options, pixels } = witnessFixture();
  for (const p of [current, previous.snapshot]) p.profile = { ...profile, width: 1080, height: 1920 };
  assert.deepEqual(await refreshMotionWitnesses(current, previous, measurement, options), []);
  previous.qa.evidence.visual.footageStage = { x: 0, y: 656, width: 1080, height: 608 };
  const requested = [];
  const refreshed = await refreshMotionWitnesses(current, previous, measurement, {
    ...options,
    readFrame: async (file, s, w, h, rect) => {
      requested.push([file, rect]);
      assert.ok(rect.y >= 656 && rect.y + rect.height <= 1264);
      return pixels(s, w, h);
    },
  });
  assert.equal(refreshed.length, 1);
  assert.equal(requested.length, 6);
  assert.equal(refreshed[0].samples[0].region.y, 747);
});

test('a replaced MP4 cannot reuse the cached completed verdict or be automatically delivered', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).status, 'completed');
  await writeFile(f.video, 'replaced after reviewer finished');
  const persisted = await f.run();
  assert.equal(persisted.reason, 'candidate-integrity');
  assert.equal(applyFinalReview(f.qa, persisted).status, 'repair');
  assert.equal(f.calls.filter((c) => c.type === 'turn').length, 1);
});

test('new bounded observations update only the motion rule, leaving definite unrelated defects intact', () => {
  const m = { assetId: 'a', fromFrame: 0, toFrame: 79, result: 'changing-footage' };
  const qa = {
    issues: [
      { id: 'style-video-first', severity: 'minor', message: '动作有待确认' },
      { id: 'damage', severity: 'major', message: '已核实的独立缺陷' },
    ],
    evidence: {
      visual: {
        motion: [m],
        motionCoverage: { totalFrames: 100, changingFrames: 80, informativeFrames: 25 },
        styleExecution: {
          ruleId: 'video-first',
          motionStatus: 'unverified',
          informativeWindows: [{ assetId: 'a', fromFrame: 0, toFrame: 24 }],
        },
      },
    },
  };
  const report = applyFinalReview(qa, {
    status: 'completed',
    comparisons: [],
    motionWindows: [{ assetId: 'a', fromFrame: 20, toFrame: 58, measuredMotion: true }],
  });
  assert.equal(report.evidence.visual.motionCoverage.informativeFrames, 59);
  assert.equal(report.evidence.visual.styleExecution.motionStatus, 'met');
  assert.deepEqual(
    report.issues.map((i) => i.id),
    ['damage'],
  );
  assert.equal(report.status, 'repair');
});
