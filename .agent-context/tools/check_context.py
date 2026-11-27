#!/usr/bin/env python3
"""Read-only repository context checks. Python 3.11+, standard library only."""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

VERSION = "1.0.0"
STATUSES = {"planned", "in_progress", "blocked", "implemented", "merged", "released", "accepted"}
ACTIVE = {"planned", "in_progress", "blocked", "implemented"}
COMPLETE = {"implemented", "merged", "released", "accepted"}


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if result.returncode:
        raise ValueError(result.stderr.strip() or "Git 命令失败")
    return result.stdout


def matches(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def managed_untracked(path: str, patterns: list[str]) -> bool:
    """Bare managed patterns are root-only, so local sibling projects stay out."""
    return any(("/" in pattern or "/" not in path) and fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def local_path(root: Path, value: str) -> Path:
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"路径超出仓库：{value}")
    return path


def present(value: object) -> bool:
    if isinstance(value, str):
        return bool(value.strip()) and not re.search(r"<[^>]+>|\bTODO\b|待填写", value, re.I)
    return isinstance(value, list) and bool(value) and all(present(item) for item in value)


def timestamp(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("时间必须含时区")
    return parsed


class Checker:
    def __init__(self, root: Path, base: str, tasks: list[str], reason: str, evidence: str, today: dt.date, format_only: bool = False, config_path: str = ".context-check.json"):
        self.root = root.resolve()
        self.base = base
        self.task_ids = tasks
        self.reason = reason
        self.evidence = evidence
        self.today = today
        self.format_only = format_only
        self.config_path = config_path
        self.issues: list[dict[str, str]] = []
        self.changed: set[str] = set()
        self.selected: dict[str, dict] = {}

    def issue(self, level: str, code: str, path: str, message: str):
        self.issues.append(dict(level=level, code=code, path=path, message=message))

    def error(self, code: str, path: str, message: str):
        self.issue("error", code, path, message)

    def warn(self, code: str, path: str, message: str):
        self.issue("warning", code, path, message)

    def read_task(self, path: str) -> dict | None:
        try:
            body = local_path(self.root, path).read_text(encoding="utf-8")
            block = re.search(r"<!-- task-metadata -->\s*```json\s*\n(.*?)\n```", body, re.S)
            if not block:
                raise ValueError("缺少 <!-- task-metadata --> 后的 JSON 块")
            data = json.loads(block[1])
            if not isinstance(data, dict):
                raise ValueError("任务元数据必须是 JSON 对象")
            return data
        except (OSError, ValueError) as exc:
            self.error("TASK_FORMAT", path, str(exc))
            return None

    def check_task(self, path: str, task: dict):
        for field in ("id", "owner", "branch", "goal", "non_goals", "acceptance", "updated", "modules"):
            if not present(task.get(field)):
                self.error("TASK_FIELD", path, f"补齐 {field}，不能保留模板占位符")
        for field in ("id", "owner", "branch", "goal", "non_goals", "updated"):
            if not isinstance(task.get(field), str):
                self.error("TASK_FIELD", path, f"{field} 必须是字符串")
        if task.get("id") != Path(path).stem:
            self.error("TASK_ID", path, "id 必须与任务文件名相同")
        for field in ("acceptance", "modules", "dependencies"):
            if not isinstance(task.get(field), list):
                self.error("TASK_FIELD", path, f"{field} 必须是数组；无依赖用 []")
        state = task.get("status")
        if not isinstance(state, str):
            self.error("TASK_STATE", path, "status 必须是字符串")
            state = None
        if state not in STATUSES:
            self.error("TASK_STATE", path, f"status 应为 {sorted(STATUSES)} 之一")
        try:
            updated = timestamp(task["updated"]).date()
            age = (self.today - updated).days
            if age < -1:
                self.error("TASK_DATE", path, "更新时间在未来，请核对")
            if state in ACTIVE and age > self.config.get("stale_days", 7):
                self.warn("STALE_TASK", path, f"活跃任务已有 {age} 天未更新，核对是否仍在进行")
        except (ValueError, KeyError, TypeError, AttributeError):
            self.error("TASK_DATE", path, "updated 必须是带时区的 ISO 8601 时间")
        handoff = task.get("handoff", {})
        for field in ("next", "blockers", "failed_attempts"):
            if not isinstance(handoff, dict) or not present(handoff.get(field)):
                self.error("HANDOFF", path, f"补齐 handoff.{field}；没有阻塞/失败也须明确写无")
        validation = task.get("validation", {})
        if not isinstance(validation, dict):
            validation = {}
        claim = validation.get("claim")
        records = validation.get("records", [])
        if claim not in {"unverified", "failed", "passed"} or not isinstance(records, list):
            self.error("VALIDATION", path, "validation 需要 claim 和 records 数组")
            return
        if state in COMPLETE and claim != "passed":
            self.error("FALSE_COMPLETION", path, "声称实现通过或后续阶段时必须提供通过的验证；未验证保持 in_progress/blocked")
        if claim == "passed" and not records:
            self.error("NO_EVIDENCE", path, "声称验证通过，但没有验证记录")
        if claim == "failed" and not any(isinstance(r, dict) and r.get("result") == "failed" for r in records):
            self.error("NO_EVIDENCE", path, "声称验证失败，需要保留失败记录")
        for record in records:
            if not isinstance(record, dict):
                self.error("VALIDATION", path, "每条验证记录必须为对象")
                continue
            for field in ("command", "environment", "result", "evidence", "at"):
                if not present(record.get(field)):
                    self.error("VALIDATION", path, f"验证记录缺少 {field}")
            if record.get("result") not in {"passed", "failed", "not_run"}:
                self.error("VALIDATION", path, "result 应为 passed/failed/not_run")
            if claim == "passed" and record.get("result") != "passed":
                self.error("FALSE_PASS", path, "通过声明包含失败/未运行记录；历史失败移入失败尝试，当前未验证项保留明确限制")
            try:
                timestamp(record["at"])
            except (KeyError, ValueError, TypeError, AttributeError):
                self.error("VALIDATION", path, "验证 at 必须含时区")
            evidence = record.get("evidence", "")
            if isinstance(evidence, str) and evidence:
                try:
                    if not urlsplit(evidence).scheme and not local_path(self.root, evidence.split("#")[0]).is_file():
                        self.error("EVIDENCE_PATH", path, f"验证证据文件不存在：{evidence}")
                except ValueError as exc:
                    self.error("EVIDENCE_PATH", path, str(exc))
        if not isinstance(task.get("doc_impact"), dict):
            self.error("DOC_IMPACT", path, "doc_impact 必须为对象，按配置规则 ID 说明文档影响")

    def check_links(self, paths: set[str]):
        # Deliberately limited to Markdown inline links and reference definitions.
        for name in sorted(paths):
            try:
                path = local_path(self.root, name)
            except ValueError as exc:
                self.error("LINK_ESCAPE", name, str(exc))
                continue
            if not path.is_file() or path.suffix != ".md":
                continue
            body = path.read_text(encoding="utf-8")
            body = re.sub(r"(?ms)^\s*(`{3,}|~{3,})[^\n]*\n.*?^\s*\1\s*$", "", body)
            body = re.sub(r"`[^`\n]+`", "", body)
            destinations = re.findall(r"!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)", body)
            destinations += re.findall(r"(?m)^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)", body)
            for target in destinations:
                target = target.strip("<>")
                parsed = urlsplit(target)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue
                relative = unquote(parsed.path)
                candidate = (self.root / relative.lstrip("/") if relative.startswith("/") else path.parent / relative).resolve()
                if not candidate.is_relative_to(self.root):
                    self.error("LINK_ESCAPE", name, f"内部链接超出仓库：{target}")
                elif not candidate.exists():
                    self.error("BROKEN_LINK", name, f"内部文件链接失效：{target}")

    def check_impact(self):
        for rule in self.config["impact_rules"]:
            touched = sorted(p for p in self.changed if matches(p, rule["patterns"]))
            if not touched:
                continue
            entries = [(p, t.get("doc_impact", {}).get(rule["id"])) for p, t in self.selected.items()
                       if isinstance(t.get("doc_impact"), dict)]
            entries = [(p, e) for p, e in entries if e is not None]
            if not entries:
                if self.reason and not rule.get("critical"):
                    continue
                emit = self.error if rule.get("critical") else self.warn
                emit("MISSING_IMPACT", touched[0], f"{rule['id']} 变化：在任务 doc_impact 中说明更新位置或不适用原因；候选资料 {rule['docs']}")
                continue
            for task_path, entry in entries:
                if not isinstance(entry, dict) or entry.get("action") not in {"updated", "none"} or not present(entry.get("reason")):
                    self.error("DOC_IMPACT", task_path, f"{rule['id']} 需要 action=updated/none 和具体 reason")
                    continue
                if entry["action"] == "updated":
                    paths = entry.get("paths", [])
                    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
                        self.error("DOC_IMPACT", task_path, f"{rule['id']} updated 需要 paths 数组")
                        continue
                    for name in paths:
                        try:
                            valid = name in self.changed and local_path(self.root, name).is_file() and name.endswith(".md")
                        except ValueError:
                            valid = False
                        if not valid:
                            self.error("IMPACT_NOT_CHANGED", task_path, f"声明更新的资料必须是本次差异中存在的 Markdown：{name}")
            if rule.get("critical"):
                self.warn("HUMAN_REVIEW", touched[0], f"关键范围 {rule['id']}：另一位成员需确认方案及合并；本检查器不能验证人的身份或批准")

    def run(self):
        self.config = json.loads(local_path(self.root, self.config_path).read_text(encoding="utf-8"))
        if self.config.get("version") != 1:
            raise ValueError(".context-check.json 的 version 必须是 1")
        for field in ("required", "managed_paths", "code_patterns", "impact_rules"):
            if not isinstance(self.config.get(field), list):
                raise ValueError(f"配置 {field} 必须为数组")
        base_sha = git(self.root, "rev-parse", "--verify", "--end-of-options", self.base + "^{commit}").strip()
        tracked = set(filter(None, git(self.root, "ls-files", "-z").split("\0")))
        untracked = {p for p in git(self.root, "ls-files", "--others", "--exclude-standard", "-z").split("\0")
                     if p and managed_untracked(p, self.config["managed_paths"])}
        self.changed = set(filter(None, git(self.root, "diff", "--name-only", "--no-renames", "-z", base_sha, "--").split("\0"))) | untracked
        inventory = tracked | untracked
        note_dir = self.config.get("change_note_dir", "docs/changes")
        notes = sorted(p for p in self.changed if p.startswith(note_dir + "/") and p.endswith(".md") and local_path(self.root, p).is_file())
        if not self.reason and len(notes) == 1:
            body = local_path(self.root, notes[0]).read_text(encoding="utf-8")
            block = re.search(r"<!-- change-note -->\s*```json\s*\n(.*?)\n```", body, re.S)
            if block:
                note = json.loads(block[1])
                self.reason = note.get("reason", "")
                self.evidence = note.get("validation", "")
                if not isinstance(note.get("format_only", False), bool):
                    raise ValueError("change-note format_only 必须为布尔值")
                self.format_only = note.get("format_only", False)
        for name in self.config["required"]:
            if not local_path(self.root, name).is_file():
                self.error("REQUIRED", name, "缺少必需资料，请从模板建立并填写真实信息")
        docs = {p for p in inventory if matches(p, self.config.get("link_paths", ["docs/**", "AGENTS.md", "CLAUDE.md", "README.md"]))}
        self.check_links(docs)
        task_dir = self.config.get("task_dir", "docs/tasks")
        all_tasks: dict[str, dict] = {}
        for path in sorted(inventory):
            if path.startswith(task_dir + "/") and path.endswith(".md") and Path(path).name != "README.md" and local_path(self.root, path).is_file():
                task = self.read_task(path)
                if task is not None:
                    all_tasks[path] = task
                    self.check_task(path, task)
        if self.task_ids:
            for task_id in self.task_ids:
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", task_id):
                    self.error("TASK_ID", task_dir, f"非法任务 ID：{task_id}")
                    continue
                path = f"{task_dir}/{task_id}.md"
                if path not in all_tasks:
                    self.error("TASK_MISSING", path, "找不到可解析的当前任务")
                else:
                    self.selected[path] = all_tasks[path]
        else:
            self.selected = {p: t for p, t in all_tasks.items() if p in self.changed}
        code = sorted(p for p in self.changed if matches(p, self.config["code_patterns"]))
        light = present(self.reason) and present(self.evidence)
        if code and not self.selected and not (self.format_only and light):
            self.error("TASK_REQUIRED", code[0], "代码/配置变更需要任务记录；用 --task ID 或随变更更新任务文件")
        elif self.changed and not self.selected and not light:
            self.error("LIGHT_CHANGE", "--exempt-reason / --exempt-validation", "纯文档/格式小改动可免建任务，但须提供简短影响说明和验证结果")
        if self.reason and code and not self.format_only:
            self.error("INVALID_EXEMPTION", code[0], "代码变更不能使用文案豁免；仅格式变更须显式 --format-only，并由审阅者核实")
        if self.format_only:
            if not light:
                self.error("LIGHT_CHANGE", "--format-only", "格式豁免仍需影响说明与验证结果")
            self.warn("FORMAT_DECLARATION", "--format-only", "格式变更是提交者声明，检查器不证明行为未变；关键路径仍需任务说明及同伴审阅")
        self.check_impact()
        active = [(p, t) for p, t in all_tasks.items() if t.get("status") in ACTIVE and isinstance(t.get("modules"), list)]
        for i, (left_path, left) in enumerate(active):
            for right_path, right in active[i + 1:]:
                shared = set(x for x in left["modules"] if isinstance(x, str)) & set(x for x in right["modules"] if isinstance(x, str))
                if shared:
                    self.warn("OVERLAP", left_path, f"与 {right_path} 同时涉及 {', '.join(sorted(shared))}；核对依赖/分工（不等于冲突）")
        return {"version": VERSION, "base": base_sha, "changed": sorted(self.changed), "tasks": sorted(self.selected),
                "issues": self.issues, "errors": sum(i["level"] == "error" for i in self.issues),
                "warnings": sum(i["level"] == "warning" for i in self.issues)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--config", default=".context-check.json", help="仓库根相对配置路径；跨项目初始化可隔离已有检查配置")
    parser.add_argument("--base", required=True, help="已存在的比较基准提交/引用；比较其与当前工作树")
    parser.add_argument("--task", action="append", default=[], help="可重复；省略时选择本次修改的任务记录")
    parser.add_argument("--exempt-reason", default="")
    parser.add_argument("--exempt-validation", default="")
    parser.add_argument("--format-only", action="store_true", help="声明仅格式变更；不豁免关键路径的任务/审阅要求")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        root = Path(git(args.repo, "rev-parse", "--show-toplevel").strip())
        report = Checker(root, args.base, args.task, args.exempt_reason, args.exempt_validation, dt.date.today(), args.format_only, args.config).run()
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        report = {"errors": 1, "warnings": 0, "issues": [dict(level="error", code="CONFIG", path=".context-check.json / --base", message=str(exc))]}
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for item in report["issues"]:
            print(f"{item['level'].upper()} [{item['code']}] {item['path']}: {item['message']}")
        print(f"context-check: {report['errors']} error(s), {report['warnings']} warning(s). 只检查资料结构，不证明业务验收。")
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
