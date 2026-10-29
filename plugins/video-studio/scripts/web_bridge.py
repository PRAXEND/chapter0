#!/usr/bin/env python3
"""Structured local workbench adapter. No model, credential or ChatCut RPC client."""
import argparse
import hashlib
import json
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


def save_plan(payload):
    run = Path(payload["run"])
    studio.load_run(run)
    plan = payload["plan"]
    lines = [f"# {plan['title']}", "", plan.get("summary", ""), "", "## 文案", "", plan["script"], "", "## 分镜（预计时间）", ""]
    for shot in plan["shots"]:
        lines += [f"### {shot['id']} · {shot['from']}–{shot['to']} 秒", "",
                  f"素材：{', '.join(shot['sourceIds'])}", f"旁白：{shot['narration']}",
                  f"画面：{shot['visual']}", f"屏幕文字：{shot['screenText']}", f"剪辑：{shot['transition']}", ""]
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
    result = {"version": version, "file": str(file), "file_sha256": plan_hash,
              "input_hash": payload["inputHash"], "status": "awaiting_confirmation"}
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


def check_approval(payload):
    result = read(Path(payload["run"]) / "script-storyboard-approval.json")
    if result.get("status") != "confirmed" or result["file_sha256"] != payload["planHash"] or result["input_hash"] != payload["inputHash"]:
        raise ValueError("当前方案尚未确认，或已被修改。")
    if digest(Path(result["file"]).read_bytes()) != result["file_sha256"]:
        raise ValueError("方案文件校验失败，请重新审阅。")
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
    audio = any(s.get("codec_type") == "audio" for s in streams)
    if not video and not audio:
        raise ValueError("文件没有有效的视频或音频流。")
    try:
        seconds = float(info.get("format", {}).get("duration", video.get("duration", 0) if video else 0))
    except (TypeError, ValueError):
        seconds = 0
    try:
        fps = float(Fraction(video.get("avg_frame_rate", "0/1"))) if video else 0
    except (ValueError, ZeroDivisionError):
        fps = 0
    return {"path": str(file), "bytes": file.stat().st_size, "sha256": file_digest(file), "fps": fps,
            "duration": seconds, "width": video.get("width", 0) if video else 0,
            "height": video.get("height", 0) if video else 0, "hasVideo": bool(video), "hasAudio": audio}


def verify_video(payload):
    info = inspect_media(payload)
    if not info["hasVideo"] or info["duration"] <= 0:
        raise ValueError("没有可交付的视频流。")
    requirements = payload["requirements"]
    if info["width"] != requirements["width"] or info["height"] != requirements["height"]:
        raise ValueError("成片尺寸与本期要求不一致。")
    if requirements.get("fps") and abs(info["fps"] - requirements["fps"]) > 0.01:
        raise ValueError("成片帧率与本期要求不一致。")
    if requirements.get("audio_required") and not info["hasAudio"]:
        raise ValueError("本期要求声音，但成片没有音轨。")
    if requirements.get("max_seconds") and info["duration"] > requirements["max_seconds"]:
        raise ValueError("成片超过用户指定的时长上限。")
    if requirements.get("min_seconds") and info["duration"] < requirements["min_seconds"]:
        raise ValueError("成片短于用户指定的时长下限。")
    binary = studio.native_tool("ffmpeg")
    if not binary:
        raise ValueError("缺少 ffmpeg，请先检查本地环境。")
    process = subprocess.run([binary, "-v", "error", "-xerror", "-i", info["path"], "-f", "null", "-"], capture_output=True, text=True, timeout=300)
    if process.returncode:
        raise ValueError("成片未通过完整解码检查：" + process.stderr[-400:])
    return {**info, "decodeVerified": True, "perceptualReview": "requires_evidence"}


ACTIONS = {"catalog": catalog, "create": create, "sync": sync, "save-plan": save_plan,
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
