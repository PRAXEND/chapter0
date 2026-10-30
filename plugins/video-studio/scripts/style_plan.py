"""Style-to-shot planning and implementation checks; no aesthetic auto-scoring."""
import math
from pathlib import Path


def text(value):
    return isinstance(value, str) and bool(value.strip())


def snapshot_spec(data):
    from studio import read, file_hash
    import styles
    snapshot = data.get("style_snapshot")
    if not snapshot:
        return None
    folder = Path(snapshot["skill_path"]).parent
    if any(file_hash(folder / name) != sha for name, sha in snapshot["files"].items()):
        raise ValueError("风格快照发生变化，请恢复原快照。")
    return styles.validate(read(folder / "style.json"))


def validate(plan, data):
    """Validate a proposed plan against the pinned style, not the live library."""
    spec = snapshot_spec(data)
    selected = data["style_snapshot"]["selector"] if spec else None
    mapping = plan.get("stylePlan")
    shots = plan.get("shots", [])
    if not isinstance(shots, list) or not shots:
        raise ValueError("风格分镜需要实际镜头。")
    ids, designs = set(), {}
    rule_ids = {r["id"] for r in spec["rules"]} if spec else set()
    for shot in shots:
        sid = shot.get("id")
        if not text(sid) or sid in ids:
            raise ValueError("分镜编号无效或重复。")
        ids.add(sid)
        start, end = shot.get("from"), shot.get("to")
        if any(type(v) not in (int, float) or not math.isfinite(v) for v in (start, end)) or not 0 <= start < end:
            raise ValueError("分镜需要有效的预计时间。")
        effects = shot.get("design", [])
        if not isinstance(effects, list):
            raise ValueError("镜头设计必须为数组；无需动效时可为空。")
        for effect in effects:
            if not isinstance(effect, dict) or not text(effect.get("id")) or effect["id"] in designs:
                raise ValueError("动效设计需要全片唯一编号。")
            if any(not text(effect.get(k)) for k in ("purpose", "trigger", "phases", "placement", "sound", "implementation", "fallback")):
                raise ValueError("动效设计需写清用途、触发、进退场、避让、声音、实现与替代方案。")
            duration = effect.get("durationSeconds")
            if type(duration) not in (int, float) or not math.isfinite(duration) or not 0 < duration <= end - start + .02:
                raise ValueError("动效预计时长必须为正且位于对应镜头内。")
            refs = effect.get("ruleIds")
            if not isinstance(refs, list) or any(not isinstance(r, str) or r not in rule_ids for r in refs):
                raise ValueError("动效引用了未知风格规则。")
            if spec and not refs:
                raise ValueError("已选风格的动效设计需要关联实际规则。")
            designs[effect["id"]] = (sid, effect)
    if not spec:
        if mapping is not None:
            raise ValueError("未选择风格时 stylePlan 应为 null。")
        return plan
    if not isinstance(mapping, dict) or mapping.get("selector") != selected:
        raise ValueError("请先将所选风格落实到分镜，stylePlan 必须匹配本期快照。")
    decisions = mapping.get("rules")
    if not isinstance(decisions, list) or any(not isinstance(r, dict) or not isinstance(r.get("ruleId"), str) for r in decisions):
        raise ValueError("风格分镜需要逐条规则处理记录。")
    rows = {r["ruleId"]: r for r in decisions}
    if len(rows) != len(decisions) or set(rows) != rule_ids:
        raise ValueError("风格分镜必须覆盖全部规则，不能遗漏或引用其他版本。")
    contract = spec.get("storyboard_contract", {})
    conditional = {r["rule_id"] for r in contract.get("conditional_rules", [])}
    overrides = data["brief"].get("style_overrides", {})
    for rid, row in rows.items():
        refs = row.get("shotIds")
        if not text(row.get("treatment")) or not isinstance(refs, list) or any(not isinstance(s, str) or s not in ids for s in refs):
            raise ValueError("每条风格规则需要具体处理方式和有效镜头关联。")
        state = row.get("disposition")
        if rid in overrides:
            if state != "overridden":
                raise ValueError("用户已覆盖的规则必须按本期覆盖记录处理。")
        elif state == "not_applicable":
            if rid not in conditional or refs:
                raise ValueError("只有风格声明的条件手法可注明不适用，不能跳过核心规则。")
        elif state != "planned" or not refs:
            raise ValueError("适用规则必须落实到镜头；覆盖需有用户实际要求。")
    for sid, effect in designs.values():
        if any(rows[r]["disposition"] not in {"planned", "overridden"} or sid not in rows[r]["shotIds"] for r in effect["ruleIds"]):
            raise ValueError("动效必须关联本镜头实际计划执行的规则。")
    visual_rules = set(contract.get("visual_rule_ids", [])) | {
        r['id'] for r in spec['rules'] if r['id'] in conditional and r['dimension'] in {'graphics', 'transitions'}}
    for rid in visual_rules:
        if rows[rid]["disposition"] == "planned" and not any(rid in e["ruleIds"] for _, e in designs.values()):
            raise ValueError(f"核心视觉规则 {rid} 缺少可执行的镜头设计。")
    checks = mapping.get("referenceChecks")
    ref_ids = {r["id"] for r in spec["references"]}
    if not isinstance(checks, list) or not checks or any(not isinstance(c, dict) or
            c.get("referenceId") not in ref_ids or any(not text(c.get(k)) for k in ("location", "observation", "adaptation")) for c in checks):
        raise ValueError("请记录真实参考节点、实际可观察内容及本题适配；无法观看须如实说明。")
    if not text(mapping.get("contrastReview")):
        raise ValueError("请检查整片的表达变化、重复模板和核心风格覆盖。")
    return plan


