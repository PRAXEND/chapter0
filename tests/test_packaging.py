import importlib.util
from pathlib import Path
import re
import unittest
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("packaging_under_test", ROOT / "tools/package.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackagingTests(unittest.TestCase):
    def test_distributed_markdown_references_are_in_the_package(self):
        included = set(package.FILES)
        missing = []
        for relative in included:
            if not relative.endswith(".md"):
                continue
            path = ROOT / relative
            for link in re.findall(r"\]\(([^\s)]+)\)", path.read_text()):
                parsed = urlsplit(link)
                if parsed.scheme or link.startswith("#"):
                    continue
                target = (path.parent / unquote(parsed.path)).resolve()
                if ROOT.resolve() not in target.parents:
                    missing.append((relative, link))
                elif target.relative_to(ROOT).as_posix() not in included:
                    missing.append((relative, link))
        self.assertEqual(missing, [])

    def test_optional_user_data_is_excluded_and_script_imports_are_present(self):
        self.assertFalse(any(p.startswith("user-packs/") for p in package.FILES))
        self.assertIn("plugins/video-studio/scripts/user_packs.py", package.FILES)
        self.assertIn("plugins/video-studio/scripts/check_connection.py", package.FILES)

    def test_objective_audio_gate_and_its_real_media_regression_tests_are_distributed(self):
        for relative in ("plugins/video-studio/scripts/review_audio_alignment.py",
                         "tests/test_audio_alignment.py", "tests/test_quality_probe.py"):
            with self.subTest(file=relative):
                self.assertIn(relative, package.FILES)
                self.assertTrue((ROOT / relative).is_file())


if __name__ == "__main__":
    unittest.main()
