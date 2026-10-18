#!/usr/bin/env python3
"""Build a reproducible source distribution from an explicit file allowlist."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    ".agents/plugins/marketplace.json", "README.md", "VALIDATION.md", "CHANGELOG.md", ".gitignore",
    "plugins/robot-video-studio/plugin.json", "plugins/robot-video-studio/.codex-plugin/plugin.json",
    "plugins/robot-video-studio/requirements-runtime.txt", "plugins/robot-video-studio/scripts/studio.py",
    "plugins/robot-video-studio/scripts/review_sync.py", "plugins/robot-video-studio/references/repairs.md",
    "plugins/robot-video-studio/scripts/review_music.py", "plugins/robot-video-studio/references/music-pauses.md",
    "plugins/robot-video-studio/scripts/review_edit.py", "plugins/robot-video-studio/references/editing-rhythm.md",
    "plugins/robot-video-studio/references/narration-motion.md",
    "plugins/robot-video-studio/references/editorial.md", "plugins/robot-video-studio/references/operations.md", "plugins/robot-video-studio/references/quality.md",
    "plugins/robot-video-studio/skills/setup-robot-video/SKILL.md", "plugins/robot-video-studio/skills/setup-robot-video/agents/openai.yaml",
    "plugins/robot-video-studio/skills/produce-robot-video/SKILL.md", "plugins/robot-video-studio/skills/produce-robot-video/agents/openai.yaml",
    "tests/test_studio.py", "tests/test_review_sync.py", "tests/test_review_music.py", "tests/test_review_edit.py", "tools/package.py",
]


def build(root=ROOT):
    root = Path(root)
    manifest = json.loads((root / "plugins/robot-video-studio/plugin.json").read_text())
    compatibility = json.loads((root / "plugins/robot-video-studio/.codex-plugin/plugin.json").read_text())
    if (manifest["name"], manifest["version"]) != (compatibility["name"], compatibility["version"]):
        raise ValueError("Portable and compatibility identities differ")
    name = f"robot-video-studio-{manifest['version']}"
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
