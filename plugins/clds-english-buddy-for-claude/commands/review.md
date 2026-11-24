---
description: Deep English review of text, a commit message, a PR description, documentation, or an email.
argument-hint: "<text or --file path>"
allowed-tools: Bash
---

Run this command and present its output exactly:

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/coach-cli.mjs" review <<'__CLDS_ENGLISH_BUDDY_EOF_9F4C__' || true
$ARGUMENTS
__CLDS_ENGLISH_BUDDY_EOF_9F4C__
```

Rules:

- The script makes one model call and returns Markdown; present it verbatim.
- If the user gave a file path, they can use `--file path`.
- If the script says no text was supplied, ask the user to paste the text or pass `--file`.
- If the script fails, show its error and tell the user to run `/clds-english-buddy-for-claude:doctor`.
