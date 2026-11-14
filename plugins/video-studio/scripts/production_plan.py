"""Shared material continuity and portrait layout rules, independent of style."""
import math
from pathlib import Path


def text(value):
    return isinstance(value, str) and bool(value.strip())


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def same(left, right):
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(same(left[k], right[k]) for k in left)
    if numeric(left) and numeric(right):
        return left == right
    return type(left) is type(right) and left == right


def layout(settings):
    width, height = settings.get("width"), settings.get("height")
    portrait = numeric(width) and numeric(height) and 0 < width < height
    if not portrait:
        return {"mode": "unchanged"}
    return {"mode": "portrait-centered", "version": 2, "background": "#000000",
            "titleBox": dict(left=.05, top=.04, right=.95, bottom=.28),
            "mediaBox": dict(left=0, top=.32, right=1, bottom=.68),
            "captionBox": dict(left=.05, top=.72, right=.95, bottom=.88),
            "fit": "contain", "captionStyle": {
                "fontFamily": "sans-serif", "fontSize": width * .05,
                "fontWeight": 600, "lineHeight": 1.25, "color": "#FFFFFF",
                "align": "center", "verticalAlign": "top"}}


def box(value):
    return (isinstance(value, dict) and set(value) == {"left", "top", "right", "bottom"}
            and all(numeric(v) for v in value.values())
            and 0 <= value["left"] < value["right"] <= 1
            and 0 <= value["top"] < value["bottom"] <= 1)


def inside(inner, outer, tolerance_x=0, tolerance_y=0):
    return (box(inner) and box(outer) and inner["left"] >= outer["left"] - tolerance_x
            and inner["top"] >= outer["top"] - tolerance_y
            and inner["right"] <= outer["right"] + tolerance_x
            and inner["bottom"] <= outer["bottom"] + tolerance_y)


def validate_placement(placement, settings, cover_title=None, measured=False):
    if not isinstance(placement, dict) or not text(placement.get("composition")):
        raise ValueError("请记录镜头构图与动作保护方式。")
    expected = layout(settings)
    if expected["mode"] == "unchanged":
        return
    # Actual timeline pixels may round by one pixel; plans use exact normalized boxes.
    tolerance_x = 1 / settings["width"] + 1e-9 if measured else 1e-9
    tolerance_y = 1 / settings["height"] + 1e-9 if measured else 1e-9
    for key in ("titleBox", "mediaBox", "captionBox"):
        actual = placement.get(key)
        if key == "captionBox" and not settings.get("captions"):
            if actual is not None:
                raise ValueError("关闭字幕时 captionBox 应为 null。")
            continue
        if not box(actual) or any(abs(actual[k] - expected[key][k]) > (tolerance_x if k in {"left", "right"} else tolerance_y) for k in actual):
            raise ValueError("素材区必须居中，字幕区必须固定在素材下方；全片使用相同布局。")
    if placement.get("fit") != "contain":
        raise ValueError("素材须等比完整适配。")
    title = placement.get("titleText")
    lines = title.replace("\r\n", "\n").split("\n") if isinstance(title, str) else []
    if (not text(cover_title) or "\n" in cover_title or "\r" in cover_title
            or not 1 <= len(lines) <= 2 or any(not text(line) or "\r" in line for line in lines)
            or "".join(lines).strip() != cover_title.strip()):
        raise ValueError("顶部标题须由 Agent 生成，与 productionPlan.coverTitle 完全一致；仅允许一至两行换行。")
    if not same(placement.get("captionStyle"), expected["captionStyle"] if settings.get("captions") else None):
        raise ValueError("普通字幕的字体、字号、白色、对齐和位置必须统一。")
    emphasis = placement.get("emphasisBoxes")
    if not isinstance(emphasis, list):
        raise ValueError("请记录花字动画包围盒；没有花字时使用空列表。")
    for item in emphasis:
        # footageBounds excludes contain padding, so text cannot occupy black bars.
        if (not isinstance(item, dict) or not inside(item.get("footageBounds"), expected["mediaBox"], tolerance_x, tolerance_y)
                or not inside(item.get("bounds"), item.get("footageBounds"), tolerance_x, tolerance_y)):
            raise ValueError("花字完整动画必须位于对应的实际素材画面内，不能进入黑底留白区。")


