#!/usr/bin/env python3
"""Structured local workbench adapter. No model, credential or ChatCut RPC client."""
import argparse
import hashlib
import json
import math
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import datetime as dt
from fractions import Fraction

import studio
import styles
import web_styles

ROOT = Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(file):
    value = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def read(file):
    return json.loads(Path(file).read_text(encoding="utf-8"))


def write(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    data = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=file.parent, delete=False) as out:
        out.write(data)
        temporary = out.name
    os.replace(temporary, file)


def catalog(_):
    manifest = read(ROOT / "plugin.json")
    return {"name": manifest["name"], "version": manifest["version"], "styles": styles.choices(),
            "profile": studio.profile(), "plugin_root": str(ROOT), "styleBrowser": web_styles.catalog()}


def create(payload):
    return studio.new_run(payload["title"], payload["outputRoot"], payload["brief"])


def sync(payload):
    run = Path(payload["run"])
    current = studio.load_run(run)
    brief = payload["brief"]
    if current.get("brief") != brief:
        studio.record(run, "brief", brief)
    selection = {"topic": brief["topic"], "confirmed_by_user": True}
    if studio.load_run(run).get("selection") != selection:
        studio.record(run, "selection", selection)
    for source in payload.get("sources", []):
        current_source = next((s for s in studio.load_run(run)["sources"] if s["id"] == source["id"]), None)
        if current_source is None or any(current_source.get(k) != v for k, v in source.items()):
            studio.record(run, "source", {**(current_source or {}), **source})
    return {"run": str(run), "revision": studio.load_run(run)["revision"]}


def prepare_collection(payload):
    """Record the clicked acquisition need without claiming a new editorial search."""
    run = Path(payload["run"])
    data = studio.load_run(run)
    brief = data["brief"]
    plan = data.get("material_plan")
    if plan and plan.get("topic") == brief["topic"] and plan.get("style") == brief.get("style") and plan.get("needs"):
        return plan
    source = payload["source"]
    plan = {"topic": brief["topic"], "style": brief.get("style"), "scope": "user_clicked_acquisition",
            "needs": [{"id": "workbench-selection", "purpose": "获取用户点击的原始媒体，供后续按所选风格审阅",
                       "query": brief["topic"] + " / " + source["title"],
                       "acceptance": "固定版本 ready 清单、元数据、LFS 指针、文件哈希和规格一致；画面与事实未审阅"}]}
    studio.record(run, "material_plan", plan)
    return plan


def save_plan(payload):
    run = Path(payload["run"])
    data = studio.load_run(run)
    plan = payload["plan"]
    studio.style_plan.validate(plan, data)
    lines = [f"# {plan['title']}", "", plan.get("summary", ""), "", "## 文案", "", plan["script"], "", "## 分镜（预计时间）", ""]
    for shot in plan["shots"]:
        lines += [f"### {shot['id']} · {shot['from']}–{shot['to']} 秒", "",
                  f"素材：{', '.join(shot['sourceIds'])}", f"旁白：{shot['narration']}",
                  f"画面：{shot['visual']}", f"屏幕文字：{shot['screenText']}", f"剪辑：{shot['transition']}", ""]
        for design in shot.get("design", []):
            lines += [f"#### 画面设计 {design['id']} · {', '.join(design['ruleIds'])}",
                      f"用途：{design['purpose']}", f"触发：{design['trigger']}",
                      f"进入 / 变化 / 退出：{design['phases']}", f"预计持续：{design['durationSeconds']} 秒",
                      f"位置与动作保护：{design['placement']}", f"声音落点：{design['sound']}",
                      f"实现与素材前提：{design['implementation']}", f"替代处理：{design['fallback']}", ""]
    mapping = plan.get("stylePlan")
    if mapping:
        lines += ["## 风格落实与参考对照", f"风格：{mapping['selector']}", mapping["contrastReview"], ""]
        for row in mapping["rules"]:
            lines += [f"- {row['ruleId']} · {row['disposition']} · 镜头 {', '.join(row['shotIds'])}：{row['treatment']}"]
        for ref in mapping["referenceChecks"]:
            lines += [f"- 参考 {ref['referenceId']} @ {ref['location']}：{ref['observation']}；本期适配：{ref['adaptation']}"]
        lines += [""]
    lines += ["## 待补素材 / 事实缺口", "", *[f"- {item}" for item in plan.get("gaps", [])], "",
              "## 制作说明", "", *[f"- {item}" for item in plan.get("notes", [])], ""]
    if plan.get("limitations"):
        lines += ["## 已知限制与处理（制作时必须保留）", "", *[f"- {item}" for item in plan["limitations"]], ""]
    text = "\n".join(lines)
    plan_hash = digest(text.encode("utf-8"))
    approval_file = run / "script-storyboard-approval.json"
    previous = read(approval_file) if approval_file.is_file() else {}
    if previous.get("file_sha256") == plan_hash and previous.get("input_hash") == payload["inputHash"]:
        return previous
    version = previous.get("version", 0) + 1
    file = run / f"script-storyboard-v{version}.md"
    write(file, text)
    write(run / "workbench-plan.json", plan)
    style_hash = None
    if mapping or any(s.get("design") for s in plan["shots"]):
        style_hash = studio.record(run, "style_plan", plan)["style_plan"]["sha256"]
    result = {"version": version, "file": str(file), "file_sha256": plan_hash,
              "input_hash": payload["inputHash"], "status": "awaiting_confirmation",
              "plan_data_sha256": studio.digest(plan), "style_plan_sha256": style_hash}
    write(approval_file, result)
    return result


