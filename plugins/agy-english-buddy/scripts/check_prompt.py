#!/usr/bin/env python3
"""Antigravity PreInvocation hook for English Buddy (100% parity with english-buddy-for-claude).

- Silently evaluates English prompts for typos, grammar, and phrasing errors
  using Antigravity's `agy` CLI (`gemini-4-hydrogen-low`).
- Clean prompts produce total silence (zero UI noise).
- Flawed prompts render a concise inline correction card via `metadata.user_markdown`,
  and when `auto_correct` is true, pass the corrected English prompt to the main model.
- Logs every checked English prompt (both clean and corrected) to SQLite for
  accurate error-rate tracking over time.
- Supports `--preview "<text>"` for dry-run evaluation without logging.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

# Prevent infinite recursion when this hook spawns `agy -p`.
if os.environ.get("ENGLISH_BUDDY_INNER") == "1" and "--preview" not in sys.argv:
    print("{}")
    sys.exit(0)

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from db import check_and_mark_seen, load_config, log_error, record_prompt  # noqa: E402

FENCED_CODE_RE = re.compile(r"```[\s\S]*?```")
INLINE_CODE_RE = re.compile(r"`[^`]+`")
URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
PATH_ONLY_RE = re.compile(r"^(/|~/|\./|\.\./)\S+$")
ENGLISH_WORD_RE = re.compile(r"\b[A-Za-z][A-Za-z'-]{1,}\b")
CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")
SKIP_TRIGGER_RE = re.compile(r"(^/|\benglish[- ]buddy\b)", re.IGNORECASE)


def emit_empty() -> None:
    print("{}")
    sys.exit(0)


def classify_prompt(text: str, translate_zh_to_en: bool) -> str:
    """Classify prompt as 'en', 'zh_to_en', or 'skip'."""
    stripped = text.strip()
    if len(stripped) < 2:
        return "skip"
    if SKIP_TRIGGER_RE.search(stripped):
        return "skip"
    if PATH_ONLY_RE.match(stripped):
        return "skip"

    prose = FENCED_CODE_RE.sub(" ", stripped)
    prose = INLINE_CODE_RE.sub(" ", prose)
    prose = URL_RE.sub(" ", prose).strip()
    if not prose:
        return "skip"

    en_words = ENGLISH_WORD_RE.findall(prose)
    cjk_chars = CJK_RE.findall(prose)
    latin_chars = sum(len(w) for w in en_words)

    if len(cjk_chars) > 0 and len(cjk_chars) * 3 >= latin_chars:
        return "zh_to_en" if translate_zh_to_en else "skip"

    if len(en_words) < 2 or len(stripped) < 4:
        return "skip"

    return "en"


def is_checkable_english(text: str) -> bool:
    """Backward-compatible helper for checking English prose."""
    return classify_prompt(text, translate_zh_to_en=False) == "en"


def find_agy() -> str | None:
    found = shutil.which("agy")
    if found:
        return found
    for candidate in (
        Path.home() / ".local" / "bin" / "agy",
        Path("/usr/local/bin/agy"),
        Path("/opt/homebrew/bin/agy"),
    ):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def build_prompt(user_text: str, cfg: dict[str, Any]) -> str:
    strictness = str(cfg.get("strictness", "standard")).lower()
    domain_terms = cfg.get("domain_terms") or []
    summary_lang = cfg.get("summary_language")

    strict_rules = {
        "gentle": (
            "Strictness: GENTLE. Only fix clear spelling or grammatical errors. "
            "Accept informal, concise, or casual developer English without rewriting it."
        ),
        "standard": (
            "Strictness: STANDARD. Fix spelling, grammar, and clearly awkward or "
            "unnatural phrasing while keeping the user's tone and intent."
        ),
        "strict": (
            "Strictness: STRICT. Fix all spelling, grammar, punctuation, and "
            "stylistic issues, and polish into crisp, idiomatic native-level English."
        ),
    }.get(
        strictness,
        "Strictness: STANDARD. Fix spelling, grammar, and clearly awkward or unnatural phrasing.",
    )

    terms_clause = ""
    if isinstance(domain_terms, list) and domain_terms:
        joined = ", ".join(str(t) for t in domain_terms if str(t).strip())
        if joined:
            terms_clause = (
                f"Domain/project terms (treat as valid and NEVER flag as spelling errors): {joined}.\n"
            )

    explanation_lang = (
        f"Write the brief explanation in {summary_lang}."
        if summary_lang
        else "Write the brief explanation in concise English."
    )

    return (
        "You are an English writing coach sitting silently between a non-native English developer "
        "and their AI coding assistant. Do NOT answer the user's prompt and do NOT run any tools.\n"
        f"{strict_rules}\n"
        f"{terms_clause}"
        "Preserve all code snippets, file paths, identifiers, CLI flags, and URLs verbatim.\n"
        "If the prompt has NO errors worth fixing at this strictness level, return:\n"
        '{"has_errors": false, "corrected": "", "explanation": "", "issues": []}\n'
        "If there ARE errors, return a single raw JSON object ONLY (no markdown fences, no extra text):\n"
        "{\n"
        '  "has_errors": true,\n'
        '  "corrected": "The corrected English prompt",\n'
        f'  "explanation": "1 concise sentence explaining the fix. {explanation_lang}",\n'
        '  "issues": [\n'
        '    {"wrong": "exact flawed span", "right": "corrected span", "category": "spelling|grammar|phrasing|preposition|article|tense|word_choice|punctuation"}\n'
        "  ]\n"
        "}\n\n"
        f"USER PROMPT:\n{user_text}"
    )


def parse_json_response(raw: str) -> dict[str, Any] | None:
    text = raw.strip()
    if not text:
        return None
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            try:
                data = json.loads(text[start : end + 1])
                return data if isinstance(data, dict) else None
            except json.JSONDecodeError:
                return None
    return None


def build_zh_to_en_prompt(user_text: str, cfg: dict[str, Any]) -> str:
    domain_terms = cfg.get("domain_terms") or []
    terms_clause = ""
    if isinstance(domain_terms, list) and domain_terms:
        joined = ", ".join(str(t) for t in domain_terms if str(t).strip())
        if joined:
            terms_clause = f"Preserve these domain/project terms verbatim: {joined}.\n"

    return (
        "You translate a developer's Chinese (or mixed Chinese/English) prompt into clear, "
        "idiomatic English optimized for an AI coding agent. Do NOT answer the prompt and do NOT run any tools.\n"
        f"{terms_clause}"
        "Preserve all code snippets, file paths, identifiers, CLI flags, and URLs verbatim.\n"
        "Return a single raw JSON object ONLY (no markdown fences, no extra text):\n"
        "{\n"
        '  "corrected": "Clear, natural English prompt for the agent",\n'
        '  "explanation": "Optional 1 short Chinese note on a useful English phrase (or empty string)"\n'
        "}\n\n"
        f"USER PROMPT:\n{user_text}"
    )


def call_hydrogen(user_text: str, cfg: dict[str, Any], mode: str = "en") -> dict[str, Any] | None:
    agy_bin = find_agy()
    if not agy_bin:
        log_error("agy binary not found in PATH")
        return None

    model = str(cfg.get("model", "gemini-4-hydrogen-low"))
    timeout = int(cfg.get("timeout_seconds", 22))
    prompt = build_zh_to_en_prompt(user_text, cfg) if mode == "zh_to_en" else build_prompt(user_text, cfg)

    env = dict(os.environ)
    env["ENGLISH_BUDDY_INNER"] = "1"

    cmd = [
        agy_bin,
        "--model",
        model,
        "--disable-slash-commands",
        "--output-format",
        "text",
        "--print-timeout",
        f"{timeout}s",
        "-p",
        prompt,
    ]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout + 3,
            cwd=tempfile.gettempdir(),
            env=env,
        )
    except subprocess.TimeoutExpired:
        log_error(f"agy timed out after {timeout}s")
        return None
    except Exception as exc:
        log_error(f"agy invocation failed: {exc}")
        return None

    if proc.returncode != 0:
        log_error(f"agy exited {proc.returncode}: {(proc.stderr or proc.stdout).strip()[:300]}")
        return None

    parsed = parse_json_response(proc.stdout)
    if not parsed:
        log_error(f"failed to parse JSON from agy output: {proc.stdout.strip()[:300]}")
        return None
    return parsed


def format_user_markdown(result: dict[str, Any], mode: str = "en") -> str:
    corrected = str(result.get("corrected", "")).strip()
    explanation = str(result.get("explanation", "")).strip()
    issues = result.get("issues") or []

    if mode == "zh_to_en":
        lines = ["The user said:"]
        if corrected:
            lines.append(corrected)
        if explanation:
            lines.append(f"💡 {explanation}")
        return "\n".join(lines)

    diffs: list[str] = []
    if isinstance(issues, list):
        for item in issues[:4]:
            if isinstance(item, dict) and item.get("wrong") and item.get("right"):
                diffs.append(f"{item['wrong']} → {item['right']}")

    lines = ["The user said:"]
    if corrected:
        lines.append(corrected)
    if diffs:
        lines.append(" · ".join(diffs))
    if explanation:
        lines.append(f"💡 {explanation}")
    return "\n".join(lines)


def build_summary_instruction(summary_lang: Any) -> str:
    if isinstance(summary_lang, str) and summary_lang.strip():
        return (
            f"At the very end of your response, append a brief 1-2 sentence summary in {summary_lang.strip()}."
        )
    return ""


def run_preview(text: str, cwd: str | None) -> None:
    cfg = load_config(cwd)
    mode = classify_prompt(text, translate_zh_to_en=bool(cfg.get("translate_zh_to_en", True)))
    if mode == "skip":
        print(
            json.dumps(
                {
                    "preview": True,
                    "skipped": True,
                    "reason": "Prompt was skipped (too short, slash command, URL/path, or pure code).",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    result = call_hydrogen(text, cfg, mode=mode)
    if not result:
        print(json.dumps({"preview": True, "error": "Background check failed or timed out."}, indent=2))
        sys.exit(1)

    print(
        json.dumps(
            {
                "preview": True,
                "logged": False,
                "mode": mode,
                "strictness": cfg.get("strictness", "standard"),
                "domain_terms": cfg.get("domain_terms", []),
                "result": result,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def run_hook() -> None:
    try:
        raw_stdin = sys.stdin.read()
        payload = json.loads(raw_stdin) if raw_stdin.strip() else {}
    except Exception as exc:
        log_error(f"invalid stdin JSON: {exc}")
        emit_empty()

    cwd = str(payload.get("cwd", "")).strip() or None
    cfg = load_config(cwd)
    if not cfg.get("enabled", True):
        emit_empty()

    last_input = str(payload.get("lastUserInput", "")).strip()
    conv_id = str(payload.get("conversationId", ""))

    mode = classify_prompt(last_input, translate_zh_to_en=bool(cfg.get("translate_zh_to_en", True)))
    if mode == "skip":
        emit_empty()

    prompt_hash = hashlib.sha256(last_input.encode("utf-8")).hexdigest()
    if check_and_mark_seen(conv_id, prompt_hash):
        emit_empty()

    result = call_hydrogen(last_input, cfg, mode=mode)
    if not result:
        emit_empty()

    summary_instr = build_summary_instruction(cfg.get("summary_language"))

    if mode == "zh_to_en":
        translated = str(result.get("corrected", "")).strip()
        explanation = str(result.get("explanation", "")).strip()
        if not translated:
            emit_empty()
        try:
            record_prompt(
                conversation_id=conv_id,
                strictness=str(cfg.get("strictness", "standard")),
                has_errors=False,
                original=last_input,
                corrected=translated,
                explanation=explanation,
                issues=[],
                input_type="zh_to_en",
            )
        except Exception as exc:
            log_error(f"failed to record zh_to_en prompt: {exc}")

        user_md = format_user_markdown(result, mode="zh_to_en")
        model_parts = [
            "[English Buddy] The user's Chinese prompt has been translated into English above:\n"
            f"{translated}\n"
            "Act on this English prompt directly. Do not comment on the translation unless asked; reply in Chinese unless English is requested."
        ]
        if summary_instr:
            model_parts.append(summary_instr)
        print(
            json.dumps(
                {
                    "injectSteps": [
                        {"userMessage": user_md},
                        {
                            "systemMessage": {
                                "systemMessage": "\n\n".join(model_parts),
                            }
                        },
                    ],
                    "terminationBehavior": "",
                },
                ensure_ascii=False,
            )
        )
        return

    has_errors = bool(result.get("has_errors"))
    corrected = str(result.get("corrected", "")).strip()
    explanation = str(result.get("explanation", "")).strip()
    issues = [i for i in (result.get("issues") or []) if isinstance(i, dict)]

    # If the model flagged has_errors but returned an identical string, treat as clean
    if has_errors and (not corrected or corrected.strip() == last_input.strip()):
        has_errors = False
        corrected = ""
        issues = []

    try:
        record_prompt(
            conversation_id=conv_id,
            strictness=str(cfg.get("strictness", "standard")),
            has_errors=has_errors,
            original=last_input,
            corrected=corrected,
            explanation=explanation,
            issues=issues,
            input_type="en",
        )
    except Exception as exc:
        log_error(f"failed to record prompt: {exc}")

    if not has_errors:
        # Clean prompt: complete UI silence. Only inject summary_language if configured.
        if summary_instr:
            print(
                json.dumps(
                    {
                        "injectSteps": [
                            {"systemMessage": {"systemMessage": f"[English Buddy] {summary_instr}"}}
                        ]
                    },
                    ensure_ascii=False,
                )
            )
        else:
            emit_empty()
        return

    user_md = format_user_markdown(result, mode="en")
    model_parts: list[str] = []
    if cfg.get("auto_correct", True):
        model_parts.append(
            "[English Buddy] Corrected version of the user's latest prompt:\n"
            f"{corrected}\n"
            "Act on this corrected prompt directly without commenting on the user's English."
        )
    if summary_instr:
        model_parts.append(summary_instr)

    steps: list[dict[str, Any]] = [{"userMessage": user_md}]
    if model_parts:
        steps.append(
            {
                "systemMessage": {
                    "systemMessage": "\n\n".join(model_parts),
                }
            }
        )

    output = {
        "injectSteps": steps,
        "terminationBehavior": "",
    }
    print(json.dumps(output, ensure_ascii=False))


def main() -> None:
    if "--preview" in sys.argv:
        parser = argparse.ArgumentParser(description="English Buddy dry-run preview")
        parser.add_argument("--preview", required=True, help="Prompt text to preview")
        parser.add_argument("--cwd", default=None, help="Optional workspace cwd for .english-buddy.json")
        args = parser.parse_args()
        run_preview(args.preview, args.cwd)
    else:
        run_hook()


if __name__ == "__main__":
    main()
