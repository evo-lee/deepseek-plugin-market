# English prompt coach

Your prompt passes through `deepseek-flash` before the model sees it: English is corrected, Chinese is restated in English, and the changes appear under the composer. The point is twofold — the agent gets a more accurate English prompt, and you get to see where your own wording could be better.

## How it decides

| You type | What happens | What the model sees |
|---|---|---|
| English with errors | Corrected; only traceable errors are touched | The corrected English |
| English, correct | Nothing | Your original text |
| Chinese or mixed | Restated in English, faithful to intent and scope, nothing added | The English version |
| Starts with `::` | Rewritten into a structured English instruction (the only mode allowed to expand) | The rewrite |
| Starts with `;;` | Passed through untouched; the prefix is stripped and no model is called | Your original text, Chinese included |

Silence is the signal: the pill does not appear on a day with no rewrites.

## Two hard rules

**Only errors are fixed.** A sentence that is grammatically correct, correctly punctuated, and clear on first read is left alone — even when a more elegant version exists. Nothing is shortened, reordered for flow, given new transitions, or moved into a different register. This keeps every recorded change tied to a real, learnable mistake instead of to the model's taste.

**Every rewrite passes a literal guard.** The guard extracts what is **mechanically checkable**: backticked spans, numbers with units, paths and URLs, filenames (`package.json`), code identifiers (`snake_case` / `camelCase` / `PascalCase` / `SCREAMING_CASE`), and `--flags`. If any one of them is missing from the rewrite, the whole rewrite is discarded and your prompt is sent unchanged.

Quoted **natural language is not a literal** — a quotation is a quotation, and a rewrite legitimately reorders it. An earlier version protected every quoted span, so a prompt quoting four words failed as a whole and was never coached. **To pin text verbatim, wrap it in backticks**: `` `提交` `` is a hard constraint, `"提交"` is not.

The guard is a mechanical floor — it catches a dropped constraint, not a shifted meaning. `;;` is the final escape hatch.

## Expressiveness hints

When restating Chinese or refining a `::` prompt, the model may name up to two details the request leaves out — which file, whether to preserve behaviour. They appear only in the pill tooltip; they never enter the prompt the model sees and never change your intent.

## The pill

- Appears only when something changed today: `✎ 3 fixes` or `✎ 3 fixes · 2 restated`.
- Hover: the last five rewrites with token-level pairs (`autentication → authentication   (spelling)`) and any hints.
- Footer: today's English prompt count, correction rate, clean count, failure count, and literal rejections.
- Click to refresh; the pill polls every 15 seconds and pauses while the page is hidden.
- Without a usable DeepSeek route it shows `✎ Coaching unavailable` and explains why on hover.

## Commands

| Command | Content |
|---|---|
| `/english-buddy-today` | Today: English prompts, corrections, correction rate, clean prompts, restatements; the last ten rewrites; three lessons; hints |
| `/english-buddy-stats` | 7-day vs 30-day correction rate, the five most frequent patterns, literal rejections |

The correction rate counts **English prompts only**: a restatement is not an error, and including it would make the number meaningless.

## Configuration

Edit the `english-buddy` row in `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `mode` | `automatic` | `automatic` coaches every eligible prompt; `onDemand` only `::`; `off` disables it |
| `authoritative` | `rewrite` | `rewrite`: the model sees only the English version; `original`: keep your text and inject the English version as extra context (the upstream behaviour) |
| `strictness` | `standard` | `gentle` fixes only clear errors; `strict` also flags phrasing a native speaker would notice |
| `translate` | `auto` | `auto` restates Chinese in English; `off` passes it through |
| `escapePrefix` | `;;` | The pass-through prefix; `null` disables it |
| `provider` | `null` | Explicit route; `null` probes `deepseek-account`, then `deepseek-official` |
| `model` | `deepseek-flash` | The coaching model |
| `timeoutMs` | `4000` | Per-rewrite budget (100–30000). A ceiling, not a wait: typically 0.8–2 s |
| `maxInputChars` | `4000` | Longer prompts are skipped |
| `maxOutputTokens` | `1600` | Output cap |
| `sampleRate` | `1` | 0–1, deterministic per prompt |
| `domainTerms` | `[]` | Terms treated as correct English, e.g. `["MagicDNS"]` |
| `retentionDays` | `120` | History retention; `0` disables writing entirely |
| `hints` | `true` | Whether to request expressiveness hints (display only) |

## Data and privacy

- Sent to `deepseek-flash`: **the full text of your prompt**. It uses the DeepSeek route and credentials already configured in DSH; no separate API key is involved.
- History is written to `$DSH_HOME/english-buddy/corrections-YYYY-MM-DD.jsonl`, one record per line, holding the before and after text. It is as sensitive as the session log itself and stays on this machine. `retentionDays: 0` writes nothing.
- The pill reads a loopback-only `GET /api/english-buddy/state`; nothing leaves the machine.
- Each rewrite is an auxiliary model call and counts toward usage, so `dsh-deepseek-meter` will show slightly higher token totals.

## What is skipped

Slash commands, `$skill` invocations, fragments under ten characters and three words, prompts opening with a URL, shell command or bracket, prompts over `maxInputChars`, prompts that miss the sample, and everything that is not a human submission (`source.kind === 'user'`) — subagent prompts and injected context are never coached.

## Failure visibility

A failure never blocks your prompt, and it never disappears silently: every degraded path has a stable failure code, is written to the Harness log, and the most recent one is shown in the pill tooltip and by `/english-buddy-stats`. The common ones are `no-route` (no DeepSeek route configured), `prepare-failed`, `stream-failed` (the request broke), `finish-max-tokens` (output truncated), and `store-write-failed` (history could not be written). A bug in the plugin itself is recorded as `listener-error` and still never affects the submission.

## Where the original wording lives

A rewrite changes **what the model sees**, not **what you see**:

```
┌─────────────────────────────────┐
│  把这个文件的错误处理改一下，别吞异常   │   ← the bubble shows what you typed
└─────────────────────────────────┘
              The user said, "Revise the error handling in this file; …"   ← small line: what the model got
```

- Your text rides on the message `source` — durable display metadata the model never receives.
- The host's English bubble is hidden by one sibling selector. If a host upgrade changes the row structure the rule stops matching and both texts show, which is the safe direction to fail.
- A message carrying images or files is **not** hidden (that would take the attachments with it); it falls back to showing your text as a line above the bubble.
- Hover the small line for the full English; `/english-buddy-today` and the local JSONL always hold before/after.

The opposite arrangement — your text as the message, the English as extra context, both visible to the model — is `authoritative: original`.

## Known limitations
## Relationship to upstream

The mode split, the correction rules, the annotation format and the literal guard come from [`xiaolai/english-buddy-for-claude`](https://github.com/xiaolai/english-buddy-for-claude) (ISC). The implementation is rewritten against DeepSeek Harness's `agent/pre-step`, `ctx.llm`, slot and command interfaces; none of its Claude Code hook code is reused.
