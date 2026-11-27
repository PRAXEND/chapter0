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

export const hasMotionText=spec=>spec.fields.some(field=>field.type==='text');

export function motionGeometry(spec,stage,clip,axis='width'){
  const box=clip.geometry??defaultMotionGeometry(spec,stage);
  if(!hasMotionText(spec)||clip.motion?.lockAspect===false)return box;
  const ratio=stage.width*spec.height/(stage.height*spec.width);
  const width=Math.min(2,2/ratio,axis==='height'?box.height/ratio:box.width);
  return {...box,width,height:width*ratio};
}

export function contentStage(profile,style) {
  const portrait=profile.height>profile.width && Number(style?.version)===8 &&
    ['henry-hot-news','henry-technical-explainer'].includes(style?.id);
  return portrait?{...profile,height:2*Math.round(304*profile.width/1080)}:profile;
}
