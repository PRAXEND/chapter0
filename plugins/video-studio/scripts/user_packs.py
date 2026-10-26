"""Explicit import of optional user styles and preferences; no network or media."""
import json
from pathlib import Path
import re
import shutil
import tempfile

import styles


def _file(root, relative):
    relative = Path(relative)
    target = root / relative
    if relative.is_absolute() or ".." in relative.parts or target.is_symlink():
        raise ValueError("Pack paths must stay inside the selected pack")
    if root.resolve() not in target.resolve().parents or not target.is_file():
        raise ValueError(f"Missing or unsafe pack file: {relative}")
    if target.suffix not in {".json", ".md", ".txt"} or target.stat().st_size > 1_000_000:
        raise ValueError("User packs contain small text evidence and specs only")
    return target


def install(manifest_file, apply_preferences=False):
    from studio import home, read, write, file_hash, digest, locked, profile, validate_settings, save_profile
    manifest_path = Path(manifest_file).expanduser().resolve()
    source = manifest_path.parent
    manifest = read(manifest_path)
    slug, version = manifest.get("id", ""), manifest.get("version")
    if (manifest.get("schema_version") != 1 or not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", slug)
            or type(version) is not int or version < 1):
        raise ValueError("Pack needs schema_version 1, lowercase id and positive integer version")
    destination = home() / "user-packs" / slug / str(version)
    files = {manifest_path.name: manifest_path}

    def relocate(value):
        if isinstance(value, str) and value.startswith("pack:"):
            relative = value[5:]
            files[relative] = _file(source, relative)
            return str(destination / relative)
        if isinstance(value, list):
            return [relocate(v) for v in value]
        if isinstance(value, dict):
            return {k: relocate(v) for k, v in value.items()}
        return value

    specs = []
    for relative in manifest.get("styles", []):
        files[relative] = _file(source, relative)
        specs.append(styles.validate(relocate(read(files[relative]))))
    selectors = [f"{s['id']}@{s['version']}" for s in specs]
    if not specs or len(set(selectors)) != len(selectors):
        raise ValueError("Pack needs unique styles")
    preferences = relocate(manifest.get("profile_patch", {}))
    if apply_preferences:
        if not isinstance(preferences, dict) or set(preferences) - set(profile()):
            raise ValueError("Unknown profile preference keys")
        validate_settings({**profile(), **preferences})
    # Detect all known conflicts before installing any entry. Repeated import is safe.
    existing = {}
    for selector, spec in zip(selectors, specs):
        folder = styles.root() / spec["id"] / str(spec["version"])
        if folder.exists():
            entry = styles.resolve(selector)
            if entry["spec"] != spec:
                raise ValueError(f"Style version conflict: {selector}; create a new version")
            existing[selector] = entry
    hashes = {name: file_hash(path) for name, path in files.items()}
    with locked(home() / "user-packs"):
        if destination.exists():
            marker = read(destination / "import-manifest.json")
            if marker.get("files") != hashes or any(file_hash(destination / n) != h for n, h in hashes.items()):
                raise ValueError("Imported pack version changed; create a new version")
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            stage = Path(tempfile.mkdtemp(prefix=".pack-", dir=destination.parent))
            try:
                for name, path in files.items():
                    target = stage / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(path, target)
                write(stage / "import-manifest.json", {"files": hashes, "digest": digest(hashes)})
                stage.rename(destination)
            finally:
                if stage.exists():
                    shutil.rmtree(stage)
    entries = [existing.get(selector) or styles.register(spec) for selector, spec in zip(selectors, specs)]
    if apply_preferences:
        save_profile(preferences)
    return {"pack": f"{slug}@{version}", "path": str(destination),
            "styles": [{"selector": e["selector"], "skill_path": e["skill_path"],
                        "validation_status": e["validation_status"]} for e in entries],
            "preferences_applied": bool(apply_preferences), "network_calls": 0}
