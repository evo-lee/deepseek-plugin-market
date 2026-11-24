---
description: Show or change english-buddy settings — language, strictness, auto-correction, timeout.
argument-hint: "[--show | --set key=value | --unset key | --global]"
allowed-tools: Bash
disable-model-invocation: true
---

Run this command and present its output exactly:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/config-cli.mjs" "$ARGUMENTS" || true`

Rules:

- The script validates values and writes JSON. Do not edit config files yourself.
- Project config is `.english-buddy.json` in the current directory; `--global` writes under `$CLAUDE_CONFIG_DIR/hooks/prompt_coach.json`.
- Supported keys: `auto_correct`, `summary_language`, `strictness`, `coaching_mode`, `sample_rate`, `timeout_seconds`, `effort`, `max_input_chars`, `domain_terms`, `escape_prefix`, `notify_on_failure`, `model`.
- If the command fails, show its error verbatim.