def approve(payload):
    run = Path(payload["run"])
    file = run / "script-storyboard-approval.json"
    current = read(file)
    if current["file_sha256"] != payload["planHash"] or current["input_hash"] != payload["inputHash"]:
        raise ValueError("方案已发生变化，请重新审阅。")
    if digest(Path(current["file"]).read_bytes()) != current["file_sha256"]:
        raise ValueError("方案文件已发生变化，请重新审阅。")
    check_plan_data(run, current)
    authority = payload.get("authority", {"kind": "user_click"})
    if authority.get("kind") == "delegated_review":
        request = authority.get("userRequest")
        if authority.get("authorizedByUser") is not True or not isinstance(request, str) or not request.strip() or len(request) > 6000:
            raise ValueError("委托审阅缺少用户原始授权。")
        response = "Agent 按用户明确委托完成本次方案审阅。原始要求：" + request.strip()
    elif authority.get("kind") == "user_click":
        response = "用户在 Video Studio 网页点击确认当前文案与分镜"
    elif authority.get("kind") == "user_message":
        request = authority.get("userRequest")
        prior = authority.get("priorReviewedPlanHash")
        if not isinstance(request, str) or not request.strip() or len(request) > 6000 or (prior is not None and not re.fullmatch(r"[a-f0-9]{64}", str(prior))):
            raise ValueError("对话确认缺少用户原话或有效的方案依据。")
        response = "依据用户在对话中表达的方案确认保存记录。用户原话：" + request.strip()
    else:
        raise ValueError("不支持的方案确认来源。")
    current.update(status="confirmed", confirmed_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                   authority=authority, user_response=response)
    write(file, current)
    return current


def check_plan_data(run, approval):
    if not approval.get("plan_data_sha256"):
        return  # Previously approved plans retain their original recovery path.
    plan = read(Path(run) / "workbench-plan.json")
    data = studio.load_run(run)
    if studio.digest(plan) != approval["plan_data_sha256"]:
        raise ValueError("结构化方案已变化，请重新保存并审阅。")
    studio.style_plan.validate(plan, data)
    expected = approval.get("style_plan_sha256")
    if expected and (data.get("style_plan", {}).get("sha256") != expected or
                     studio.digest(data["style_plan"]["plan"]) != expected):
        raise ValueError("风格设计已变化，请重新保存并审阅。")


def check_approval(payload):
    result = read(Path(payload["run"]) / "script-storyboard-approval.json")
    if result.get("status") != "confirmed" or result["file_sha256"] != payload["planHash"] or result["input_hash"] != payload["inputHash"]:
        raise ValueError("当前方案尚未确认，或已被修改。")
    if digest(Path(result["file"]).read_bytes()) != result["file_sha256"]:
        raise ValueError("方案文件校验失败，请重新审阅。")
    check_plan_data(payload["run"], result)
    return result


