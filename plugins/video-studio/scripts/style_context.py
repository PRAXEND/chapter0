"""Small, snapshot-bound creative guidance and reusable visual reference evidence."""
from pathlib import Path
from fractions import Fraction
import math
import re
import subprocess

import studio
import style_media


def verified_benchmark(pack, locator, expected):
    relative = locator.removeprefix('resource:')
    video = style_media.safe_file(pack, relative)
    if not re.fullmatch('[0-9a-f]{64}', expected or ''):
        raise ValueError('Style benchmark missing or changed')
    if video.is_file():
        if studio.file_hash(video) == expected:
            return video
        with video.open('rb') as source:
            prefix = source.read(180)
        if prefix and not prefix.startswith(style_media.POINTER):
            raise ValueError('Style benchmark missing or changed')
    # LFS pointers and macOS dataless placeholders may coexist with the exact verified object.
    # Confirm the tracked pointer for this specific pack path before reading its local object.
    def git(*args):
        return subprocess.check_output(['git', '-C', str(pack), *args], stderr=subprocess.DEVNULL, timeout=4, text=True).strip()
    try:
        top = Path(git('rev-parse', '--show-toplevel')).resolve()
        name = 'HEAD:' + video.resolve().relative_to(top).as_posix()
        if int(git('cat-file', '-s', name)) <= 256 and 'oid sha256:' + expected in git('cat-file', '-p', name).splitlines():
            common = Path(git('rev-parse', '--path-format=absolute', '--git-common-dir'))
            stored = style_media.safe_file(common, 'lfs/objects/' + expected[:2] + '/' + expected[2:4] + '/' + expected)
            if stored.is_file() and studio.file_hash(stored) == expected:
                return stored
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    raise ValueError('Style benchmark missing or changed')


def reproduction_guide(spec, spec_path):
    bundle = spec.get('reproduction_bundle') or {}
    blueprint = spec.get('reproduction_blueprint') or {}
    baseline = bundle.get('baseline')
    if not baseline:
        benchmarks = [ref for ref in spec.get('references', []) if ref.get('kind') == 'video'
                      and ref.get('locator', '').startswith('resource:media/benchmarks/')]
        if len(benchmarks) == 1:
            ref = benchmarks[0]
            baseline = {'path': ref['locator'], 'sha256': ref.get('sha256'), 'reference_id': ref.get('id')}
    fields = [key for source, names in ((bundle, ('specific_edit_recipe', 'motion_graphics', 'canonical_captions')),
              (blueprint, ('components', 'effect_recipes', 'shot_reference', 'captions'))) for key in names if key in source]
    return {'baseline': baseline, 'documents': bundle.get('documents', {}), 'full_spec': str(spec_path),
            'on_demand_fields': fields, 'components': [{'id': row.get('id'), 'role': row.get('role')}
                for row in blueprint.get('components', [])],
            'effect_recipes': [row.get('name') for row in blueprint.get('effect_recipes', []) if row.get('name')]}


def prepare(run, snapshot):
    if not snapshot:
        return None
    root = Path(run).resolve(strict=True)
    folder = Path(snapshot['skill_path']).parent.resolve(strict=True)
    if not folder.is_relative_to(root):
        raise ValueError('Style snapshot outside run')
    for name, expected in snapshot['files'].items():
        if studio.file_hash(folder / name) != expected:
            raise ValueError('Style snapshot changed')
    spec = studio.read(folder / 'style.json')
    guide = {key: spec[key] for key in ('id', 'version', 'name', 'description', 'adaptation', 'rules',
             'references', 'material_requirements', 'storyboard_contract', 'unknown_dimensions') if key in spec}
    # Preserve every rule, but load implementation source only for the chosen effect.
    guide['reproduction'] = reproduction_guide(spec, folder / 'style.json')
    target = root / 'style-context' / snapshot['files']['style.json']
    if not target.resolve().is_relative_to(root):
        raise ValueError('Style context outside run')
    target.mkdir(parents=True, exist_ok=True)
    guide_file = target / 'guide.json'
    if not guide_file.resolve().is_relative_to(root):
        raise ValueError('Style guide outside run')
    if not guide_file.exists() or studio.read(guide_file) != guide:
        studio.write(guide_file, guide)
    return {'selector': snapshot['selector'], 'skill': str(folder / 'SKILL.md'), 'spec': str(folder / 'style.json'),
            'guide': str(guide_file), 'guide_sha256': studio.file_hash(guide_file), 'files': snapshot['files']}


def reference_probe(run):
    """Reference pictures are diagnostics; no production or remote calls."""
    import quality_probe
    root = Path(run).resolve(strict=True)
    data = studio.load_run(root)
    context = prepare(root, data.get('style_snapshot'))
    if not context:
        return None
    guide = studio.read(context['guide'])
    baseline = guide.get('reproduction', {}).get('baseline')
    if not baseline:
        return None  # A script-only style does not gain an invented visual benchmark.
    locator = baseline.get('path', '')
    if not locator.startswith('resource:'):
        raise ValueError('Unsupported benchmark locator')
    pack = style_media.locate_pack()
    expected = baseline.get('sha256')
    video = verified_benchmark(pack, locator, expected)
    directory = Path(context['guide']).parent / ('reference-' + expected[:16])
    if not directory.resolve().is_relative_to(root):
        raise ValueError('Style reference diagnostics outside run')
    manifest = directory / 'manifest.json'
    if manifest.is_file():
        try:
            cached = studio.read(manifest)
            if (cached.get('artifact_sha256') == expected and cached.get('guide_sha256') == context['guide_sha256'] and cached.get('contact_sheets')
                    and all(Path(s['path']).resolve().is_relative_to(directory.resolve())
                            and studio.file_hash(s['path']) == s['sha256'] for s in cached['contact_sheets'])):
                return {**cached, 'manifest': str(manifest), 'sha256': studio.file_hash(manifest)}
        except (OSError, KeyError, ValueError):
            pass  # Rebuild missing/corrupt diagnostics, never edit the original benchmark.
    directory.mkdir(parents=True, exist_ok=True)
    media = studio.probe_media(video)
    stream = next(s for s in media['streams'] if s['codec_type'] == 'video')
    fps = float(Fraction(stream['avg_frame_rate']))
    duration = float(stream.get('duration') or media['format']['duration'])
    if not 0 < duration <= 1200 or not math.isfinite(fps) or fps <= 0:
        raise ValueError('Invalid benchmark duration/fps')
    frames = round(fps * duration)
    schedule = {'sample_frames': sorted({0, frames - 1, *(min(frames - 1, round(t * fps / 2))
                            for t in range(math.ceil(duration * 2)))})}
    sheets = quality_probe.contact_sheets(video, directory, schedule)
    result = {'schema': 1, 'style': context['selector'], 'artifact': str(video), 'artifact_sha256': expected,
              'guide_sha256': context['guide_sha256'], 'frames': frames, 'fps': fps,
              'width': stream['width'], 'height': stream['height'], 'contact_sheets': sheets,
              'method': 'sampled_reference_frames', 'limitations': ['No playback or listening claim']}
    studio.write(manifest, result)
    return {**result, 'manifest': str(manifest), 'sha256': studio.file_hash(manifest)}
