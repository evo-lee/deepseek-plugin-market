#!/usr/bin/env python3
"""Offline unit and integration tests for agy-english-buddy."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PLUGIN_DIR = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PLUGIN_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import check_prompt as cp  # noqa: E402
import db  # noqa: E402
import stats  # noqa: E402


class TestEnglishBuddy(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._old_env = os.environ.get("ENGLISH_BUDDY_DATA_DIR")
        os.environ["ENGLISH_BUDDY_DATA_DIR"] = self._tmp.name

    def tearDown(self) -> None:
        if self._old_env is None:
            os.environ.pop("ENGLISH_BUDDY_DATA_DIR", None)
        else:
            os.environ["ENGLISH_BUDDY_DATA_DIR"] = self._old_env
        self._tmp.cleanup()

    def test_manifest_and_hooks_json_valid(self) -> None:
        manifest = json.loads((PLUGIN_DIR / "plugin.json").read_text(encoding="utf-8"))
        hooks = json.loads((PLUGIN_DIR / "hooks.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "english-buddy")
        self.assertIn("english-buddy", hooks)
        self.assertIn("PreInvocation", hooks["english-buddy"])

    def test_classify_prompt(self) -> None:
        self.assertEqual(cp.classify_prompt("帮我看看这个接口为什么报错", True), "zh_to_en")
        self.assertEqual(cp.classify_prompt("帮我看看这个接口为什么报错", False), "skip")
        self.assertEqual(cp.classify_prompt("Please fix the autentication bug", True), "en")
        self.assertEqual(cp.classify_prompt("/english-buddy:stats", True), "skip")
        self.assertEqual(cp.classify_prompt("https://example.com/docs", True), "skip")
        self.assertEqual(cp.classify_prompt("```python\nprint('hi')\n```", True), "skip")
        self.assertEqual(cp.classify_prompt("ok", True), "skip")

    def test_parse_json_response(self) -> None:
        self.assertEqual(cp.parse_json_response('{"has_errors": false}'), {"has_errors": False})
        fenced = '```json\n{"has_errors": true, "corrected": "Fixed."}\n```'
        self.assertEqual(cp.parse_json_response(fenced), {"has_errors": True, "corrected": "Fixed."})
        wrapped = 'Here is the JSON: {"corrected": "Hello"} thanks!'
        self.assertEqual(cp.parse_json_response(wrapped), {"corrected": "Hello"})

    def test_format_plain_text_output(self) -> None:
        zh_text = cp.format_user_markdown(
            {"corrected": "Test how this works.", "explanation": "简短说明"},
            mode="zh_to_en",
        )
        self.assertTrue(zh_text.startswith("The user said:\nTest how this works."))
        self.assertNotIn("**", zh_text)
        self.assertNotIn("> ", zh_text)

        en_text = cp.format_user_markdown(
            {
                "corrected": "Please fix the authentication bug.",
                "explanation": "Fixed spelling.",
                "issues": [{"wrong": "autentication", "right": "authentication", "category": "spelling"}],
            },
            mode="en",
        )
        self.assertTrue(en_text.startswith("The user said:\nPlease fix the authentication bug."))
        self.assertIn("autentication → authentication", en_text)
        self.assertNotIn("**", en_text)

    def test_deduplication_and_stats_separation(self) -> None:
        self.assertFalse(db.check_and_mark_seen("conv-1", "hash-a"))
        self.assertTrue(db.check_and_mark_seen("conv-1", "hash-a"))
        self.assertFalse(db.check_and_mark_seen("conv-1", "hash-b"))

        db.record_prompt(
            "conv-1",
            "standard",
            True,
            "Please fix autentication",
            "Please fix authentication",
            "Fixed typo.",
            [{"wrong": "autentication", "right": "authentication", "category": "spelling"}],
            input_type="en",
        )
        db.record_prompt("conv-1", "standard", False, "Run unit tests.", input_type="en")
        db.record_prompt(
            "conv-1",
            "standard",
            False,
            "帮我修一下登录",
            "Help me fix the login.",
            "",
            [],
            input_type="zh_to_en",
        )

        buf = io.StringIO()
        with mock.patch("sys.stdout", buf):
            stats.cmd_stats(mock.MagicMock())
        out = json.loads(buf.getvalue())
        self.assertEqual(out["total_checked"], 2)
        self.assertEqual(out["clean_count"], 1)
        self.assertEqual(out["corrected_count"], 1)
        self.assertEqual(out["overall_error_rate_pct"], 50.0)
        self.assertEqual(out["zh_to_en_translated_total"], 1)

    def test_project_config_override_and_domain_terms_merge(self) -> None:
        cfg = db.load_config()
        cfg["domain_terms"] = ["Tailscale", "Headscale"]
        cfg["strictness"] = "standard"
        db.save_config(cfg)

        proj_dir = Path(self._tmp.name) / "project"
        proj_dir.mkdir()
        (proj_dir / ".english-buddy.json").write_text(
            json.dumps({"strictness": "strict", "domain_terms": ["Headscale", "MagicDNS"]}),
            encoding="utf-8",
        )

        merged = db.load_config(str(proj_dir))
        self.assertEqual(merged["strictness"], "strict")
        self.assertEqual(merged["domain_terms"], ["Tailscale", "Headscale", "MagicDNS"])

    def test_hook_zh_to_en_injects_user_and_system_steps(self) -> None:
        fake_stdin = json.dumps({"conversationId": "c-zh", "lastUserInput": "测试这句话"})
        fake_result = {"corrected": "Test this sentence.", "explanation": ""}
        out_buf = io.StringIO()
        with (
            mock.patch("sys.stdin", io.StringIO(fake_stdin)),
            mock.patch("sys.stdout", out_buf),
            mock.patch.object(cp, "call_hydrogen", return_value=fake_result),
        ):
            cp.run_hook()
        payload = json.loads(out_buf.getvalue())
        steps = payload["injectSteps"]
        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[0]["userMessage"], "The user said:\nTest this sentence.")
        self.assertIn("Test this sentence.", steps[1]["systemMessage"]["systemMessage"])

    def test_hook_clean_english_stays_silent(self) -> None:
        fake_stdin = json.dumps({"conversationId": "c-en", "lastUserInput": "Run the test suite please."})
        fake_result = {"has_errors": False, "corrected": "", "explanation": "", "issues": []}
        out_buf = io.StringIO()
        with (
            mock.patch("sys.stdin", io.StringIO(fake_stdin)),
            mock.patch("sys.stdout", out_buf),
            mock.patch.object(cp, "call_hydrogen", return_value=fake_result),
            self.assertRaises(SystemExit) as cm,
        ):
            cp.run_hook()
        self.assertEqual(cm.exception.code, 0)
        self.assertEqual(json.loads(out_buf.getvalue()), {})


if __name__ == "__main__":
    unittest.main()