def source_identity(source):
    return {"sha256": source.get("sha256"), "kind": source.get("kind"),
            "url": source.get("url"), "path": source.get("local_path") or source.get("localPath"),
            "start": source.get("source_start_seconds", source.get("start", 0)) or 0,
            "duration": source.get("duration")}


def validate_uses(uses, sources, replay_authorization=None):
    ids, prior = set(), []
    for use in uses:
        if not isinstance(use, dict) or not text(use.get("id")) or use["id"] in ids:
            raise ValueError("素材使用编号需要全片唯一。")
        ids.add(use["id"])
        source = sources.get(use.get("sourceId"))
        if not source or source.get("kind") not in {"video", "image"}:
            raise ValueError("画面片段必须引用实际视频或图片。")
        if use.get("role") not in {"primary", "supplemental"} or any(
                not text(use.get(k)) for k in ("purpose", "compatibility")):
            raise ValueError("请记录素材用途、主内容/补充角色及与旁白的相容性。")
        if source["kind"] == "image":
            if use.get("inSeconds") is not None or use.get("outSeconds") is not None:
                raise ValueError("静态图片不填写视频源区间。")
            continue
        first, last, duration = use.get("inSeconds"), use.get("outSeconds"), source.get("duration")
        if not all(numeric(v) for v in (first, last, duration)) or not 0 <= first < last <= duration + .001:
            raise ValueError("视频片段必须位于已探测的本地素材时长内。")
        if not text(use.get("actionGroup")):
            raise ValueError("视频片段需要动作组，以识别原片回放与跨来源重复。")
        offset = source.get("source_start_seconds", source.get("start", 0)) or 0
        if not numeric(offset) or offset < 0:
            raise ValueError("原片偏移需要有效的非负秒数。")
        for old, other in prior:
            same_bytes = bool(source.get("sha256") and source.get("sha256") == other.get("sha256"))
            same_url = bool(source.get("url") and source.get("url") == other.get("url"))
            same_file = (source.get("local_path") or source.get("localPath")) == (other.get("local_path") or other.get("localPath")) and bool(source.get("local_path") or source.get("localPath"))
            same = use["sourceId"] == old["sourceId"] or same_bytes or same_file
            a, b = first, last
            c, d = old["inSeconds"], old["outSeconds"]
            if not same and same_url:
                a, b = a + offset, b + offset
                shift = other.get("source_start_seconds", other.get("start", 0)) or 0
                c, d = c + shift, d + shift
            overlaps = (same or same_url) and min(b, d) - max(a, c) > .001
            if (overlaps or use["actionGroup"] == old["actionGroup"]) and not text(replay_authorization):
                raise ValueError("重复动作或重叠源片段；请更换素材，明确要求回放时才可例外。")
        prior.append((use, source))


