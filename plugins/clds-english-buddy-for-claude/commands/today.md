---
description: Today's language report — corrections made, recurring mistakes, Lessons of the Day, and trend.
allowed-tools: Bash
disable-model-invocation: true
---

Run this command and present its output exactly:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" today || true`

Rules:

- Do not recompute, summarize, or invent any number. The script is authoritative.
- Keep the Markdown tables and headings intact.
- If the command fails, show its error and tell the user to run `/clds-english-buddy-for-claude:doctor`.
- If the report says no prompts were recorded, say that the coaching hook has not run in this profile yet.