def implementation_errors(data, directory, frames):
    """Check planned designs against actual beat records and hashed evidence."""
    from studio import digest, file_proof
    spec = snapshot_spec(data)
    stored = data.get("style_plan")
    if not stored:
        return ["style_plan_missing"] if spec and spec.get("storyboard_contract") else []
    plan = stored["plan"]
    if stored.get("sha256") != digest(plan):
        return ["style_plan_changed"]
    validate(plan, data)
    expected = {d["id"]: s["id"] for s in plan["shots"] for d in s.get("design", [])}
    shot_ids = {s["id"] for s in plan["shots"]}
    seen, covered, errors = set(), set(), []
    for beat in data["beats"]:
        sid = beat.get("shot_id")
        if sid not in shot_ids:
            errors.append(f"{beat['id']}:missing_planned_shot")
            continue
        covered.add(sid)
        for result in beat.get("design_results", []):
            did = result.get("design_id")
            if did in seen or expected.get(did) != sid:
                errors.append(f"{beat['id']}:unknown_or_duplicate_design")
                continue
            seen.add(did)
            first, last = result.get("from_frame"), result.get("to_frame")
            valid = (result.get("status") in {"implemented", "substituted"} and text(result.get("observations"))
                     and isinstance(result.get("item_ids"), list) and bool(result["item_ids"])
                     and all(text(i) for i in result["item_ids"])
                     and type(first) is int and type(last) is int
                     and 0 <= beat.get("from_frame", -1) <= first < last <= beat.get("to_frame", -1) <= frames + 1
                     and result.get("evidence_files") and all(file_proof(e, directory) for e in result["evidence_files"]))
            if result.get("status") == "substituted":
                valid = valid and text(result.get("substitution_reason"))
            if not valid:
                errors.append(f"{did}:style_design_unverified")
    errors.extend(f"{sid}:planned_shot_missing" for sid in sorted(shot_ids - covered))
    errors.extend(f"{did}:style_design_missing" for did in sorted(set(expected) - seen))
    return errors
