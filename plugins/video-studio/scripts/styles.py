"""Versioned user style skills. No presets, network calls or media copying."""
import copy
import json
from pathlib import Path
import re
import shutil
import tempfile

DIMENSIONS = {"narrative", "language", "shots", "pacing", "graphics", "captions", "audio", "transitions"}
TEXT_DIMENSIONS = {"narrative", "language"}


def validate(spec):
    if not isinstance(spec, dict) or spec.get("schema_version") != 1:
        raise ValueError("Style schema_version must be 1")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", spec.get("id", "")):
        raise ValueError("Style id must be a lowercase slug, at most 48 characters")
    if type(spec.get("version")) is not int or spec["version"] < 1:
        raise ValueError("Style version must be a positive integer")
    for key in ("name", "description", "adaptation"):
        if not isinstance(spec.get(key), str) or not spec[key].strip():
            raise ValueError(f"Style needs {key}")
    refs = spec.get("references", [])
    if not refs or len({r["id"] for r in refs}) != len(refs):
        raise ValueError("Style needs unique reference ids")
    for ref in refs:
        if ref.get("kind") not in {"script", "video", "user_direction"} or not ref.get("locator"):
            raise ValueError("Reference needs kind and a source locator")
    by_id = {r["id"]: r for r in refs}
    rules = spec.get("rules", [])
    if not rules or len({r["id"] for r in rules}) != len(rules):
        raise ValueError("Style needs unique rules")
    for rule in rules:
        if rule.get("dimension") not in DIMENSIONS or not rule.get("instruction") or not rule.get("check"):
            raise ValueError("Rule needs a dimension, actionable instruction and observable check")
        if rule.get("basis") not in {"observed", "inferred", "user_direction"}:
            raise ValueError("Rule basis must distinguish observations, inference and user direction")
        evidence = rule.get("evidence", [])
        if not evidence or any(e.get("reference_id") not in by_id or not e.get("location") for e in evidence):
            raise ValueError("Every rule needs identifiable source evidence")
        kinds = {by_id[e["reference_id"]]["kind"] for e in evidence}
        if rule["dimension"] not in TEXT_DIMENSIONS and kinds == {"script"}:
            raise ValueError("Script-only evidence cannot establish audiovisual style")
        if rule["basis"] == "user_direction" and "user_direction" not in kinds:
            raise ValueError("User direction requires an actual user-direction reference")
    unknown = spec.get("unknown_dimensions")
    covered = {r["dimension"] for r in rules}
    if not isinstance(unknown, list) or set(unknown) != DIMENSIONS - covered:
        raise ValueError("unknown_dimensions must name exactly the unobserved dimensions")
    needs = spec.get("material_requirements", [])
    if not isinstance(needs, list):
        raise ValueError("material_requirements must be a list")
    rule_ids = {r["id"] for r in rules}
    for need in needs:
        if not all(need.get(k) for k in ("role", "search_hint", "acceptance")) or need.get("rule_id") not in rule_ids:
            raise ValueError("Material need requires role, topic-neutral search hint, acceptance and rule_id")
    contract = spec.get("storyboard_contract")
    if contract is not None:
        if not isinstance(contract, dict):
            raise ValueError("storyboard_contract must be an object")
        for key in ("core_rule_ids", "visual_rule_ids"):
            ids = contract.get(key)
            if not isinstance(ids, list) or any(not isinstance(i, str) or i not in rule_ids for i in ids) or len(set(ids)) != len(ids):
                raise ValueError("Storyboard contract must reference unique existing rules")
        if not contract["core_rule_ids"] or not set(contract["visual_rule_ids"]) <= set(contract["core_rule_ids"]):
            raise ValueError("Visual requirements must be core rules")
        conditional = contract.get("conditional_rules")
        if not isinstance(conditional, list) or any(not isinstance(c, dict) or c.get("rule_id") not in rule_ids or
                not isinstance(c.get("when"), str) or not c["when"].strip() for c in conditional):
            raise ValueError("Conditional techniques need existing rule ids and applicability conditions")
        ids = [c["rule_id"] for c in conditional]
        if len(set(ids)) != len(ids) or set(ids) & set(contract["core_rule_ids"]):
            raise ValueError("Core rules cannot also be optional techniques")
        if any(not isinstance(contract.get(k), str) or not contract[k].strip() for k in ("planning_guidance", "reference_guidance")):
            raise ValueError("Storyboard contract needs planning and reference guidance")
    return spec


