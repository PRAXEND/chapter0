import {graphicKeys} from '../www/clip-automation.js';
export {graphicKeys};

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
