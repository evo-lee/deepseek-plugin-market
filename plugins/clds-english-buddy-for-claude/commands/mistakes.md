---
description: Your top recurring English mistakes — all-time patterns that need attention.
argument-hint: "[--top N]"
allowed-tools: Bash
disable-model-invocation: true
---

Run this command and present its output exactly:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" mistakes "$ARGUMENTS" || true`

Rules:

- Do not recompute, summarize, or invent any number. The script is authoritative.
- Keep the Markdown tables and headings intact.
- Default is the top 20 patterns. `--top 5` is useful for a short review.
- If the command fails, show its error and tell the user to run `/clds-english-buddy-for-claude:doctor`.