def validate(plan, data, required=True):
    if not isinstance(plan, dict):
        raise ValueError("制作方案必须是对象。")
    settings = data["settings"]
    minimum = settings.get("min_seconds")
    if minimum is not None:
        shots = plan.get("shots")
        end = shots[-1].get("to") if isinstance(shots, list) and shots and isinstance(shots[-1], dict) else None
        if not numeric(end) or end + .02 < minimum:
            raise ValueError("预计分镜时长短于本期下限；请补充有效内容和画面，不得靠重复或静帧凑时长。")
    policy = plan.get("productionPlan")
    if policy is None and not required:
        return plan
    expected = layout(settings)
    saved_layout = policy.get("layout") if isinstance(policy, dict) else None
    compatible_landscape = expected == {"mode": "unchanged"} and saved_layout == {"mode": "unchanged", "bottomInset": 0}
    if not isinstance(policy, dict) or type(policy.get("version")) is not int or policy.get("version") != 1 or (not same(saved_layout, expected) and not compatible_landscape) or not text(policy.get("materialReview")):
        raise ValueError("请补充通用素材检查和与实际画幅一致的布局方案。")
    sources = {s["id"]: s for s in data.get("sources", [])}
    all_uses, shots = [], set()
    if not isinstance(plan.get("shots"), list):
        raise ValueError("制作方案需要分镜列表。")
    for shot in plan["shots"]:
        if not isinstance(shot, dict):
            raise ValueError("分镜必须是对象。")
        if not text(shot.get("id")) or shot["id"] in shots:
            raise ValueError("分镜编号无效或重复。")
        shots.add(shot["id"])
        uses = shot.get("sourceUses")
        if not isinstance(uses, list):
            raise ValueError("请为每镜记录 sourceUses，纯图形镜头可为空。")
        refs = shot.get("sourceIds", [])
        if not isinstance(refs, list) or any(not text(sid) or sid not in sources for sid in refs):
            raise ValueError("分镜引用了不存在的素材。")
        if any(not isinstance(u, dict) or u.get("sourceId") not in refs for u in uses):
            raise ValueError("片段使用必须对应本镜已选素材。")
        visuals = {sid for sid in refs if sources.get(sid, {}).get("kind") in {"video", "image"}}
        if visuals != {u.get("sourceId") for u in uses}:
            raise ValueError("每个画面来源都需要具体使用记录。")
        all_uses.extend(uses)
        validate_placement(shot.get("layout"), settings, policy.get("coverTitle"))
    if not shots:
        raise ValueError("通用制作方案需要实际镜头。")
    validate_uses(all_uses, sources, settings.get("replay_authorization"))
    return plan


def title_review_errors(data, review):
    policy = (data.get("production_plan") or {}).get("plan", {}).get("productionPlan", {})
    if policy.get("layout", {}).get("mode") != "portrait-centered" or policy["layout"].get("version") != 2:
        return []
    rows = review.get("title_observations", [])
    roles = {"video", "cover_portrait", "cover_landscape"}
    if (not isinstance(rows, list) or len(rows) != 3
            or any(not isinstance(row, dict) for row in rows)
            or {row.get("role") for row in rows} != roles
            or len({row.get("path") for row in rows}) != 3):
        return ["title_observations_missing"]
    expected = policy.get("coverTitle")
    if not text(expected):
        return ["cover_title_missing"]
    for row in rows:
        value = row.get("text")
        if row["role"] == "video":
            lines = value.replace("\r\n", "\n").split("\n") if isinstance(value, str) else []
            if not 1 <= len(lines) <= 2 or any(not text(line) or "\r" in line for line in lines):
                return ["top_title_line_count_invalid"]
        else:
            try:
                with Path(row["path"]).open("rb") as stream:
                    header = stream.read(24)
                width, height = int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")
                n, d = (3, 4) if row["role"] == "cover_portrait" else (4, 3)
                if header[:8] != b"\x89PNG\r\n\x1a\n" or not width or not height or width*d != height*n:
                    return ["title_cover_image_invalid"]
            except (OSError, TypeError, KeyError):
                return ["title_cover_image_missing"]
        if (not text(value) or value.replace("\r\n", "").replace("\n", "").strip() != expected.strip()
                or not any(ref.get("path") == row.get("path") and ref.get("sha256") == row.get("sha256")
                           for ref in review.get("evidence_files", []))
                or (row["role"] == "video" and row.get("sha256") != review.get("artifact_sha256"))):
            return ["title_text_or_evidence_mismatch"]
    return []


