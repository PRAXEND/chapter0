export function motionCues(component, duration, fps, props={}) {
  const source = component.referenceCues;
  if (source.length < 2) return [...source];
  const ref = component.id==='process-rail' ? [0,props.second??source[1],props.third??source[2]] : source;
  const scale = Math.min(fps/30,(duration-1)/component.referenceDuration);
  // Preserve the native entrance pace if the original cue sequence fits the new clip.
  const step = ref.at(-1)*fps/30 < duration-1 ? fps/30 : scale;
  return ref.map((v,i) => Math.max(i, Math.min(duration-(ref.length-i), Math.round(v*step))));
}

export function defaultMotionGeometry(spec,{width,height}){
  // Positions remain relative to the stage. Keep the preset's glyphs and circles
  // at the authored aspect ratio on portrait and square canvases.
  const scale=Math.min(width/1920,height/1080);
  return {...spec.geometry,width:spec.width*scale/width,height:spec.height*scale/height};
}
