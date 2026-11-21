import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./vision-inspect.jxa', import.meta.url));

export async function describeFrames(media, asset, seconds, previous, { cache, signal, shareText }) {
  if (process.platform !== 'darwin') throw Error('此系统未提供本机 Vision 分析。');
  if (!asset || asset.kind === 'audio') throw Error('请选择工程内的图片或视频。');
  const valid = (t) => Number.isFinite(t) && t >= 0 && (asset.kind === 'image' ? t === 0 : t < asset.duration);
  if (!valid(seconds) || (previous != null && !valid(previous))) throw Error('观察时刻超出素材窗口。');
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(path.join(cache, 'vision-'));
  async function one(t) {
    const frame = path.join(dir, 'at-' + t + '.jpg');
    await media.frameAt(asset.path, t, frame, { signal, maxWidth: 720 });
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', script, frame], {
      signal,
      timeout: 30000,
      maxBuffer: 65536,
    });
    const data = JSON.parse(stdout);
    return {
      seconds: t,
      averageRGB: data.averageRGB,
      objects: data.objects,
      words: shareText ? data.words : undefined,
      cells: data.cells,
    };
  }
  try {
    const current = await one(seconds);
    let comparison;
    if (previous != null) {
      const prior = await one(previous);
      const changes = current.cells
        .map((v, i) => ({ index: i, difference: v - prior.cells[i] }))
        .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
      const change = changes[0];
      comparison = {
        previousSeconds: previous,
        previousObjects: prior.objects,
        previousWords: prior.words,
        averageLumaChange: Math.round(
          changes.reduce((sum, x) => sum + Math.abs(x.difference), 0) / changes.length
        ),
        strongestCell: change
          ? {
              column: change.index % 8,
              rowFromBottom: Math.floor(change.index / 8),
              lumaDifference: change.difference,
            }
          : null,
      };
    }
    const { cells, ...result } = current;
    return {
      ...result,
      comparison,
      method: 'macOS Vision OCR / image classification and sampled RGB; descriptions can be incomplete',
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
