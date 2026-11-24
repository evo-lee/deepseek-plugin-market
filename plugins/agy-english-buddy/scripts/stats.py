#!/usr/bin/env python3
"""CLI helper for English Buddy: today, stats, mistakes, drill, and config."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from db import get_config_path, get_conn, load_config, save_config  # noqa: E402


def _pct(errors: int, total: int) -> float:
    return round((errors / total) * 100.0, 1) if total > 0 else 0.0


def cmd_today(_args: argparse.Namespace) -> None:
    today = dt.datetime.now().astimezone().strftime("%Y-%m-%d")
    with get_conn() as conn:
        en_rows = conn.execute(
            "SELECT * FROM prompts WHERE date = ? AND input_type = 'en' ORDER BY id ASC", (today,)
        ).fetchall()
        zh_count = conn.execute(
            "SELECT COUNT(*) FROM prompts WHERE date = ? AND input_type = 'zh_to_en'", (today,)
        ).fetchone()[0]

    total = len(en_rows)
    corrected_rows = [r for r in en_rows if r["has_errors"]]
    clean_count = total - len(corrected_rows)

    cat_counter: collections.Counter[str] = collections.Counter()
    corrections = []
    for r in corrected_rows:
        issues = json.loads(r["issues"])
        for item in issues:
            cat_counter[str(item.get("category", "other"))] += 1
        corrections.append(
            {
                "id": r["id"],
                "created_at": r["created_at"],
                "original": r["original"],
                "corrected": r["corrected"],
                "explanation": r["explanation"],
                "issues": issues,
            }
        )

    print(
        json.dumps(
            {
                "date": today,
                "total_checked": total,
                "clean_count": clean_count,
                "corrected_count": len(corrected_rows),
                "error_rate_pct": _pct(len(corrected_rows), total),
                "zh_to_en_translated": zh_count,
                "top_categories_today": dict(cat_counter.most_common()),
                "corrections": corrections,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_stats(_args: argparse.Namespace) -> None:
    with get_conn() as conn:
        total = conn.execute("SELECT COUNT(*) FROM prompts WHERE input_type = 'en'").fetchone()[0]
        errors = conn.execute(
            "SELECT COUNT(*) FROM prompts WHERE input_type = 'en' AND has_errors = 1"
        ).fetchone()[0]
        zh_total = conn.execute(
            "SELECT COUNT(*) FROM prompts WHERE input_type = 'zh_to_en'"
        ).fetchone()[0]
        clean = total - errors

        weekly_rows = conn.execute(
            """
            SELECT iso_week,
                   COUNT(*) AS total,
                   SUM(has_errors) AS errors
            FROM prompts
            WHERE input_type = 'en'
            GROUP BY iso_week
            ORDER BY iso_week ASC
            """
        ).fetchall()

        daily_rows = conn.execute(
            """
            SELECT date,
                   COUNT(*) AS total,
                   SUM(has_errors) AS errors
            FROM prompts
            WHERE input_type = 'en'
            GROUP BY date
            ORDER BY date DESC
            LIMIT 14
            """
        ).fetchall()

        issue_rows = conn.execute(
            "SELECT issues FROM prompts WHERE input_type = 'en' AND has_errors = 1"
        ).fetchall()

    weekly = [
        {
            "iso_week": r["iso_week"],
            "total": r["total"],
            "errors": r["errors"],
            "error_rate_pct": _pct(r["errors"], r["total"]),
        }
        for r in weekly_rows
    ]

    trend = None
    if len(weekly) >= 2:
        first_rate = weekly[0]["error_rate_pct"]
        latest_rate = weekly[-1]["error_rate_pct"]
        delta = round(latest_rate - first_rate, 1)
        trend = {
            "from_week": weekly[0]["iso_week"],
            "to_week": weekly[-1]["iso_week"],
            "first_error_rate_pct": first_rate,
            "latest_error_rate_pct": latest_rate,
            "delta_pct_points": delta,
        }

    cat_counter: collections.Counter[str] = collections.Counter()
    for (raw,) in issue_rows:
        try:
            for item in json.loads(raw):
                cat_counter[str(item.get("category", "other"))] += 1
        except Exception:
            pass

    print(
        json.dumps(
            {
                "total_checked": total,
                "clean_count": clean,
                "corrected_count": errors,
                "overall_error_rate_pct": _pct(errors, total),
                "zh_to_en_translated_total": zh_total,
                "trend": trend,
                "by_category": dict(cat_counter.most_common()),
                "weekly": weekly[-12:],
                "recent_14_days": [
                    {
                        "date": r["date"],
                        "total": r["total"],
                        "errors": r["errors"],
                        "error_rate_pct": _pct(r["errors"], r["total"]),
                    }
                    for r in daily_rows
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_mistakes(args: argparse.Namespace) -> None:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT original, corrected, explanation, issues, date
            FROM prompts
            WHERE has_errors = 1
            ORDER BY id DESC
            LIMIT ?
            """,
            (args.limit,),
        ).fetchall()

    issue_counter: collections.Counter[tuple[str, str, str]] = collections.Counter()
    cat_counter: collections.Counter[str] = collections.Counter()
    examples_by_cat: dict[str, list[dict[str, str]]] = collections.defaultdict(list)

    for r in rows:
        try:
            for item in json.loads(r["issues"]):
                wrong = str(item.get("wrong", "")).strip()
                right = str(item.get("right", "")).strip()
                cat = str(item.get("category", "other")).strip()
                if wrong and right:
                    issue_counter[(wrong, right, cat)] += 1
                    cat_counter[cat] += 1
                    if len(examples_by_cat[cat]) < 5:
                        examples_by_cat[cat].append(
                            {"wrong": wrong, "right": right, "date": r["date"]}
                        )
        except Exception:
            pass

    top_issues = [
        {"wrong": w, "right": r, "category": c, "count": n}
        for (w, r, c), n in issue_counter.most_common(25)
    ]

    print(
        json.dumps(
            {
                "sampled_corrections": len(rows),
                "by_category": dict(cat_counter.most_common()),
                "top_recurring_mistakes": top_issues,
                "examples_by_category": dict(examples_by_cat),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_drill(args: argparse.Namespace) -> None:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT original, corrected, explanation, issues, date
            FROM prompts
            WHERE has_errors = 1
            ORDER BY id DESC
            LIMIT ?
            """,
            (args.limit,),
        ).fetchall()

    items = [
        {
            "date": r["date"],
            "original": r["original"],
            "corrected": r["corrected"],
            "explanation": r["explanation"],
            "issues": json.loads(r["issues"]),
        }
        for r in rows
    ]
    print(json.dumps({"count": len(items), "items": items}, ensure_ascii=False, indent=2))


def parse_value(raw: str) -> Any:
    low = raw.lower()
    if low == "true":
        return True
    if low == "false":
        return False
    if low in ("null", "none"):
        return None
    try:
        return int(raw)
    except ValueError:
        return raw


def cmd_config(args: argparse.Namespace) -> None:
    target_path = Path(args.cwd) / ".english-buddy.json" if (args.project and args.cwd) else get_config_path()

    if args.project and not args.cwd:
        print(json.dumps({"error": "--project requires --cwd <workspace_path>"}), file=sys.stderr)
        sys.exit(1)

    if args.set or args.add_term or args.remove_term:
        if args.project:
            cfg = json.loads(target_path.read_text(encoding="utf-8")) if target_path.is_file() else {}
        else:
            cfg = load_config()

        for pair in args.set or []:
            if "=" not in pair:
                continue
            k, v = pair.split("=", 1)
            cfg[k.strip()] = parse_value(v.strip())

        terms = list(cfg.get("domain_terms") or [])
        for term in args.add_term or []:
            t = term.strip()
            if t and t.lower() not in {x.lower() for x in terms}:
                terms.append(t)
        if args.remove_term:
            remove_set = {t.strip().lower() for t in args.remove_term}
            terms = [x for x in terms if x.lower() not in remove_set]
        if args.add_term or args.remove_term:
            cfg["domain_terms"] = terms

        save_config(cfg, target_path)

    effective = load_config(args.cwd)
    print(
        json.dumps(
            {
                "config_path": str(target_path),
                "effective_config": effective,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="English Buddy stats & config CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("today")
    sub.add_parser("stats")

    p_m = sub.add_parser("mistakes")
    p_m.add_argument("--limit", type=int, default=200)

    p_d = sub.add_parser("drill")
    p_d.add_argument("--limit", type=int, default=20)

    p_c = sub.add_parser("config")
    p_c.add_argument("--cwd", default=None, help="Workspace path to read/write .english-buddy.json")
    p_c.add_argument("--project", action="store_true", help="Write changes to <cwd>/.english-buddy.json")
    p_c.add_argument("--set", nargs="*", help="key=value pairs to update")
    p_c.add_argument("--add-term", nargs="*", help="Add domain terms to ignore list")
    p_c.add_argument("--remove-term", nargs="*", help="Remove domain terms from ignore list")

    args = parser.parse_args()
    {
        "today": cmd_today,
        "stats": cmd_stats,
        "mistakes": cmd_mistakes,
        "drill": cmd_drill,
        "config": cmd_config,
    }[args.cmd](args)


if __name__ == "__main__":
    main()
