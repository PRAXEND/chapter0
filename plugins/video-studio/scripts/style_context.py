"""Small, snapshot-bound creative guidance and reusable visual reference evidence."""
from pathlib import Path
from fractions import Fraction
import math

import studio
import style_media


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
    bundle = spec.get('reproduction_bundle') or {}
    guide = {key: spec[key] for key in ('id', 'version', 'name', 'description', 'adaptation', 'rules',
             'references', 'material_requirements', 'storyboard_contract', 'unknown_dimensions') if key in spec}
    # Preserve every rule, but load implementation source only for the chosen effect.
    guide['reproduction'] = {'baseline': bundle.get('baseline'), 'documents': bundle.get('documents', {}),
                             'full_spec': str(folder / 'style.json'),
                             'on_demand_fields': ['specific_edit_recipe', 'motion_graphics', 'canonical_captions']}
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
    video = style_media.safe_file(pack, locator.removeprefix('resource:'))
    expected = baseline.get('sha256')
    if not expected or studio.file_hash(video) != expected:
        raise ValueError('Style benchmark missing or changed')
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
