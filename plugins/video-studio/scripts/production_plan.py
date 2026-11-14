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
    scale, center = width / 1080, height / 2
    def region(left, top, right, bottom):
        return dict(left=left / width, top=top / height, right=right / width, bottom=bottom / height)
    return {"mode": "portrait-centered", "version": 3, "background": "#030405",
            "titleBox": region(54*scale, center-538*scale, 1026*scale, center-316*scale),
            "mediaBox": region(0, center-304*scale, width, center+304*scale),
            "captionBox": region(54*scale, center+321*scale, 1026*scale, center+456*scale),
            "titleStyle": {"fontFamily": "Noto Sans SC", "fontSize": 92*scale, "fontWeight": 900,
                           "lineHeight": 1.1, "lineGap": 4*scale, "color": "#FFFFFF", "emphasisColor": "#F0FF00"},
            "captionRenderer": {"mode": "line-count-box", "singleLineHeight": 68*scale,
                                "twoLineHeight": 135*scale, "nativeVerticalAlign": "center"},
            "backgroundMotion": {"recipe": "portrait-line-field-v1", "lineCount": 120, "groups": 6,
                                 "lineColor": "#9CA5AD", "strength": .12, "speed": 1,
                                 "overscan": 220*scale, "layer": "bottom"},
            "ending": {"fadeSeconds": 1.2, "blackHoldSeconds": .6, "musicFadeSeconds": 1.4,
                       "curve": "smoothstep", "scope": "all-visual-layers"},
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


def validate_placement(placement, settings, cover_title=None, measured=False, title_emphasis=None):
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
    if not same(placement.get("titleStyle"), expected["titleStyle"]):
        raise ValueError("顶部标题须使用统一白黄配色和已确认字号。")
    if (not text(title_emphasis) or title_emphasis != title_emphasis.strip()
            or not text(cover_title) or title_emphasis not in cover_title or title_emphasis == cover_title
            or placement.get("titleEmphasis") != title_emphasis):
        raise ValueError("请指定标题中的重点文字；白色正文与黄色重点均须存在，并与两张封面一致。")
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
        validate_placement(shot.get("layout"), settings, policy.get("coverTitle"), title_emphasis=policy.get("titleEmphasis"))
    if not shots:
        raise ValueError("通用制作方案需要实际镜头。")
    validate_uses(all_uses, sources, settings.get("replay_authorization"))
    return plan


def title_review_errors(data, review):
    policy = (data.get("production_plan") or {}).get("plan", {}).get("productionPlan", {})
    if policy.get("layout", {}).get("mode") != "portrait-centered" or policy["layout"].get("version") not in (2, 3):
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
        if policy["layout"].get("version") == 3 and row.get("emphasisText") != policy.get("titleEmphasis"):
            return ["title_emphasis_observation_missing_or_mismatched"]
    return []


def presentation_review_errors(data, review, frames):
    policy = (data.get('production_plan') or {}).get('plan', {}).get('productionPlan', {})
    if policy.get('layout', {}).get('version') != 3:
        return []
    required = {'portrait_layout': {'spacing', 'title_color', 'background'}, 'transitions': {'ending'}}.get(review['check'], set())
    rows = review.get('presentation_observations') or []
    if not isinstance(rows,list): rows=[]
    fps=data['settings']['fps'];black=frames-round(.6*fps);start=black-round(1.2*fps)
    errors = []
    for feature in sorted(required):
        matches = [r for r in rows if isinstance(r, dict) and r.get('feature') == feature]
        if len(matches) != 1:
            errors.append('portrait_' + feature + '_observations_missing');continue
        row = matches[0];points = row.get('frames')
        if (not text(row.get('observations')) or not isinstance(points, list) or not points
                or any(type(f) is not int or not 0 <= f < frames for f in points)
                or (feature in {'background', 'ending'} and len(set(points)) < 2)
                or (feature == 'ending' and (frames-1 not in points
                    or not any(start+.25*(black-start)<=f<=start+.75*(black-start) for f in points)
                    or not any(black<=f<frames-1 for f in points)))):
            errors.append('portrait_' + feature + '_frame_evidence_invalid')
    return errors


def track_ids(evidence, name, required=False):
    """Resolve full IDs or editor aliases; missing/muted selections fail closed."""
    selected=evidence.get(name,[])
    if not isinstance(selected,list) or any(not text(x) for x in selected) or (required and not selected):
        raise ValueError(name+' requires explicit audible tracks')
    tracks=evidence['timeline']['timeline']['tracks'];ids=set()
    for value in selected:
        matches=[t for t in tracks if value in (t.get('id'),t.get('alias'))]
        if len(matches)!=1 or matches[0].get('muted') is not False:
            raise ValueError(name+' selector missing, ambiguous or muted: '+value)
        ids.add(matches[0]['id'])
    return ids


def presentation_errors(data, evidence, frames, fps):
    """Verify actual placed layers before the independent pixel review.

    presentation contains normalized inspect_asset/readback facts; file hashes
    are bound by the regular probe. It never substitutes for frame inspection.
    """
    policy = (data.get('production_plan') or {}).get('plan', {}).get('productionPlan', {})
    if policy.get('layout', {}).get('version') != 3:
        return {}
    expected = layout(data['settings']);errors = {}
    if not isinstance(evidence,dict) or not isinstance(evidence.get('presentation'),dict):
        return {'portrait_layout':'Missing presentation readbacks','transitions':'Missing presentation readbacks'}
    entries = (evidence or {}).get('timeline', {}).get('timeline', {}).get('entries', [])
    tracks = (evidence or {}).get('timeline', {}).get('timeline', {}).get('tracks', [])
    if evidence.get('timeline',{}).get('timeline',{}).get('totalEntries') != len(entries):
        return {'portrait_layout':'Need complete timeline pages','transitions':'Need complete timeline pages'}
    items = {x.get('id'):x for x in entries if isinstance(x,dict) and x.get('kind') == 'item'}
    visual_order = {t['id']:t['order'] for t in tracks if t.get('type') in {'video','caption'} and numeric(t.get('order'))}
    records = (evidence or {}).get('presentation', {})
    w,h=data['settings']['width'],data['settings']['height']
    fade=round(1.2*fps);black=frames-round(.6*fps);start=black-fade
    def check(role,first,last,order,props):
        record=records.get(role) or {}
        if not isinstance(record,dict):return False
        item=items.get(record.get('item_id'), {})
        actual=item.get('properties', {});effective=record.get('effective_properties', {})
        if not isinstance(actual,dict) or not isinstance(effective,dict):return False
        return (item.get('itemType') == 'motion-graphic' and item.get('asset',{}).get('id') == record.get('asset_id')
                and item.get('timelineRange') == {'fromFrame':first,'toFrame':last}
                and visual_order and visual_order.get(item.get('trackId')) == order(visual_order.values())
                and all(numeric(actual.get(k)) and abs(actual[k]-v)<=1 for k,v in dict(left=0,top=0,width=w,height=h).items())
                and actual.get('opacity') == 1 and text(record.get('asset_revision'))
                and not any(t.get('muted') is not False for t in tracks if t.get('id')==item.get('trackId'))
                and actual.get('rotation',0)==0 and actual.get('fadeIn',0)==0 and actual.get('fadeOut',0)==0
                and isinstance(record.get('readback_files'),list) and bool(record['readback_files'])
                and all(same(effective.get(k),v) for k,v in props.items()))
    motion=expected['backgroundMotion']
    if not check('background',0,frames,min,{k:motion[k] for k in ('lineCount','strength','speed','lineColor')} | {'bgColor':expected['background'],'transparentBackground':False}):
        errors['portrait_layout']='缺少全片最底层密铺动态背景的真实实例、参数或读回证据'
    if not check('ending',start,frames,max,{'fadeFrames':fade,'color':'#000000'}):
        errors['transitions']='缺少末尾1.2秒全层渐隐与0.6秒黑屏的真实顶层实例及读回证据'
    from studio import music_expected
    try:
        music_tracks=track_ids(evidence,'music_tracks',required=music_expected(data))
        narration_tracks=track_ids(evidence,'narration_tracks',required=bool(data['settings'].get('narration')))
    except (ValueError,KeyError,TypeError) as exc:
        errors['transitions']=str(exc);return errors
    music=[x for x in entries if x.get('kind')=='item' and x.get('trackId') in music_tracks]
    if music:
        last=max(music,key=lambda x:x['timelineRange']['toFrame'])
        p=last.get('properties',{})
        duration=p.get('audioFadeOut',p.get('fadeOut',0))
        if last['timelineRange']['toFrame'] != black or not numeric(duration) or abs(duration-1.4)>1/fps:
            errors['transitions']='配乐须在黑屏开始前结束，并保留1.4秒淡出'
    elif music_tracks:
        errors['transitions']='已选择配乐轨但没有真实音乐片段'
    if any(x.get('kind')=='item' and x.get('trackId') in narration_tracks and x['timelineRange']['toFrame']>start for x in entries):
        errors['transitions']='请在全画面渐隐前完成旁白，预留完整收尾'
    return errors


def narration_occupancy(beat, evidence, fps):
    """Actual voice time inside a visual beat, including clips crossing its ends."""
    timeline=evidence['timeline']['timeline'];entries=timeline['entries']
    if timeline.get('totalEntries') != len(entries) or not evidence.get('narration_tracks'):
        raise ValueError('Complete narration timeline is required')
    start,end=beat['from_frame'],beat['to_frame'];tracks=track_ids(evidence,'narration_tracks',required=True)
    clips=[x for x in entries if x.get('kind')=='item' and x.get('trackId') in tracks
           and x['timelineRange']['fromFrame']<end and x['timelineRange']['toFrame']>start]
    if not clips or set(beat.get('narration_item_ids',[]))!={x['id'] for x in clips}:
        raise ValueError('Beat must bind all intersecting actual narration items')
    declared=set(beat.get('audio_asset_ids') or [beat.get('audio_asset_id')])
    intervals=[]
    for clip in clips:
        a,b=clip['timelineRange']['fromFrame'],clip['timelineRange']['toFrame']
        source=clip['sourceRange'];rate=clip.get('playbackRate',1)
        if (clip.get('asset',{}).get('id') not in declared or not numeric(rate) or rate<=0
                or abs((source['end']-source['start'])/1e6/rate-(b-a)/fps)>1/fps):
            raise ValueError('Narration source window/rate does not match its actual item')
        intervals.append((max(start,a),min(end,b)))
    total=0;right=start
    for a,b in sorted(intervals):
        total+=max(0,b-max(a,right));right=max(right,b)
    return total/fps


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
                validate_placement(result, data["settings"], plan["productionPlan"].get("coverTitle"), measured=True,
                                   title_emphasis=plan["productionPlan"].get("titleEmphasis"))
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
