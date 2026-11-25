import { portraitLayout } from './presentation.mjs';

// Graphics, source viewports and their coordinates live on the footage stage. Captions,
// the publication headline, and the texture in a v8 portrait live on the outer canvas.
export function reviewStage(project) {
  const outer = project.profile,
    layout = portraitLayout(project);
  const viewport = layout ? { x: 0, y: layout.top, width: outer.width, height: layout.contentHeight } : null;
  const profile = viewport ? { ...outer, height: viewport.height } : outer;
  const rect = (inner) =>
    viewport
      ? inner
        ? { ...inner, x: inner.x + viewport.x, y: inner.y + viewport.y }
        : { ...viewport }
      : inner;
  const point = (x, y) =>
    viewport
      ? [(viewport.x + x * viewport.width) / outer.width, (viewport.y + y * viewport.height) / outer.height]
      : [x, y];
  const bounds = (b) => {
    const [x, y] = point(b.x, b.y);
    return {
      ...b,
      x,
      y,
      width: (b.width * profile.width) / outer.width,
      height: (b.height * profile.height) / outer.height,
    };
  };
  return { viewport, profile, rect, point, bounds };
}
