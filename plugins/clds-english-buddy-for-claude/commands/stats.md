---
description: Long-term correction trends — error rate, top recurring mistakes, and improvement trajectory.
argument-hint: "[--days N]"
allowed-tools: Bash
disable-model-invocation: true
---

Run this command and present its output exactly:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" stats "$ARGUMENTS" || true`

Rules:

- Do not recompute, summarize, or invent any number. The script is authoritative.
- Keep the Markdown tables and headings intact.
- Default window is 30 days. `--days 7` and `--days 90` are common.
- If the command fails, show its error and tell the user to run `/clds-english-buddy-for-claude:doctor`.
