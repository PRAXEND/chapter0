#!/usr/bin/env python3
"""Build a reproducible source distribution from an explicit file allowlist."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    '.agents/plugins/marketplace.json',
    'README.md',
    'VALIDATION.md',
    'CHANGELOG.md',
    '.gitignore',
    'sites/video-agent-demo/start.mjs',
    'sites/video-agent-demo/studio-server.mjs',
    'sites/video-agent-demo/package.json',
    'sites/video-agent-demo/README.md',
    'plugins/video-studio/plugin.json',
    'plugins/video-studio/.codex-plugin/plugin.json',
    'plugins/video-studio/requirements-runtime.txt',
    'plugins/video-studio/scripts/studio.py',
    'plugins/video-studio/scripts/styles.py',
    'plugins/video-studio/scripts/style_plan.py',
    'plugins/video-studio/scripts/check_connection.py',
    'plugins/video-studio/scripts/user_packs.py',
    'plugins/video-studio/scripts/web_bridge.py',
    'plugins/video-studio/scripts/web_styles.py',
    'tests/test_web_styles.py',
    'plugins/video-studio/scripts/review_sync.py',
    'plugins/video-studio/scripts/review_music.py',
    'plugins/video-studio/references/operations.md',
    'plugins/video-studio/references/style-format.md',
    'plugins/video-studio/references/style-storyboard.md',
    'plugins/video-studio/references/diagnostics.md',
    'plugins/video-studio/references/connection-recovery.md',
    'plugins/video-studio/references/style-selection.md',
    'plugins/video-studio/references/web-workbench.md',
    'plugins/video-studio/skills/video-project/SKILL.md',
    'plugins/video-studio/skills/video-project/agents/openai.yaml',
    'plugins/video-studio/skills/setup-video-studio/SKILL.md',
    'plugins/video-studio/skills/setup-video-studio/agents/openai.yaml',
    'plugins/video-studio/skills/video-source-tools/SKILL.md',
    'plugins/video-studio/skills/video-source-tools/agents/openai.yaml',
    'plugins/video-studio/skills/video-source-tools/references/material-selection-cards.md',
    'plugins/video-studio/skills/video-source-tools/references/robotics-multisource-roundup.md',
    'plugins/video-studio/skills/video-source-tools/references/robotics-official-research.md',
    'plugins/video-studio/skills/video-source-tools/references/robotics-x-repository.md',
    'plugins/video-studio/skills/video-source-tools/references/robotics-youtube.md',
    'plugins/video-studio/skills/chatcut-edit-tools/SKILL.md',
    'plugins/video-studio/skills/chatcut-edit-tools/agents/openai.yaml',
    'plugins/video-studio/skills/video-audio-tools/SKILL.md',
    'plugins/video-studio/skills/video-audio-tools/references/voice-selection.md',
    'plugins/video-studio/skills/video-audio-tools/agents/openai.yaml',
    'plugins/video-studio/skills/video-delivery-tools/SKILL.md',
    'plugins/video-studio/skills/video-delivery-tools/agents/openai.yaml',
    'plugins/video-studio/skills/learn-video-style/SKILL.md',
    'plugins/video-studio/skills/learn-video-style/agents/openai.yaml',
    'tests/test_studio.py',
    'tests/test_styles.py',
    'tests/test_style_plan.py',
    'tests/test_connection.py',
    'tests/test_user_packs.py',
    'tests/test_web_bridge.py',
    'tests/test_packaging.py',
    'tests/test_quality_review.py',
    'tests/test_review_sync.py',
    'tests/test_review_music.py',
    'tools/package.py',
    'tools/package_video_demo.py',
    'tools/verify_video_demo.mjs',
    'plugins/video-studio/scripts/open-workbench.mjs',
    'plugins/video-studio/skills/open-video-workbench/SKILL.md',
    'plugins/video-studio/skills/open-video-workbench/agents/openai.yaml',
    'plugins/video-studio/skills/video-quality-review/SKILL.md',
    'plugins/video-studio/skills/video-quality-review/agents/openai.yaml',
    'plugins/video-studio/references/quality-review.md',
]


WORKBENCH_FILES = json.loads((ROOT / 'plugins/video-studio/workbench/files.json').read_text())
FILES += ['plugins/video-studio/workbench/' + name for name in WORKBENCH_FILES]


def build(root=ROOT):
    root = Path(root)
    manifest = json.loads((root / "plugins/video-studio/plugin.json").read_text())
    compatibility = json.loads((root / "plugins/video-studio/.codex-plugin/plugin.json").read_text())
    if (manifest["name"], manifest["version"]) != (compatibility["name"], compatibility["version"]):
        raise ValueError("Portable and compatibility identities differ")
    name = f"video-studio-{manifest['version']}"
    output = root / "dist" / f"{name}.zip"
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in sorted(FILES):
            path = root / item
            if path.is_symlink() or not path.is_file() or root.resolve() not in path.resolve().parents:
                raise ValueError(f"Missing or unsafe distribution file: {item}")
            info = zipfile.ZipInfo(f"{name}/{item}", date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if path.suffix in {".command", ".sh"} else 0o644) << 16
            archive.writestr(info, path.read_bytes())
    plugin_output = root / 'dist' / f'video-studio-plugin-{manifest["version"]}.zip'
    with zipfile.ZipFile(plugin_output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        checks = []
        for item in sorted(FILES):
            if not item.startswith('plugins/video-studio/'):
                continue
            file = root / item
            info = zipfile.ZipInfo(item.removeprefix('plugins/video-studio/'), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if file.suffix in {'.command', '.sh'} else 0o644) << 16
            content = file.read_bytes()
            archive.writestr(info, content)
            checks.append(hashlib.sha256(content).hexdigest() + '  ' + info.filename)
        archive.writestr('SHA256SUMS.txt', '\n'.join(checks) + '\n')
    plugin_sha = hashlib.sha256(plugin_output.read_bytes()).hexdigest()
    plugin_output.with_suffix('.zip.sha256').write_text(f'{plugin_sha}  {plugin_output.name}\n')
    sha = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(".zip.sha256").write_text(f"{sha}  {output.name}\n")
    return {"archive": str(output), "sha256": sha, "files": len(FILES), "pluginArchive": str(plugin_output), "pluginSha256": plugin_sha}


if __name__ == "__main__":
    print(json.dumps(build(), indent=2))
