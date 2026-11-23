import {polygonPath} from './polygon.mjs';
import {graphicKeys} from './graphic-keys.mjs';
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
    const keys = graphicKeys(clip);
    const turns = keys.some(k => k.rotation !== 0);
    let drawing = assText(clip.text);
    let anchorWidth = 0, anchorHeight = 0;
    if (shape) {
      const minimum = clip.shape === 'outline' ? 6 : 0;
      const w = Math.max(minimum, Math.round(width * bound(clip.geometry.width, 0, 2)));
      const h = Math.max(minimum, Math.round(height * bound(clip.geometry.height, 0, 2)));
      const shortest = Math.min(w, h);
      const opening = Math.max(4, Math.ceil(shortest / 2));
      const edge = Math.max(1, Math.min(Math.round(number(style.strokeWidth, height / 240)), Math.floor((shortest - opening) / 2)));
      const hole = clip.shape === 'outline' ? ` m ${edge} ${edge} l ${edge} ${h-edge} ${w-edge} ${h-edge} ${w-edge} ${edge}` : '';
      // libass aligns a drawing to its ink bounds. A polygon's points use the entire editable box,
      // including empty margins. Anchor its top-left corner as the box moves or scales.
      if (clip.shape === 'polygon' && !turns) { anchorWidth = w; anchorHeight = h; }
      let path = clip.shape === 'polygon' ? polygonPath(clip.geometry.points, w, h) : `m 0 0 l ${w} 0 ${w} ${h} 0 ${h}${hole}`;
      // Zero-area corner paths give the glyph its full editable box. Its normal
      // centre alignment now follows a moving pivot even for an inset polygon.
      if (clip.shape === 'polygon' && turns) path += ` m 0 0 l 0 0 m ${w} ${h} l ${w} ${h}`;
      drawing = `{\\p1}${path}{\\p0}`;
    }
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      const precise = n => Number(n.toFixed(6));
      const scalePercent = p => precise(100 * p.scale);
      const x = p => precise(width * p.x - anchorWidth * scalePercent(p) / 200);
      const y = p => precise(height * p.y - anchorHeight * scalePercent(p) / 200);
      // Event timestamps have centisecond precision, move and transform offsets
      // have millisecond precision. Reference the actual project frame for splits.
      const eventMs = Math.floor((clip.start + a.frame) * 100 / fps + 1e-8) * 10;
      const t1 = Math.round((clip.start + a.frame) * 1000 / fps) - eventMs;
      const t2 = Math.round((clip.start + b.frame) * 1000 / fps) - eventMs;
      const pos = (x(a) === x(b) && y(a) === y(b)) ? `\\pos(${x(a)},${y(a)})` : `\\move(${x(a)},${y(a)},${x(b)},${y(b)},${t1},${t2})`;
      // ASS measures positive Z rotation counterclockwise; the editor uses screen coordinates.
      const transform = p => `\\fscx${scalePercent(p)}\\fscy${scalePercent(p)}${turns ? '\\frz' + precise(-p.rotation) : ''}\\1a${alpha(p.opacity * fg.opacity)}\\3a${alpha(p.opacity * bg.opacity)}`;
      const motion = (a.scale !== b.scale || a.opacity !== b.opacity || a.rotation !== b.rotation) ? `\\t(${t1},${t2},${transform(b)})` : '';
      const tags = `{\\an${anchorWidth ? 7 : 5}${pos}\\fs${font}\\1c${fg.rgb}\\3c${bg.rgb}\\bord${shape ? 0 : outline.toFixed(2)}${transform(a)}${motion}}`;
      lines.push(`Dialogue: ${isCaption ? 2 : 1},${clock(clip.start + a.frame, fps, true)},${clock(clip.start + b.frame, fps, true)},${boxed ? 'Box' : 'Caption'},,0,0,0,,${tags}${drawing}`);
    }
  }
  return head + lines.join('\n') + '\n';
}
