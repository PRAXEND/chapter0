#!/usr/bin/env python3
"""Bake a measured narration speed into a new PCM asset; never creates ASR times."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import tempfile
import wave

import studio

METHOD = 'ffmpeg-atempo-pcm-v1'
SAMPLE_RATE = 48000


def filters(rate):
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not math.isfinite(rate) or not .125 <= rate <= 8:
        raise ValueError('Narration speed must be a finite number between 0.125 and 8')
    stages = ['asetpts=PTS-STARTPTS']
    while rate > 2:
        stages.append('atempo=2'); rate /= 2
    while rate < .5:
        stages.append('atempo=0.5'); rate /= .5
    stages.extend(['atempo=%.12g' % rate, 'aresample=48000:async=1:first_pts=0'])
    return stages


def audio_stream(source, index=None):
    streams = [s for s in studio.probe_media(source)['streams'] if s.get('codec_type') == 'audio']
    selected = (next((s for s in streams if s['index'] == index), None) if index is not None else
                next((s for s in streams if s.get('disposition', {}).get('default')), streams[0] if streams else None))
    if selected is None or not 1 <= selected.get('channels', 0) <= 2:
        raise ValueError('A real mono/stereo narration source is required')
    return selected


def render(source, output, rate, stream_index):
    """A deterministic transform recipe, shared by preparation and verification."""
    selected = audio_stream(source, stream_index)
    studio.execute(['ffmpeg', '-v', 'error', '-nostdin', '-n', '-i', source,
                    '-map', '0:' + str(selected['index']), '-vn', '-map_metadata', '-1',
                    '-af', ','.join(filters(rate)), '-ar', str(SAMPLE_RATE),
                    '-ac', str(selected['channels']), '-c:a', 'pcm_s16le',
                    '-flags', '+bitexact', '-fflags', '+bitexact', '-f', 'wav', output], timeout=900)


def pcm_info(file):
    """Hash actual PCM frames, excluding container headers and metadata."""
    with wave.open(str(file), 'rb') as stream:
        if stream.getcomptype() != 'NONE' or stream.getsampwidth() != 2 or stream.getframerate() != SAMPLE_RATE:
            raise ValueError('Derived narration must be 48 kHz PCM16 WAV')
        if not 1 <= stream.getnchannels() <= 2 or stream.getnframes() <= 0:
            raise ValueError('Empty or unsupported derived narration')
        digest, frames = hashlib.sha256(), 0
        while block := stream.readframes(48000):
            digest.update(block)
            frames += len(block) // (2 * stream.getnchannels())
        if frames != stream.getnframes():
            raise ValueError('Truncated derived PCM')
        return {'pcm_sha256': digest.hexdigest(), 'sample_rate': SAMPLE_RATE,
                'channels': stream.getnchannels(), 'sample_width': 2, 'frames': frames}


def prepare(source, output, rate, source_asset_id, receipt):
    source, output, receipt = (Path(p).expanduser().resolve() for p in (source, output, receipt))
    filters(rate)
    if not isinstance(source_asset_id, str) or not source_asset_id.strip() or not source.is_file():
        raise ValueError('Provide the actual generated asset ID and downloaded source file')
    if output == receipt or output.exists() or receipt.exists():
        raise ValueError('New output and receipt paths are required; existing files are never overwritten')
    source_hash = studio.file_hash(source)
    selected = audio_stream(source)
    binary = studio.native_tool('ffmpeg')
    output.parent.mkdir(parents=True, exist_ok=True)
    receipt.parent.mkdir(parents=True, exist_ok=True)
    # Prepare off to the side. Exclusive final writes also reject a concurrent overwrite.
    with tempfile.TemporaryDirectory(prefix='narration-prepare-', dir=output.parent) as temp:
        wav = Path(temp) / 'derived.wav'
        render(source, wav, rate, selected['index'])
        if studio.file_hash(source) != source_hash:
            raise ValueError('Narration source changed during conversion')
        record = {'schema': 1, 'method': METHOD, 'rate': rate, 'audio_stream_index': selected['index'],
                  'filters': filters(rate), 'source': {'assetId': source_asset_id, 'path': str(source), 'sha256': source_hash},
                  'output': {'path': str(output), 'sha256': studio.file_hash(wav), **pcm_info(wav)},
                  'ffmpeg': {'sha256': studio.file_hash(binary),
                             'version': studio.execute([binary, '-version']).stdout.splitlines()[0]},
                  'transcript_policy': 'transcribe_imported_output'}
        with output.open('xb') as destination, wav.open('rb') as origin:
            import shutil
            shutil.copyfileobj(origin, destination)
        with receipt.open('x', encoding='utf-8') as destination:
            json.dump(record, destination, ensure_ascii=False, indent=2, allow_nan=False)
            destination.write('\n')
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--source-asset-id', required=True)
    parser.add_argument('--rate', required=True, type=float)
    parser.add_argument('--output', required=True)
    parser.add_argument('--receipt', required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source, args.output, args.rate, args.source_asset_id, args.receipt), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
