---
description: Diagnose the DeepSeek/clds coaching route — endpoint, credential source, model, data directory, live probe.
argument-hint: "[--probe]"
allowed-tools: Bash
disable-model-invocation: true
---

Run this command and present its output exactly:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" "$ARGUMENTS" || true`

Rules:

- Never print or ask for the API key. The script reports only the credential source.
- `--probe` makes one small live request and can incur a tiny API charge.
- If the doctor reports `no-credentials`, confirm the session was started with `clds` and that `DEEPSEEK_API_KEY` or the private key file exists.
- If the doctor reports `auth`, the DeepSeek key is present but rejected; re-run the clds setup rather than pasting the key into chat.
