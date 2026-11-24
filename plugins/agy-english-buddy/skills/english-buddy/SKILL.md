---
name: english-buddy
description: English Buddy coach workflows with full parity to english-buddy-for-claude: daily report (today), long-term error-rate trends (stats), recurring mistakes (mistakes), interactive spot-quizzes (drill), deep writing review (review), dry-run prompt check (preview), and configuration (config).
---

# English Buddy

Use this skill whenever the user asks for any of the 7 English Buddy workflows (`today`, `stats`, `mistakes`, `drill`, `review`, `preview`, `config`) or asks to review their English writing progress and settings.

Scripts live under `~/.gemini/config/plugins/english-buddy/scripts/`:
- `stats.py` — reads/writes `$PLUGIN_DATA/history.db` and `config.json` (plus optional `<workspace>/.english-buddy.json`).
- `check_prompt.py --preview "<text>"` — runs a dry-run prompt check without logging to SQLite.

## The 7 Workflows

### 1. `today` — Daily Correction Report
Run:
```bash
python3 ~/.gemini/config/plugins/english-buddy/scripts/stats.py today
```
Present:
- Today's headline metrics: prompts checked, clean prompts, corrected prompts, today's error rate (`%`).
- Table of today's corrections (`Original` → `Corrected` + key issue).
- Recurring patterns noticed today and 1–3 concise micro-lessons.

### 2. `stats` — Long-Term Trends & Error Rate
Run:
```bash
python3 ~/.gemini/config/plugins/english-buddy/scripts/stats.py stats
```
Present:
- All-time totals (checked, clean, corrected, overall error rate).
- Error-rate trajectory across weeks (highlight improvement delta, e.g. "Error rate down X percentage points from week A to week B").
- Top error categories (`spelling`, `grammar`, `phrasing`, `preposition`, `article`, `tense`, `word_choice`, `punctuation`).

### 3. `mistakes` — All-Time Recurring Mistakes
Run:
```bash
python3 ~/.gemini/config/plugins/english-buddy/scripts/stats.py mistakes
```
Present the user's top recurring blind spots grouped by mistake pattern and category, with short memorable rules to eliminate each habit.

### 4. `drill` — Interactive Spot-Quiz
Run:
```bash
python3 ~/.gemini/config/plugins/english-buddy/scripts/stats.py drill --limit 20
```
Pick 3–5 of the user's real recurring mistakes/flawed prompts and quiz them interactively:
- Show the flawed sentences (or fill-in-the-blank variations) **without** revealing the answers yet.
- Wait for the user's reply, then grade each answer, explain why, and reinforce the underlying rule.

### 5. `review` — Deep Review of Any Text, Doc, PR, or Email
Load the user's effective config first (to respect `strictness`, `domain_terms`, and `summary_language`):
```bash
python3 ~/.gemini/config/plugins/english-buddy/scripts/stats.py config --cwd "<workspace_path>"
```
Perform a thorough, structured English review of the text/file/PR/email the user provides:
- Highlight specific issues (grammar, clarity, tone, conciseness, word choice) while respecting `domain_terms`.
- Provide a clean polished revision.
- Summarize the top 2–3 takeaways (and append a brief summary in `summary_language` if configured).

### 6. `preview` — Dry-Run Prompt Check (Logs Nothing)
Run:
```bash
python3 ~/.gemini/config/plugins/english-buddy/scripts/check_prompt.py --preview "<prompt_text>" --cwd "<workspace_path>"
```
Show exactly what English Buddy would flag or pass silently at the current `strictness` and `domain_terms`—explicitly noting that nothing was logged to history.

### 7. `config` — View & Update Preferences
Run:
```bash
python3 ~/.gemini/config/plugins/english-buddy/scripts/stats.py config --cwd "<workspace_path>"
```
Supported settings (global by default, or pass `--project --cwd "<workspace_path>"` to save in `.english-buddy.json`):
- `auto_correct`: `true` | `false` — forward corrected English to the main model
- `translate_zh_to_en`: `true` | `false` — translate Chinese prompts into English via `PreInvocation` and forward to the agent (kept separate from English error-rate stats)
- `strictness`: `gentle` | `standard` | `strict`
- `summary_language`: `"Chinese"` | `"Japanese"` | ... | `null` — append a brief summary in this language at the end of model responses
- `domain_terms`: add/remove via `--add-term Foo Bar` / `--remove-term Foo`
- `enabled`: `true` | `false` — pause/resume the hook
- `model`: default `gemini-4-hydrogen-low`
- `timeout_seconds`: default `22`