def implementation_errors(data, directory, frames):
    from studio import digest, file_proof
    stored = data.get("production_plan")
    if not stored:
        return ["production_plan_missing"] if data.get("production_policy_version") == 1 else []
    plan = stored["plan"]
    if stored.get("sha256") != digest(plan):
        return ["production_plan_changed"]
    validate(plan, data)
    sources = {s["id"]: s for s in data["sources"]}
    used = {u["sourceId"] for s in plan["shots"] for u in s["sourceUses"]}
    if set(stored.get("source_hashes", {})) != used or set(stored.get("source_signatures", {})) != used:
        return ["production_source_binding_missing"]
    for sid in used:
        source = sources[sid]
        sha = stored["source_hashes"][sid]
        if not text(sha) or source.get("sha256") != sha or digest(source_identity(source)) != stored["source_signatures"][sid]:
            return ["production_source_changed"]
        if not file_proof({"path": source_identity(source)["path"], "sha256": sha}, directory):
            return ["production_source_file_changed"]
    expected = {u["id"]: (s["id"], u) for s in plan["shots"] for u in s["sourceUses"]}
    shots = {s["id"]: s for s in plan["shots"]}
    seen, covered, actual, errors = set(), set(), [], []
    portrait = layout(data["settings"])["mode"] == "portrait-centered"
    def proof(row):
        return (isinstance(row.get("item_ids"), list) and bool(row["item_ids"]) and all(text(i) for i in row["item_ids"])
                and text(row.get("observations")) and isinstance(row.get("evidence_files"), list) and bool(row["evidence_files"])
                and all(file_proof(e, directory) for e in row["evidence_files"]))
    for beat in data["beats"]:
        sid = beat.get("shot_id")
        if sid not in shots:
            errors.append(f"{beat['id']}:missing_production_shot")
            continue
        covered.add(sid)
        rows = beat.get("source_uses", [])
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            errors.append(f"{beat['id']}:invalid_source_uses")
            continue
        for row in rows:
            uid = row.get("id")
            if uid not in expected or expected[uid][0] != sid or uid in seen:
                errors.append(f"{beat['id']}:unknown_or_duplicate_source_use")
                continue
            seen.add(uid)
            planned = expected[uid][1]
            if row.get("sourceId") not in beat.get("source_ids", []):
                errors.append(f"{uid}:source_not_in_beat")
            if any(row.get(k) != planned.get(k) for k in ("sourceId", "actionGroup", "role")):
                errors.append(f"{uid}:source_use_changed")
            if sources.get(row.get("sourceId"), {}).get("kind") == "video":
                a, b = row.get("inSeconds"), row.get("outSeconds")
                if not numeric(a) or not numeric(b) or a < planned["inSeconds"] or b > planned["outSeconds"]:
                    errors.append(f"{uid}:source_use_outside_plan")
            first, last = row.get("from_frame"), row.get("to_frame")
            if not (type(first) is int and type(last) is int and
                    0 <= beat.get("from_frame", -1) <= first < last <= beat.get("to_frame", -1) <= frames + 1 and proof(row)):
                errors.append(f"{uid}:source_use_unverified")
            actual.append(row)
        if portrait:
            result = beat.get("layout_result") or {}
            try:
                validate_placement(result, data["settings"], plan["productionPlan"].get("coverTitle"), measured=True)
                if not proof(result):
                    raise ValueError("Missing evidence")
            except (ValueError, KeyError, TypeError):
                errors.append(f"{beat['id']}:portrait_layout_unverified")
    try:
        validate_uses(actual, sources, data["settings"].get("replay_authorization"))
    except (ValueError, KeyError, TypeError) as exc:
        errors.append("material_continuity:" + str(exc))
    errors.extend(f"{sid}:production_shot_missing" for sid in sorted(set(shots) - covered))
    errors.extend(f"{uid}:source_use_missing" for uid in sorted(set(expected) - seen))
    return errors
