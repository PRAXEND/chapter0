"""Behavioral regression tests using isolated real Git repositories."""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("context_checker", SOURCE / "tools/check_context.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.config = {
            "version": 1, "required": ["AGENTS.md", "docs/PROJECT.md", "docs/ARCHITECTURE.md", "docs/RUNBOOK.md"],
            "managed_paths": ["app/**", "docs/**", "AGENTS.md", ".context-check.json"],
            "link_paths": ["AGENTS.md", "docs/**"], "code_patterns": ["*.py", "*.json"],
            "task_dir": "docs/tasks", "stale_days": 7,
            "impact_rules": [
                {"id": "api", "patterns": ["app/api/**"], "docs": ["docs/ARCHITECTURE.md"], "critical": True},
                {"id": "code", "patterns": ["app/*.py"], "docs": ["docs/ARCHITECTURE.md"], "critical": False}
            ]
        }
        self.write(".context-check.json", json.dumps(self.config))
        for name in self.config["required"]:
            self.write(name, "# Context\n")
        self.write("app/service.py", "value = 1\n")
        self.write("app/api/entry.py", "value = 1\n")
        self.write(".gitignore", "ignored/\n")
        self.commit()
        self.base = self.git("rev-parse", "HEAD").strip()
        self.task = {
            "id": "T-1", "owner": "Alice", "branch": "feature/t-1", "goal": "Fix the existing flow",
            "non_goals": "No framework migration", "acceptance": ["Expected response is returned"],
            "status": "in_progress", "updated": "2026-11-12T01:00:00+08:00", "modules": ["api"], "dependencies": [],
            "handoff": {"next": "Run the integration case", "blockers": "None", "failed_attempts": "None"},
            "validation": {"claim": "unverified", "records": []},
            "doc_impact": {"api": {"action": "none", "reason": "Internal refactor with unchanged contract"},
                           "code": {"action": "none", "reason": "No public behavior change"}}
        }

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], text=True, stderr=subprocess.PIPE)

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def commit(self):
        self.git("add", ".")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture")

    def write_task(self, task=None):
        task = self.task if task is None else task
        self.write(f"docs/tasks/{task['id']}.md", "# Task\n<!-- task-metadata -->\n```json\n" + json.dumps(task) + "\n```\n")

    def run_check(self, ids=None, reason="", evidence="", base=None, format_only=False):
        return checker.Checker(self.root, base or self.base, ids or [], reason, evidence, dt.date(2026, 11, 12), format_only).run()

    def codes(self, report):
        return {i["code"] for i in report["issues"]}

    def test_clean_baseline(self):
        self.assertEqual(self.run_check()["errors"], 0)

    def test_valid_task_selected_automatically(self):
        self.write_task()
        self.write("app/service.py", "value = 2\n")
        report = self.run_check()
        self.assertEqual(report["errors"], 0, report)
        self.assertEqual(report["tasks"], ["docs/tasks/T-1.md"])

    def test_missing_required_document(self):
        (self.root / "docs/RUNBOOK.md").unlink()
        self.assertIn("REQUIRED", self.codes(self.run_check()))

    def test_missing_owner_and_handoff(self):
        self.task["owner"] = ""
        self.task["handoff"] = {}
        self.write_task()
        codes = self.codes(self.run_check())
        self.assertTrue({"TASK_FIELD", "HANDOFF"} <= codes)

    def test_placeholder_rejected(self):
        self.task["goal"] = "<填写真实目标>"
        self.write_task()
        self.assertIn("TASK_FIELD", self.codes(self.run_check()))

    def test_bad_json_task_reports_format(self):
        self.write("docs/tasks/T-1.md", '<!-- task-metadata -->\n```json\n{"id":}\n```')
        self.assertIn("TASK_FORMAT", self.codes(self.run_check()))

    def test_explicit_missing_task(self):
        self.assertIn("TASK_MISSING", self.codes(self.run_check(ids=["unknown"])))

    def test_task_path_traversal_rejected(self):
        self.assertIn("TASK_ID", self.codes(self.run_check(ids=["../../outside"])))

    def test_broken_inline_and_reference_links(self):
        self.write("docs/PROJECT.md", "[x](absent.md)\n[x]: another.md\n")
        report = self.run_check(reason="prose", evidence="reviewed")
        self.assertEqual(sum(i["code"] == "BROKEN_LINK" for i in report["issues"]), 2)

    def test_code_samples_external_urls_and_anchors_ignored(self):
        self.write("docs/PROJECT.md", '```md\n[x](missing.md)\n```\n[x](https://example.invalid/a)\n[x](#anchor)\n`[x](absent.md)`\n')
        self.assertEqual(self.run_check(reason="prose", evidence="reviewed")["errors"], 0)

    def test_unicode_spaces_link_and_root_relative(self):
        self.write("docs/中文 文件.md", "# exists\n")
        self.write("docs/PROJECT.md", "[x](<中文 文件.md>)\n[x](/docs/RUNBOOK.md#section)\n")
        self.assertEqual(self.run_check(reason="prose", evidence="reviewed")["errors"], 0)

    def test_link_escape_rejected(self):
        self.write("docs/PROJECT.md", "[x](../../outside.md)")
        self.assertIn("LINK_ESCAPE", self.codes(self.run_check(reason="prose", evidence="reviewed")))

    def test_pass_without_evidence_rejected(self):
        self.task["validation"]["claim"] = "passed"
        self.write_task()
        self.assertIn("NO_EVIDENCE", self.codes(self.run_check()))

    def validation_record(self, result="passed"):
        self.write("docs/evidence/test.md", "Actual command output\n")
        return {"command": "python3 test.py", "environment": "fixture", "result": result,
                "evidence": "docs/evidence/test.md", "at": "2026-11-12T01:00:00+08:00"}

    def test_pass_with_failed_or_not_run_record_rejected(self):
        for result in ("failed", "not_run"):
            with self.subTest(result=result):
                self.task["validation"] = {"claim": "passed", "records": [self.validation_record(result)]}
                self.write_task()
                self.assertIn("FALSE_PASS", self.codes(self.run_check()))

    def test_implemented_unverified_rejected(self):
        self.task["status"] = "implemented"
        self.write_task()
        self.assertIn("FALSE_COMPLETION", self.codes(self.run_check()))

    def test_implemented_with_evidence_passes(self):
        self.task["status"] = "implemented"
        self.task["validation"] = {"claim": "passed", "records": [self.validation_record()]}
        self.write_task()
        self.assertEqual(self.run_check()["errors"], 0)

    def test_evidence_file_missing(self):
        record = self.validation_record()
        (self.root / record["evidence"]).unlink()
        self.task["validation"] = {"claim": "passed", "records": [record]}
        self.write_task()
        self.assertIn("EVIDENCE_PATH", self.codes(self.run_check()))

    def test_missing_validation_command_and_environment(self):
        record = self.validation_record()
        del record["command"]
        del record["environment"]
        self.task["validation"] = {"claim": "passed", "records": [record]}
        self.write_task()
        self.assertIn("VALIDATION", self.codes(self.run_check()))

    def test_critical_path_requires_impact_explanation(self):
        self.task["doc_impact"] = {}
        self.write_task()
        self.write("app/api/entry.py", "value = 2\n")
        report = self.run_check()
        self.assertIn("MISSING_IMPACT", self.codes(report))
        self.assertGreater(report["errors"], 0)

    def test_critical_none_reason_allowed_with_human_reminder(self):
        self.write_task()
        self.write("app/api/entry.py", "value = 2\n")
        report = self.run_check()
        self.assertEqual(report["errors"], 0)
        self.assertIn("HUMAN_REVIEW", self.codes(report))

    def test_claimed_doc_update_must_be_in_diff(self):
        self.task["doc_impact"]["api"] = {"action": "updated", "reason": "New API", "paths": ["docs/ARCHITECTURE.md"]}
        self.write_task()
        self.write("app/api/entry.py", "value = 2\n")
        self.assertIn("IMPACT_NOT_CHANGED", self.codes(self.run_check()))
        self.write("docs/ARCHITECTURE.md", "# Updated API contract\n")
        self.assertEqual(self.run_check()["errors"], 0)

    def test_code_change_without_task_fails(self):
        self.write("app/service.py", "value = 2\n")
        self.assertIn("TASK_REQUIRED", self.codes(self.run_check()))

    def test_noncritical_missing_impact_is_warning(self):
        self.task["doc_impact"] = {}
        self.write_task()
        self.write("app/service.py", "value = 2\n")
        report = self.run_check()
        self.assertEqual(report["errors"], 0)
        self.assertIn("MISSING_IMPACT", self.codes(report))

    def test_plain_docs_exemption_needs_reason_and_verification(self):
        self.write("docs/PROJECT.md", "# Typo fixed\n")
        self.assertIn("LIGHT_CHANGE", self.codes(self.run_check()))
        self.assertEqual(self.run_check(reason="Typo only", evidence="Diff reviewed")["errors"], 0)

    def test_change_note_works_in_ci_without_arguments(self):
        self.write("docs/PROJECT.md", "# Typo fixed\n")
        self.write("docs/changes/typo.md", '<!-- change-note -->\n```json\n{"reason":"typo", "validation":"reviewed", "format_only":false}\n```')
        self.assertEqual(self.run_check()["errors"], 0)

    def test_code_cannot_use_prose_exemption(self):
        self.write("app/service.py", "value = 2\n")
        self.assertIn("INVALID_EXEMPTION", self.codes(self.run_check(reason="typo", evidence="reviewed")))

    def test_format_declaration_not_a_critical_bypass(self):
        self.write("app/service.py", "value=1\n")
        report = self.run_check(reason="format", evidence="diff reviewed", format_only=True)
        self.assertEqual(report["errors"], 0)
        self.assertIn("FORMAT_DECLARATION", self.codes(report))
        self.write("app/api/entry.py", "value=1\n")
        self.assertIn("MISSING_IMPACT", self.codes(self.run_check(reason="format", evidence="diff reviewed", format_only=True)))

    def test_stale_and_overlapping_tasks_warn(self):
        self.task["updated"] = "2026-10-01T00:00:00+08:00"
        self.write_task()
        other = copy.deepcopy(self.task)
        other["id"] = "T-2"
        self.write_task(other)
        report = self.run_check()
        self.assertEqual(report["errors"], 0)
        self.assertTrue({"STALE_TASK", "OVERLAP"} <= self.codes(report))

    def test_committed_staged_unstaged_and_managed_untracked_all_in_diff(self):
        self.write_task()
        self.write("app/service.py", "value=2\n")
        self.commit()
        self.write("app/staged.py", "staged=1\n")
        self.git("add", "app/staged.py")
        self.write("app/api/entry.py", "unstaged=1\n")
        self.write("app/new.py", "untracked=1\n")
        self.write("unrelated/customer.py", "private data must not be read\n")
        self.write("ignored/ignored.py", "ignored\n")
        changed = set(self.run_check()["changed"])
        self.assertTrue({"app/service.py", "app/staged.py", "app/api/entry.py", "app/new.py"} <= changed)
        self.assertNotIn("unrelated/customer.py", changed)
        self.assertNotIn("ignored/ignored.py", changed)

    def test_tracked_file_outside_managed_paths_still_checked(self):
        self.write("elsewhere.py", "a=1\n")
        self.commit()
        baseline = self.git("rev-parse", "HEAD").strip()
        self.write("elsewhere.py", "a=2\n")
        self.assertIn("TASK_REQUIRED", self.codes(self.run_check(base=baseline)))

    def test_rename_keeps_old_critical_path_visible(self):
        self.git("mv", "app/api/entry.py", "app/moved.py")
        self.write_task()
        report = self.run_check()
        self.assertTrue({"app/api/entry.py", "app/moved.py"} <= set(report["changed"]))
        self.assertIn("HUMAN_REVIEW", self.codes(report))

    def test_root_config_glob_does_not_include_sibling_project(self):
        self.config["managed_paths"].append("*.config.*")
        self.write(".context-check.json", json.dumps(self.config))
        self.write("vite.config.ts", "export default {}")
        self.write("unrelated/vite.config.ts", "private config")
        changed = self.run_check()["changed"]
        self.assertIn("vite.config.ts", changed)
        self.assertNotIn("unrelated/vite.config.ts", changed)

    def test_symlink_escape_rejected(self):
        with tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / "secret.md"
            target.write_text("private", encoding="utf-8")
            (self.root / "docs/outside.md").symlink_to(target)
            self.write("docs/PROJECT.md", "[x](outside.md)\n")
            self.assertIn("LINK_ESCAPE", self.codes(self.run_check(reason="prose", evidence="reviewed")))

    def test_cli_bad_base_is_nonzero_json_error(self):
        result = subprocess.run([sys.executable, str(SOURCE / "tools/check_context.py"), "--repo", str(self.root),
                                 "--base", "missing-ref", "--json"], text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["issues"][0]["code"], "CONFIG")


if __name__ == "__main__":
    unittest.main()