def inspect_media(payload):
    try:
        file = Path(payload["file"]).resolve(strict=True)
    except FileNotFoundError as error:
        raise ValueError("媒体文件不存在。") from error
    binary = studio.native_tool("ffprobe")
    if not binary:
        raise ValueError("缺少 ffprobe，请先检查本地环境。")
    process = subprocess.run([binary, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(file)], capture_output=True, text=True, timeout=30)
    if process.returncode:
        raise ValueError("媒体无法读取：" + process.stderr[-400:])
    info = json.loads(process.stdout)
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
    audio = next((s for s in audio_streams if s.get("disposition", {}).get("default")),
                 audio_streams[0] if audio_streams else None)
    if not video and not audio:
        raise ValueError("文件没有有效的视频或音频流。")
    try:
        seconds = float(video.get("duration", info.get("format", {}).get("duration", 0))
                        if video else info.get("format", {}).get("duration", 0))
    except (TypeError, ValueError):
        seconds = 0
    try:
        fps = float(Fraction(video.get("avg_frame_rate", "0/1"))) if video else 0
    except (ValueError, ZeroDivisionError):
        fps = 0
    return {"path": str(file), "bytes": file.stat().st_size, "sha256": file_digest(file), "fps": fps,
            "duration": seconds, "width": video.get("width", 0) if video else 0,
            "height": video.get("height", 0) if video else 0, "hasVideo": bool(video), "hasAudio": audio is not None,
            "audioStreamIndex": audio.get("index") if audio is not None else None}


def verify_video(payload):
    info = inspect_media(payload)
    if not info["hasVideo"] or not math.isfinite(info["duration"]) or info["duration"] <= 0:
        raise ValueError("没有可交付的视频流。")
    requirements = payload["requirements"]
    if info["width"] != requirements["width"] or info["height"] != requirements["height"]:
        raise ValueError("成片尺寸与本期要求不一致。")
    if requirements.get("fps") and abs(info["fps"] - requirements["fps"]) > 0.01:
        raise ValueError("成片帧率与本期要求不一致。")
    if requirements.get("audio_required") and not info["hasAudio"]:
        raise ValueError("本期要求声音，但成片没有音轨。")
    if requirements.get("max_seconds") and info["duration"] > requirements["max_seconds"] + 0.1:
        raise ValueError("成片超过用户指定的时长上限。")
    if requirements.get("min_seconds") and info["duration"] < requirements["min_seconds"]:
        raise ValueError("成片短于用户指定的时长下限。")
    binary = studio.native_tool("ffmpeg")
    if not binary:
        raise ValueError("缺少 ffmpeg，请先检查本地环境。")
    # Inspect the default playback track in the same decode pass. A silent AAC track
    # is still an audio stream; stream presence alone cannot establish audible sound.
    measure_audio = requirements.get("audio_required", False)
    command = [binary, "-hide_banner", "-nostats", "-v", "info" if measure_audio else "error",
               "-xerror", "-i", info["path"], "-map", "0:v:0"]
    if info["hasAudio"]:
        command += ["-map", f"0:{info['audioStreamIndex']}"]
    if measure_audio:
        command += ["-af", "volumedetect"]
    process = subprocess.run(command + ["-f", "null", "-"], capture_output=True, text=True, timeout=300)
    if process.returncode:
        raise ValueError("成片未通过完整解码检查：" + process.stderr[-400:])
    if measure_audio:
        peak = re.search(r"max_volume:\s*(-?\d+(?:\.\d+)?|-inf) dB", process.stderr)
        if not peak or float(peak[1]) <= -60:
            raise ValueError("成片音轨为静音或音量极低（峰值不高于 -60 dBFS），请检查配音是否加入时间线、轨道静音和导出混音。")
        info["audioPeakDbfs"] = float(peak[1])
    return {**info, "decodeVerified": True, "audibleAudioVerified": bool(measure_audio),
            "perceptualReview": "requires_evidence"}


ACTIONS = {"catalog": catalog, "create": create, "sync": sync, "save-plan": save_plan,
           "preflight": lambda p: studio.preflight(p.get("capabilities")),
           "bootstrap": lambda p: studio.bootstrap(),
           "prepare-collection": prepare_collection,
           "style-details": lambda p: web_styles.details(p["key"]),
           "style-reference": lambda p: web_styles.reference(p["key"], p["referenceId"]),
           "style-select": lambda p: web_styles.select(p["key"]),
           "approve": approve, "check-approval": check_approval, "inspect-media": inspect_media, "verify-video": verify_video}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=ACTIONS)
    parser.add_argument("--file")
    args = parser.parse_args()
    try:
        value = ACTIONS[args.action](read(args.file) if args.file else {})
        print(json.dumps(value, ensure_ascii=False, allow_nan=False))
        return 0
    except (ValueError, OSError, KeyError, studio.StudioError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