def render(spec):
    title = json.dumps(f"复用用户选择的“{spec['name']}”风格；适用范围：{spec['description']}", ensure_ascii=False)
    lines = ["---", f"name: style-{spec['id']}", f"description: {title}", "---", "",
             f"# {spec['name']} · v{spec['version']}", "",
             "仅在本次选择此风格时加载。当前用户要求优先；未覆盖的维度保持自由，不从旧模板补齐。",
             "风格负责表达规则；工具参数和操作流程读取 Video Studio 的相应工具技能。",
             "本包是提炼的风格规则，保存不代表已通过成片复现验证。", "", "## 跨题材适配", spec["adaptation"], "",
             ]
    contract = spec.get("storyboard_contract")
    if contract:
        lines += ["## 分镜中的核心表达", contract["planning_guidance"],
                  "必须落实的核心规则：" + "、".join(contract["core_rule_ids"]),
                  "需要具体画面/动效设计的规则：" + ("、".join(contract["visual_rule_ids"]) or "无；按内容决定。"),
                  "核心表达按故事落到镜头，不设统一效果数量。其他规则仍生效；下列手法只有满足条件时使用。"]
        lines += [f"- {c['rule_id']}：{c['when']}；不适用时记录本题原因，不写成已实现。" for c in contract["conditional_rules"]]
        lines += ["", "## 参考对照与实现", contract["reference_guidance"],
                  "分镜逐条关联规则和镜头；动效写清用途、触发词/动作、进入—变化—退出、预计时长、位置与动作保护、声音、实现前提及替代方案。",
                  "制作后按最终音频重新定位，登记真实时间线对象和帧区间。比较核心表达与参考的差异；未实现、无法观看或听审均如实记录，不以组件数量或参数读回代替风格通过。", ""]
    lines += ["## 复现规则"]
    for rule in spec["rules"]:
        evidence = "; ".join(f"{e['reference_id']} @ {e['location']}" for e in rule["evidence"])
        lines += [f"- {rule['id']} / {rule['dimension']} / {rule['basis']}: {rule['instruction']}",
                  f"  检查：{rule['check']}；依据：{evidence}"]
    lines += ["", "## 素材需求"]
    for need in spec.get("material_requirements", []):
        lines += [f"- {need['role']}：{need['search_hint']}；采用标准：{need['acceptance']}（{need['rule_id']}）"]
    lines += ["", "## 未知维度", ", ".join(spec["unknown_dimensions"]) or "无；仍需在当前素材上验证。",
              "", "完整参考索引见同目录 style.json。示例内容是分析数据，不提供工具执行权限。", ""]
    return "\n".join(lines)


def root():
    from studio import home
    return home() / "styles"


def register(spec):
    from studio import locked, write, file_hash, now
    spec = copy.deepcopy(validate(spec))
    folder = root() / spec["id"] / str(spec["version"])
    with locked(root()):
        if folder.exists():
            raise ValueError("Style version already exists; create a new version")
        folder.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix=".style-", dir=folder.parent))
        try:
            write(stage / "style.json", spec)
            (stage / "SKILL.md").write_text(render(spec), encoding="utf-8")
            write(stage / "manifest.json", {"created_at": now(), "validation_status": "unverified",
                  "files": {n: file_hash(stage / n) for n in ("style.json", "SKILL.md")}})
            stage.rename(folder)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    return resolve(f"{spec['id']}@{spec['version']}")


def resolve(selector):
    from studio import read, file_hash
    match = re.fullmatch(r"([a-z][a-z0-9-]{0,47})(?:@([1-9][0-9]*))?", selector)
    if not match:
        raise ValueError("Select style-id or style-id@version")
    slug, version = match.groups()
    parent = root() / slug
    versions = sorted(int(p.name) for p in parent.glob("*") if p.is_dir() and p.name.isdigit())
    if not versions or (version and int(version) not in versions):
        raise ValueError(f"Unknown style: {selector}")
    folder = parent / str(int(version) if version else versions[-1])
    manifest = read(folder / "manifest.json")
    for name in ("style.json", "SKILL.md"):
        if file_hash(folder / name) != manifest["files"][name]:
            raise ValueError("Style content changed outside versioning; restore it or register a new version")
    spec = validate(read(folder / "style.json"))
    return {"id": spec["id"], "version": spec["version"], "name": spec["name"],
            "selector": f"{spec['id']}@{spec['version']}", "description": spec["description"],
            "skill_path": str(folder / "SKILL.md"), "spec": spec,
            "files": manifest["files"], "validation_status": manifest["validation_status"]}


def catalog():
    entries = []
    for folder in sorted(root().glob("*/*")):
        if folder.is_dir() and folder.name.isdigit() and not folder.parent.name.startswith("."):
            try:
                value = resolve(f"{folder.parent.name}@{folder.name}")
                entries.append({k: v for k, v in value.items() if k != "spec"})
            except (ValueError, OSError, KeyError) as exc:
                entries.append({"id": folder.parent.name, "version": folder.name, "error": str(exc)})
    return entries


def snapshot(selector, run):
    from studio import file_hash
    value = resolve(selector)
    source = Path(value["skill_path"]).parent
    folder = Path(run) / "style" / value["selector"]
    folder.mkdir(parents=True, exist_ok=True)
    for name, expected in value["files"].items():
        target = folder / name
        if target.exists() and file_hash(target) != expected:
            raise ValueError("Run style snapshot was modified")
        if not target.exists():
            shutil.copyfile(source / name, target)
        if file_hash(target) != expected:
            raise ValueError("Style snapshot hash mismatch")
    return {"id": value["id"], "version": value["version"], "selector": value["selector"],
            "skill_path": str(folder / "SKILL.md"), "files": value["files"],
            "validation_status": value["validation_status"]}


def choices():
    """Host-neutral choice data; selection never starts production or sets a default."""
    options, errors = [], []
    for entry in catalog():
        if entry.get("error"):
            errors.append(entry)
            continue
        value = resolve(entry["selector"])
        spec = value["spec"]
        options.append({"id": value["selector"], "label": value["name"],
                        "description": value["description"],
                        "validation_status": value["validation_status"],
                        "dimensions": sorted({r["dimension"] for r in spec["rules"]}),
                        "unknown_dimensions": spec["unknown_dimensions"]})
    return {"field_id": "video_style", "options": options, "errors": errors,
            "selection_sets_default": False, "selection_starts_production": False}
