# agy-english-buddy

An Antigravity native plugin porting [xiaolai/english-buddy-for-claude](https://github.com/xiaolai/english-buddy-for-claude) with 100% feature parity plus optional Chinese-to-English prompt translation, powered in the background by Antigravity's `gemini-4-hydrogen-low` model via `agy`.

## Features

- **English Prompt Coaching (`PreInvocation`)**: Checks English prompts for spelling, grammar, and awkward phrasing (`gentle` | `standard` | `strict`). Clean prompts stay completely silent; flawed prompts inject a visible `The user said:` message and (when `auto_correct` is `true`) forward the corrected English prompt to the main model.
- **Chinese → English Prompt Translation (`translate_zh_to_en: true`)**: Translates Chinese / Chinese-dominant prompts into clear, idiomatic English for the agent, displays `The user said:` visibly in chat, and keeps translations separate from English error-rate statistics.
- **Error-Rate Tracking**: Logs every checked English prompt (both clean and corrected) in SQLite (`~/.gemini/config/plugin-data/english-buddy/history.db`) for daily and weekly error-rate trends.
- **Global + Project Config**: Merges `~/.gemini/config/plugin-data/english-buddy/config.json` with optional `<workspace>/.english-buddy.json` (`auto_correct`, `translate_zh_to_en`, `strictness`, `summary_language`, `domain_terms`, `model`).
- **All 7 Workflows** (via the `english-buddy` skill): `today`, `stats`, `mistakes`, `drill`, `review`, `preview`, `config`.

## Installation

Copy the plugin directory into Antigravity's global plugins folder:

```sh
cp -R plugins/agy-english-buddy ~/.gemini/config/plugins/english-buddy
```

Or install via the Antigravity CLI:

```sh
agy plugin install ./plugins/agy-english-buddy
```

## Offline Tests

```sh
python3 -m unittest discover -s plugins/agy-english-buddy/test -v
```
