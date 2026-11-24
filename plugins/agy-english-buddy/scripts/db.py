#!/usr/bin/env python3
"""Shared storage and configuration helpers for English Buddy."""

from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
from pathlib import Path
from typing import Any

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": True,
    "auto_correct": True,
    "translate_zh_to_en": True,  # Translate Chinese prompts into English for the agent
    "strictness": "standard",  # gentle | standard | strict
    "summary_language": None,  # e.g. "Chinese", "Japanese", or None
    "domain_terms": [],  # e.g. ["Tailscale", "Headscale", "MagicDNS"]
    "model": "gemini-4-hydrogen-low",
    "timeout_seconds": 22,
}


def get_data_dir() -> Path:
    env_dir = os.environ.get("ENGLISH_BUDDY_DATA_DIR", "").strip()
    if env_dir:
        path = Path(env_dir)
    else:
        path = Path.home() / ".gemini" / "config" / "plugin-data" / "english-buddy"
    path.mkdir(parents=True, exist_ok=True)
    return path


def get_config_path() -> Path:
    return get_data_dir() / "config.json"


def get_db_path() -> Path:
    return get_data_dir() / "history.db"


def get_log_path() -> Path:
    return get_data_dir() / "hook.log"


def _read_json_dict(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def load_config(cwd: str | None = None) -> dict[str, Any]:
    """Load global config and merge optional `<cwd>/.english-buddy.json`."""
    cfg = dict(DEFAULT_CONFIG)
    cfg_path = get_config_path()
    if cfg_path.exists():
        cfg.update(_read_json_dict(cfg_path))
    else:
        save_config(cfg)

    global_terms = cfg.get("domain_terms") if isinstance(cfg.get("domain_terms"), list) else []

    if cwd:
        project_cfg_path = Path(cwd) / ".english-buddy.json"
        project_cfg = _read_json_dict(project_cfg_path)
        if project_cfg:
            proj_terms = (
                project_cfg.get("domain_terms")
                if isinstance(project_cfg.get("domain_terms"), list)
                else []
            )
            cfg.update(project_cfg)
            # Merge global + project domain_terms preserving order
            merged_terms: list[str] = []
            seen: set[str] = set()
            for term in [*global_terms, *proj_terms]:
                t = str(term).strip()
                if t and t.lower() not in seen:
                    seen.add(t.lower())
                    merged_terms.append(t)
            cfg["domain_terms"] = merged_terms

    return cfg


def save_config(cfg: dict[str, Any], path: Path | None = None) -> None:
    target = path or get_config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(cfg, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(get_db_path()), timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS prompts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            date TEXT NOT NULL,
            iso_week TEXT NOT NULL,
            conversation_id TEXT NOT NULL DEFAULT '',
            input_type TEXT NOT NULL DEFAULT 'en',
            strictness TEXT NOT NULL DEFAULT 'standard',
            has_errors INTEGER NOT NULL DEFAULT 0,
            original TEXT NOT NULL,
            corrected TEXT NOT NULL DEFAULT '',
            explanation TEXT NOT NULL DEFAULT '',
            issues TEXT NOT NULL DEFAULT '[]'
        );

        CREATE INDEX IF NOT EXISTS idx_prompts_date ON prompts(date);
        CREATE INDEX IF NOT EXISTS idx_prompts_week ON prompts(iso_week);

        CREATE TABLE IF NOT EXISTS seen_prompts (
            conversation_id TEXT PRIMARY KEY,
            last_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(prompts)").fetchall()}
    if "input_type" not in cols:
        conn.execute("ALTER TABLE prompts ADD COLUMN input_type TEXT NOT NULL DEFAULT 'en'")
        conn.commit()
    return conn


def check_and_mark_seen(conversation_id: str, prompt_hash: str) -> bool:
    """Return True if this exact prompt was already processed as the latest turn."""
    key = conversation_id or "_default_"
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    with get_conn() as conn:
        row = conn.execute(
            "SELECT last_hash FROM seen_prompts WHERE conversation_id = ?",
            (key,),
        ).fetchone()
        if row and row["last_hash"] == prompt_hash:
            return True
        conn.execute(
            """
            INSERT INTO seen_prompts (conversation_id, last_hash, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(conversation_id) DO UPDATE SET
                last_hash = excluded.last_hash,
                updated_at = excluded.updated_at
            """,
            (key, prompt_hash, now),
        )
        conn.commit()
    return False


def record_prompt(
    conversation_id: str,
    strictness: str,
    has_errors: bool,
    original: str,
    corrected: str = "",
    explanation: str = "",
    issues: list[dict[str, Any]] | None = None,
    input_type: str = "en",
) -> None:
    now = dt.datetime.now().astimezone()
    iso_year, iso_wk, _ = now.isocalendar()
    iso_week = f"{iso_year}-W{iso_wk:02d}"
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO prompts (
                created_at, date, iso_week, conversation_id, input_type, strictness,
                has_errors, original, corrected, explanation, issues
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                now.isoformat(),
                now.strftime("%Y-%m-%d"),
                iso_week,
                conversation_id,
                input_type,
                strictness,
                1 if has_errors else 0,
                original,
                corrected,
                explanation,
                json.dumps(issues or [], ensure_ascii=False),
            ),
        )
        conn.commit()


def log_error(message: str) -> None:
    try:
        ts = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        with get_log_path().open("a", encoding="utf-8") as fh:
            fh.write(f"[{ts}] {message}\n")
    except Exception:
        pass
