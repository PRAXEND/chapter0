import { createHash } from 'node:crypto';
import { projectSourceRegion, validRegion } from './visual-steps.mjs';
import { sceneChange } from './motion-windows.mjs';
import { reviewStage } from './review-stage.mjs';
import { visibleWindows } from './framing.mjs';

const active = (c) => !c.hidden && c.enabled !== false;
const hash = (b) => createHash('sha256').update(b).digest('hex');
const inWindow = (f, w) => w.from <= f && f <= w.to;
const origin = (c, f, fps) => ((c.sourceIn || 0) + (f - c.start) * (c.speed || 1)) / fps;
const atSource = (c, sec, fps) => c.start + (sec * fps - (c.sourceIn || 0)) / (c.speed || 1);
const positive = (c) => Number.isFinite(c.speed ?? 1) && (c.speed ?? 1) > 0;
function shots(p) {
  const assets = new Map(p.assets.map((a) => [a.id, a]));
  return visibleWindows(
    p.timeline.clips
      .filter((c) => active(c) && c.track === 'video')
      .sort((a, b) => a.start - b.start)
      .map((clip) => ({ clip, asset: assets.get(clip.assetId) })),
    reviewStage(p).profile,
  );
}
function clipsAt(p, frame) {
  return p.timeline.clips
    .filter(
      (c) =>
        active(c) &&
        c.track === 'narration' &&
        !c.muted &&
        (c.gain ?? 1) > 0 &&
        c.start <= frame &&
        frame < c.start + c.duration,
    )
    .map((c) => {
      const a = p.assets.find((a) => a.id === c.assetId);
      return [
        a?.sha256,
        Math.round(origin(c, frame, p.profile.fps) * p.profile.fps),
        a?.transcript?.text || '',
      ];
    });
}

function sourceRegion(old, assetId, witness, stage) {
  if (!witness) return null;
  for (const row of old.storyboard || []) {
    if (row.assetId !== assetId) continue;
    const anchor = row.visualSteps?.find(
      (s) => s.witnessFrameHash === witness && (!stage || s.stage === stage) && validRegion(s.region),
    );
    if (anchor) return anchor;
  }
  return null;
}
function cropRegion(region, shot, profile, frame) {
  if (!region) return null;
  const c = shot.clip,
    a = shot.asset;
  const box = projectSourceRegion(
    region,
    { ...a, fit: c.fit, framing: c.framing, viewport: c.viewport, start: c.start, duration: c.duration },
    profile,
    frame,
  );
  if (
    !box ||
    box.width < 0.03 ||
    box.height < 0.03 ||
    box.x - box.width / 2 < 0 ||
    box.x + box.width / 2 > 1 ||
    box.y - box.height / 2 < 0 ||
    box.y + box.height / 2 > 1
  )
    return null;
  const x = Math.round((box.x - box.width / 2) * profile.width),
    y = Math.round((box.y - box.height / 2) * profile.height);
  return {
    x,
    y,
    width: Math.min(profile.width - x, Math.round(box.width * profile.width)),
    height: Math.min(profile.height - y, Math.round(box.height * profile.height)),
  };
}

// Compare every tile. A matching background elsewhere in the frame cannot conceal an
// entirely replaced title, foreground object or inset. Tiny codec differences are expected.
export function compareEvidencePixels(a, b, w, h) {
  if (!a || !b || a.length !== w * h * 3 || a.length !== b.length) return { matches: false };
  const totals = Array(16).fill(0),
    counts = Array(16).fill(0);
  let large = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const tile = Math.floor((y * 4) / h) * 4 + Math.floor((x * 4) / w),
        i = (y * w + x) * 3;
      const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
      totals[tile] += d;
      counts[tile]++;
      if (d > 12) large++;
    }
  const worst = Math.max(...totals.map((n, i) => n / counts[i]));
  return {
    matches: worst <= 2 && large / (w * h) <= 0.007,
    largestTileMean: +worst.toFixed(3),
    largePixelFraction: +(large / (w * h)).toFixed(5),
    oldPixels: hash(a),
    newPixels: hash(b),
  };
}

