const value = (n, previous) => Number.isFinite(n) ? n : previous;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

export function graphicKeys(clip) {
  let current = {
    frame: 0, x: value(clip.geometry?.x, .5),
    y: value(clip.geometry?.y, clip.track === 'caption' ? .86 : .28),
    scale: 1, opacity: 1, rotation: 0,
  };
  const points = new Map([[0, current]]);
  for (const key of [...(clip.keyframes ?? [])].sort((a, b) => a.frame - b.frame)) {
    if (!Number.isInteger(key.frame) || key.frame < 0 || key.frame > clip.duration) continue;
    current = {
      frame: key.frame, x: value(key.x, current.x), y: value(key.y, current.y),
      scale: clamp(value(key.scale, current.scale), .01, 10), opacity: clamp(value(key.opacity, current.opacity), 0, 1),
      rotation: value(key.rotation, current.rotation),
    };
    points.set(key.frame, current);
  }
  if (!points.has(clip.duration)) points.set(clip.duration, { ...current, frame: clip.duration });
  return [...points.values()];
}

// The first frame of the right piece must look exactly like the original cut frame.
// Keep angles unwrapped. A turn from 0 to 720 has two complete clockwise rotations.
export function splitGraphicKeys(clip, at) {
  const points = graphicKeys(clip);
  const right = points.find(p => p.frame >= at);
  let cut = right;
  if (right.frame !== at) {
    const left = points.findLast(p => p.frame < at);
    const progress = (at - left.frame) / (right.frame - left.frame);
    cut = { frame: at };
    for (const k of ['x', 'y', 'scale', 'opacity', 'rotation'])
      cut[k] = left[k] + (right[k] - left[k]) * progress;
  }
  return [
    [...points.filter(p => p.frame < at), cut],
    [cut, ...points.filter(p => p.frame > at)].map(p => ({ ...p, frame: p.frame - at })),
  ];
}
