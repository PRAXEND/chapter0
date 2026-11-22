// Coordinates live in the graphic's own box. Only numbers ever reach libass.
export function polygonPath(points, width, height) {
  if (!Array.isArray(points) || points.length < 3 || points.length > 128 ||
      !points.every(p => Array.isArray(p) && p.length === 2 &&
        p.every(n => Number.isFinite(n) && n >= 0 && n <= 1))) {
    throw new Error('轮廓需要 3–128 个归一化顶点。');
  }
  const pixels = points.map(([x,y]) => [Math.round(x * width), Math.round(y * height)]);
  const area = pixels.reduce((sum, [x, y], i) => {
    const next = pixels[(i + 1) % pixels.length];
    return sum + x * next[1] - y * next[0];
  }, 0);
  if (!area) throw new Error('轮廓顶点在图层实际像素框中必须围出可见的面积。');
  const coords = pixels.map(([x,y]) => x + ' ' + y);
  return 'm ' + coords[0] + ' l ' + coords.slice(1).join(' ');
}
