const number = (value, fallback) => Number.isFinite(value) ? value : fallback;
const bound = (val, min, max) => Math.max(min, Math.min(val, max));
const pad = (value, n = 2) => String(value).padStart(n, '0');

function clock(frame, fps, ass = false) {
  const units = ass ? 100 : 1000;
  // libass evaluates the event at each displayed frame. Rounding up can delay an event by a whole frame.
  const n = ass ? Math.floor(frame * units / fps + 1e-8) : Math.round(frame * units / fps);
  const h = Math.floor(n / (3600 * units));
  const m = Math.floor(n / (60 * units)) % 60;
  const s = Math.floor(n / units) % 60;
  return ass ? `${h}:${pad(m)}:${pad(s)}.${pad(n % units)}` : `${pad(h)}:${pad(m)}:${pad(s)},${pad(n % units, 3)}`;
}

function cleanText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
}

function assText(value) {
  return cleanText(value).replaceAll('\\', '\\\u200c').replaceAll('{', '\\{').replaceAll('}', '\\}').replaceAll('\n', '\\N');
}

function color(value, fallback) {
  const input = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value || '') ? value : fallback;
  const [r, g, b, a = 'ff'] = input.slice(1).match(/../g);
  return { rgb: `&H${b}${g}${r}&`, opacity: parseInt(a, 16) / 255 };
}
const alpha = opacity => `&H${pad(Math.round(255 * (1 - bound(opacity, 0, 1))).toString(16))}&`;

export function createSrt(clips, fps, { fromFrame = 0, toFrame = Infinity } = {}) {
  const captions = clips.filter(c => c.track === 'caption' && c.hidden !== true && c.enabled !== false && cleanText(c.text).trim() && c.start < toFrame && c.start + c.duration > fromFrame)
    .sort((a, b) => a.start - b.start);
  return captions.map((c, i) => {
    const start = Math.max(c.start, fromFrame) - fromFrame, end = Math.min(c.start + c.duration, toFrame) - fromFrame;
    return `${i + 1}\n${clock(start, fps)} --> ${clock(end, fps)}\n${cleanText(c.text).trim()}\n`;
  }).join('\n');
}

export function createAss(clips, profile) {
  const { width, height, fps } = profile;
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,PingFang SC,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,5,0,0,0,1
Style: Box,PingFang SC,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,4,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = [];
  for (const clip of clips.filter(c => ['graphic', 'caption'].includes(c.track) && !c.hidden && c.enabled !== false)) {
    const style = clip.style ?? {};
    const isCaption = clip.track === 'caption';
    const fg = color(style.color, '#ffffff');
    const bg = color(style.backgroundColor, '#12151b');
    const boxed = Boolean(style.backgroundColor);
    const outline = boxed ? Math.max(1, height / 140) : Math.max(1, height / 380);
    const font = bound(number(style.fontSize, Math.round((isCaption ? 0.049 : 0.065) * Math.min(height, width * 1.5))), 1, height);
    const shape = !clip.text && clip.geometry?.width && clip.geometry?.height;
    if (!shape && !cleanText(clip.text).trim()) continue;
    let drawing = assText(clip.text);
    if (shape) {
      const w = Math.round(width * bound(clip.geometry.width, 0, 2));
      const h = Math.round(height * bound(clip.geometry.height, 0, 2));
      drawing = `{\\p1}m 0 0 l ${w} 0 ${w} ${h} 0 ${h}{\\p0}`;
    }
    const initial = { frame: 0, x: number(clip.geometry?.x, 0.5), y: number(clip.geometry?.y, isCaption ? 0.86 : 0.28), scale: 1, opacity: 1 };
    const points = new Map([[0, initial]]);
    let prior = initial;
    for (const key of [...(clip.keyframes ?? [])].sort((a, b) => a.frame - b.frame)) {
      if (!Number.isInteger(key.frame) || key.frame < 0 || key.frame > clip.duration) continue;
      prior = { frame: key.frame, x: number(key.x, prior.x), y: number(key.y, prior.y), opacity: bound(number(key.opacity, prior.opacity), 0, 1), scale: bound(number(key.scale, prior.scale), 0.01, 10) };
      points.set(key.frame, prior);
    }
    if (!points.has(clip.duration)) points.set(clip.duration, { ...prior, frame: clip.duration });
    const keys = [...points.values()];
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      const x = p => Math.round(width * p.x), y = p => Math.round(height * p.y);
      const duration = Math.max(1, Math.round(1000 * (b.frame - a.frame) / fps));
      const pos = (x(a) === x(b) && y(a) === y(b)) ? `\\pos(${x(a)},${y(a)})` : `\\move(${x(a)},${y(a)},${x(b)},${y(b)},0,${duration})`;
      const transform = p => `\\fscx${Math.round(100 * p.scale)}\\fscy${Math.round(100 * p.scale)}\\1a${alpha(p.opacity * fg.opacity)}\\3a${alpha(p.opacity * bg.opacity)}`;
      const motion = (a.scale !== b.scale || a.opacity !== b.opacity) ? `\\t(0,${duration},${transform(b)})` : '';
      const tags = `{\\an5${pos}\\fs${font}\\1c${fg.rgb}\\3c${bg.rgb}\\bord${shape ? 0 : outline.toFixed(2)}${transform(a)}${motion}}`;
      lines.push(`Dialogue: ${isCaption ? 2 : 1},${clock(clip.start + a.frame, fps, true)},${clock(clip.start + b.frame, fps, true)},${boxed ? 'Box' : 'Caption'},,0,0,0,,${tags}${drawing}`);
    }
  }
  return head + lines.join('\n') + '\n';
}
