import { open, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { scratch } from './media-runtime.mjs';

// Original arrangements expressed as MIDI notes. No third-party recordings or samples.
const scores = {
  calm: { bpm: 72, chords: [[48, 55, 62, 64], [45, 52, 59, 60], [41, 48, 55, 57], [43, 50, 57, 59]], notes: [0, 2, 1, 3, 1, 2, 0, 1] },
  pulse: { bpm: 106, chords: [[50, 57, 60, 64], [46, 53, 57, 60], [48, 55, 58, 62], [45, 52, 55, 61]], notes: [0, 1, 3, 2, 0, 2, 1, 3] }
};
const frequency = midi => 440 * 2 ** ((midi - 69) / 12);
const tone = (hz, t) => Math.sin(2 * Math.PI * hz * t);

export async function createMusicBed(output, { duration, style = 'calm', signal } = {}) {
  if (!scores[style] || !Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('配乐风格或时长无效');
  const rate = 24000, samples = Math.round(duration * rate);
  const score = scores[style];
  const beat = 60 / score.bpm;
  const hash = createHash('sha256');
  return scratch(path.dirname(output), async tmp => {
    const candidate = path.join(tmp, 'bed.wav');
    const file = await open(candidate, 'w');
    try {
      const header = Buffer.alloc(44);
      header.write('RIFF'); header.writeUInt32LE(36 + samples * 2, 4); header.write('WAVEfmt ', 8);
      header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
      header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(samples * 2, 40);
      await file.writeFile(header); hash.update(header);
      for (let start = 0; start < samples; start += 24000) {
        signal?.throwIfAborted();
        const count = Math.min(samples - start, 24000);
        const buffer = Buffer.allocUnsafe(count * 2);
        for (let i = 0; i < count; i++) {
          const t = (start + i) / rate, timeInBar = t % (beat * 4), hit = t % (beat / 2);
          const chord = score.chords[Math.floor(t / (beat * 4)) % 4];
          const step = Math.floor(timeInBar * 2 / beat) % 8;
          const pitch = frequency(chord[score.notes[step]] + 12);
          const envelope = (1 - Math.exp(-hit * 150)) * Math.exp(-hit * 9);
          const keys = envelope * (tone(pitch, hit) + 0.22 * tone(2 * pitch, hit));
          const pad = (tone(frequency(chord[0]), timeInBar) + tone(frequency(chord[1]), timeInBar)) *
            Math.min(1, timeInBar * 4, (beat * 4 - timeInBar) * 4);
          const kickTime = t % beat;
          const kick = style === 'pulse' ? Math.exp(-kickTime * 18) * tone(52, kickTime) * 0.20 : 0;
          const fade = Math.min(1, t * 3, (duration - t) / 1.5);
          buffer.writeInt16LE(Math.round(32767 * fade * (0.17 * keys + 0.07 * pad + kick)), 2 * i);
        }
        await file.writeFile(buffer); hash.update(buffer);
      }
    } finally { await file.close(); }
    signal?.throwIfAborted();
    await rename(candidate, output);
    return { path: output, audioPath: output, duration: samples / rate, sha256: hash.digest('hex'), mode: 'library', model: `studio-${style}-1`, credit: 'Video Studio · 本地程序编曲' };
  });
}