// Only frozen findings which were actually supported by the *first export* may transfer.
// Project text, source labels, B's scalars and a changed global timeline hash supply no evidence.
export async function refreshMotionWitnesses(
  project,
  previous,
  motion,
  { videoPath, hashFile, readFrame, signal },
) {
  const old = previous?.snapshot,
    qa = previous?.qa,
    prior = qa?.evidence?.visual;
  if (
    !old ||
    !qa ||
    old.id !== project.id ||
    old.revision !== qa.revision ||
    project.revision === old.revision ||
    !qa.candidatePlayable ||
    !prior?.motionCoverage?.informativeFrames ||
    !previous.files?.video
  )
    return [];
  if (JSON.stringify(old.profile) !== JSON.stringify(project.profile)) return [];
  if (
    old.style?.id !== project.style?.id ||
    old.style?.version !== project.style?.version ||
    old.style?.sha256 !== project.style?.sha256
  )
    return [];
  if ((await hashFile(previous.files.video)) !== qa.artifactSha256) return [];
  const oldStage = reviewStage(old),
    newStage = reviewStage(project);
  // A pre-layout report which sampled the outer portrait cannot authenticate an action on the inner stage.
  if (oldStage.viewport && JSON.stringify(prior.footageStage) !== JSON.stringify(oldStage.viewport))
    return [];
  const before = shots(old),
    now = shots(project),
    fps = project.profile.fps,
    segments = [];
  for (const m of prior.motion || []) {
    if (m.result !== 'changing-footage') continue;
    const anchors = (prior.witnessedShots || []).filter(
      (s) =>
        s.assetId === m.assetId &&
        (!s.clipId || s.clipId === m.clipId) &&
        s.frame >= m.fromFrame &&
        s.frame <= m.toFrame,
    );
    const directed = (prior.styleExecution?.informativeWindows || []).filter(
      (v) => v.assetId === m.assetId && v.fromFrame <= m.toFrame && v.toFrame >= m.fromFrame,
    );
    for (const a of anchors) {
      const check = old.visualDirection?.checks?.find(
        (c) => c.stage === a.stage && c.frame === a.frame && !c.needsFix,
      );
      const anchor = sourceRegion(old, a.assetId, a.witnessFrameHash, a.stage);
      if (check?.observation && anchor?.observation)
        segments.push({
          assetId: m.assetId,
          clipId: m.clipId,
          from: m.fromFrame,
          to: m.toFrame,
          observation: anchor.observation,
          region: anchor.region,
        });
    }
    for (const d of directed)
      if (d.observation)
        segments.push({
          assetId: m.assetId,
          clipId: m.clipId,
          from: Math.max(d.fromFrame, m.fromFrame),
          to: Math.min(d.toFrame, m.toFrame),
          observation: d.observation,
          region: sourceRegion(
            old,
            d.assetId,
            old.visualDirection?.motion?.windows?.find(
              (v) => v.assetId === d.assetId && v.observation === d.observation,
            )?.fromHash,
          )?.region,
        });
  }
  const seen = new Set(),
    accepted = new Set(),
    hashes = new Map(),
    checks = new Map(),
    out = [];
  for (const m of motion.filter((m) => m.result === 'changing-footage'))
    for (const s of segments) {
      signal?.throwIfAborted();
      if (m.assetId !== s.assetId) continue;
      const current = now.find(
        (w) =>
          w.shot.asset?.id === m.assetId &&
          (!m.clipId || m.clipId === w.shot.clip.id) &&
          inWindow(m.fromFrame, w) &&
          inWindow(m.toFrame, w),
      );
      const past = before.find(
        (w) =>
          w.shot.asset?.id === s.assetId &&
          (!s.clipId || s.clipId === w.shot.clip.id) &&
          inWindow(s.from, w) &&
          inWindow(s.to, w),
      );
      if (!current || !past || !positive(current.shot.clip) || !positive(past.shot.clip)) continue;
      const cc = current.shot.clip,
        oc = past.shot.clip,
        a = current.shot.asset;
      if (
        !a.sha256 ||
        past.shot.asset.sha256 !== a.sha256 ||
        JSON.stringify([cc.framing, cc.fit, cc.viewport]) !==
          JSON.stringify([oc.framing, oc.fit, oc.viewport])
      )
        continue;
      const from = Math.max(m.fromFrame, Math.ceil(atSource(cc, origin(oc, s.from, fps), fps) - 1e-7));
      const to = Math.min(m.toFrame, Math.floor(atSource(cc, origin(oc, s.to, fps), fps) + 1e-7));
      const interval = [cc.id, from, to].join('/'),
        key = JSON.stringify([interval, s.region, s.observation]);
      if (to <= from || accepted.has(interval) || seen.has(key) || checks.size >= 36) continue;
      seen.add(key);
      if (!hashes.has(a.id)) hashes.set(a.id, await hashFile(a.path));
      if (hashes.get(a.id) !== a.sha256) continue;
      const frames = [...new Set([from, Math.floor((from + to) / 2), to])],
        samples = [];
      let priorPixels,
        largestChange = 0;
      for (const frame of frames) {
        const mapped = atSource(oc, origin(cc, frame, fps), fps),
          oldFrame = Math.round(mapped);
        if (
          Math.abs(mapped - oldFrame) > 0.05 ||
          JSON.stringify(clipsAt(old, oldFrame)) !== JSON.stringify(clipsAt(project, frame))
        )
          break;
        const oldInner = cropRegion(s.region, past.shot, oldStage.profile, oldFrame),
          newInner = cropRegion(s.region, current.shot, newStage.profile, frame);
        if (s.region && (!oldInner || !newInner)) break;
        const oldRect = oldStage.rect(oldInner),
          newRect = newStage.rect(newInner);
        const k = JSON.stringify([oldFrame, frame, oldRect, newRect]);
        if (!checks.has(k)) {
          const width = 128,
            height = 72;
          const [x, y] = await Promise.all([
            readFrame(previous.files.video, oldFrame / fps, width, height, oldRect),
            readFrame(videoPath, frame / fps, width, height, newRect),
          ]);
          checks.set(k, {
            pixels: y,
            record: {
              oldFrame,
              frame,
              ...(newRect && { region: newRect }),
              ...compareEvidencePixels(x, y, width, height),
            },
          });
        }
        const { pixels, record } = checks.get(k);
        if (!record.matches) break;
        samples.push(record);
        if (priorPixels)
          largestChange = Math.max(
            largestChange,
            sceneChange(priorPixels, pixels, 128, 72).afterGlobalMotion,
          );
        priorPixels = pixels;
      }
      if (samples.length === frames.length && largestChange >= 3.2) {
        accepted.add(interval);
        out.push({
          scope: 'observed-source-action',
          largestLocalChange: largestChange,
          basis: 'matched-frozen-source-and-composites',
          assetId: a.id,
          assetHash: a.sha256,
          clipId: cc.id,
          fromFrame: from,
          toFrame: to,
          observation: s.observation,
          firstSha256: qa.artifactSha256,
          samples,
        });
      }
    }
  return out;
}
