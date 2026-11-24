---
description: Dry-run review of a prompt — shows what would be corrected without submitting it or logging history.
argument-hint: "<text or --file path>"
allowed-tools: Bash
disable-model-invocation: true
---

Run this command and present its output exactly:

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/coach-cli.mjs" preview <<'__CLDS_ENGLISH_BUDDY_EOF_9F4C__' || true
$ARGUMENTS
__CLDS_ENGLISH_BUDDY_EOF_9F4C__
```

Rules:

- This is a dry run. The script writes no history and submits nothing.
- If the user gave a file path, they can use `--file path` instead of pasting the text.
- If the script says no text was supplied, ask the user to paste the text or pass `--file`.
- If the script fails, show its error and tell the user to run `/clds-english-buddy-for-claude:doctor`.
