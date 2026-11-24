---
description: Spot-quiz on your top recurring English mistakes — one sentence per round with an intentional error, then grading and the rule.
argument-hint: "[--category <name>] [--rounds N]"
allowed-tools: Bash, Read, AskUserQuestion
disable-model-invocation: true
---

## Load the patterns

Run this command first:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" stats --days 365 --json || true`

The output is JSON with `stats.patterns` (each has `original`, `corrected`, `count`, `category`). Use it as the only source of patterns. Do not invent patterns.

If `stats.patterns` is empty or the user has fewer than 5 corrections all-time, respond: "Not enough history yet to drill. Use Claude Code for a few days, then try again." and STOP.

## Parse arguments

| Flag | Default | Meaning |
|------|---------|---------|
| `--category <name>` | none | Restrict to one category: spelling / grammar / punctuation / word-choice / article / preposition |
| `--rounds N` | 3 | Number of drill sentences |

If `--category` was passed but the user has no patterns in it, fall back to their actual top category and say so in the first round header.

## Generate and grade

For each round:

1. Pick a pattern from the top three categories (round-robin), or from the requested category.
2. Write ONE plausible developer-context sentence (commit message, PR description, doc blurb, or error message) containing exactly ONE intentional error matching that pattern.
3. Present the sentence and ask the user to correct it.
4. After the user replies, grade it:

```markdown
## Grading — Round {N}

| | Text |
|-|------|
| Original | {sentence with error} |
| Expected | {sentence with the target fixed} |
| You wrote | {user answer} |

**Verdict**: Correct / Partial / Incorrect
**Rule**: {one-sentence rule}
```

Accept other edits as long as the user fixed the target pattern. Do not punish stylistic rewrites.

After the last round, emit a short summary table with each round's verdict, the weakest pattern, and one tip. Do not log drill attempts to history.

## Examples

<example>
Context: The user has enough history and wants active practice on blind spots.
user: "/clds-english-buddy-for-claude:drill"
assistant: "Loading your top recurring categories and generating the first drill sentence."
</example>
