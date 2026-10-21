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
    'plugins/video-studio/plugin.json',
    'plugins/video-studio/.codex-plugin/plugin.json',
    'plugins/video-studio/requirements-runtime.txt',
    'plugins/video-studio/scripts/studio.py',
    'plugins/video-studio/scripts/styles.py',
    'plugins/video-studio/scripts/review_sync.py',
    'plugins/video-studio/scripts/review_music.py',
    'plugins/video-studio/references/operations.md',
    'plugins/video-studio/references/style-format.md',
    'plugins/video-studio/references/diagnostics.md',
    'plugins/video-studio/skills/video-project/SKILL.md',
    'plugins/video-studio/skills/video-project/agents/openai.yaml',
    'plugins/video-studio/skills/setup-video-studio/SKILL.md',
    'plugins/video-studio/skills/setup-video-studio/agents/openai.yaml',
    'plugins/video-studio/skills/video-source-tools/SKILL.md',
    'plugins/video-studio/skills/video-source-tools/agents/openai.yaml',
    'plugins/video-studio/skills/chatcut-edit-tools/SKILL.md',
    'plugins/video-studio/skills/chatcut-edit-tools/agents/openai.yaml',
    'plugins/video-studio/skills/video-audio-tools/SKILL.md',
    'plugins/video-studio/skills/video-audio-tools/agents/openai.yaml',
    'plugins/video-studio/skills/video-delivery-tools/SKILL.md',
    'plugins/video-studio/skills/video-delivery-tools/agents/openai.yaml',
    'plugins/video-studio/skills/learn-video-style/SKILL.md',
    'plugins/video-studio/skills/learn-video-style/agents/openai.yaml',
    'tests/test_studio.py',
    'tests/test_styles.py',
    'tests/test_quality_review.py',
    'tests/test_review_sync.py',
    'tests/test_review_music.py',
    'tools/package.py',
    'plugins/video-studio/skills/video-quality-review/SKILL.md',
    'plugins/video-studio/skills/video-quality-review/agents/openai.yaml',
    'plugins/video-studio/references/quality-review.md',
]


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
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
    sha = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(".zip.sha256").write_text(f"{sha}  {output.name}\n")
    return {"archive": str(output), "sha256": sha, "files": len(FILES)}


if __name__ == "__main__":
    print(json.dumps(build(), indent=2))
