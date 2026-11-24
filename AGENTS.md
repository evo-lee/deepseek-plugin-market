# AGENTS.md

Instructions for AI coding agents working in this repository. Read this before
changing anything; the DSH facts below were learned by reading the installed
Harness source and cost real debugging time.

## What this repository is

Two things in one repo:

1. **A plugin index** (`index.json`, DSH plugin-market `format: 1`) that makes
   the plugins installable from **Plugins → Discover**.
2. **The plugin sources** it lists, under `plugins/<package-name>/`.

The index is generated from the sources. It is never hand-edited.

```
index.json                 generated; do not edit by hand
scripts/build-index.mjs    the only writer of index.json
plugins/<name>/            one installable DSH bundle per directory
docs/PUBLISHING.md         release steps
```

## Commands

```sh
npm test                   # all plugin test suites, offline, no credentials
npm run index              # regenerate index.json from plugins/* (needs a git remote)
node plugins/dsh-english-buddy/test/coach.test.mjs   # one suite
```

There is no build step and no runtime dependency. Everything is plain ESM
JavaScript executed directly by the Harness; `node --check <file>` is the syntax
gate.

## Non-negotiable rules

1. **`index.json` is generated.** Change `scripts/build-index.mjs` or the plugin
   manifests, then regenerate. A hand-edited index will be overwritten and a
   stale one will install the wrong commit.
2. **Every plugin stays installable on its own**, by directory (`dsh plugin add
   ./plugins/<name>`) and by git path (`<repo>#<commit>&path:plugins/<name>`).
   Never add a reference from a plugin to a sibling directory.
3. **No runtime dependencies, no `@deepseek-ai/*` imports.** See the resolution
   note below; both are load-bearing.
4. **Every user-visible plugin carries `locale/{zh,en}.json`, `docs/DETAIL.md`,
   `docs/DETAIL.en.md`, and `icon.svg`.** The index and the Plugins page are
   incomplete without them; the build script inlines the icon from that file.
5. **Failures are handled, never swallowed.** A plugin that degrades must record
   a stable failure code through its reporter and expose it (status route,
   tooltip, command). `catch {}` with no reporting is a review blocker.
6. **Tests are offline.** No network, no credentials, no reliance on the local
   machine's state. Stub the Harness services; assert on observable output.

## DSH facts that are easy to get wrong

### Package resolution inside a profile

A profile-installed bundle lives in `~/.dsh/profiles/<profile>/node_modules/`,
which is **not** under the DSH installation. `import '@deepseek-ai/dsh-llm'`
from a profile bundle therefore fails to resolve. Write Host code against
`node:*` only, and reach Harness behavior through `ctx` services:

- message identity: `{ ...message, content }`; ids are `randomUUID()`
- stream assembly: `block-end` already carries the assembled block
- deadlines: `AbortSignal.timeout()` / `AbortSignal.any()`
- config validation: hand-written, throwing a `TypeError` that names the key

Installing a duplicate copy of a Harness package into the profile works but
creates a second module instance; do not do it.

### Rewriting a prompt before the model sees it

`agent/pre-step` is the only pre-request rewrite point.

```js
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()                     // always call this first
  if (decision.kind !== 'enter') return decision
  return { ...decision, messages: rewritten }       // spread: keeps other fields
})
```

- The **entered batch is what the log records** as `user/message`. Replacing the
  text mutates history; there is no built-in "original + corrected" pair. Keep
  the original yourself if you need it.
- `source.kind === 'user'` means "a real composer submission" — but **subagent
  prompts are submitted with `source.kind === 'user'` too**. Gate top-level
  sessions on `agent.session.header.origin !== 'subagent'` and
  `(header.delegationDepth ?? 0) === 0`.
- A listener that fails must return the decision it was given. Never reject a
  step because coaching failed.

### Auxiliary model calls

Use the routes the user already configured; never require a second credential.

```js
const prepared = await ctx.llm.prepareCall(
  { provider, model, reasoningEffort: 'off', maxTokens }, signal)
if (prepared.config.reasoningEffort !== 'off') return   // route cannot disable thinking
for await (const chunk of prepared.stream({
  ...prepared.config, system, messages: [{ role: 'user', content: [{ type: 'text', text }] }], signal,
})) { /* text-delta, block-end, finish */ }
```

- `finish.reason.kind` must be `stop`; everything else is a failed call.
- `tool-call-delta` / `reasoning-delta` mean the model ignored the output
  contract; discard the response.
- Probe providers with `listProviders()` and `listModels(provider)`; for DeepSeek
  Flash the candidate routes are `deepseek-account` then `deepseek-official`.

### Commands, routes, slots

- Command names must match `^[a-z][a-z0-9_-]*$`. **No colons** — `english-buddy-today`,
  not `english-buddy:today`.
- A Host route is registered on the connection service:
  `connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })`.
  Routes under `/api` are owner-authenticated: a bare `curl` gets `401`, which is
  **not** evidence the route is missing.
- A Client entry is `window.__ModuleLoader__.load({ id, factory(require) {...} })`
  exporting `{ inject, apply(ctx) }`. Register into `conversation.composer.dock`
  with `ctx.slots.inject(...)`, style with `--dsw-alias-*` tokens, and keep
  `onMouseDown: event => event.preventDefault()` so the composer keeps focus.
- A Client bundle change needs a page refresh; a Host change needs the plugin row
  reloaded (disable → enable) or a restart.

### Persistence and diagnostics

- Session logs are not for plugin-owned data. Do not append new event types.
  `ctx.storageDomain` requires a zod-shaped `DomainSpec`; for small plugin state a
  JSONL file under `$DSH_HOME/<plugin>/` is simpler and has no import cost.
- Resolve the Harness home as `$DSH_HOME` → `~/.dsh`; never hard-code a path.
- Log through `ctx.logger('name')` (`debug|info|warn|error`) and keep a bounded
  record for the status route. A silent `catch` is a bug.

### Never port a Claude Code plugin verbatim

Claude Code's `.claude-plugin` format, `UserPromptSubmit` hooks, slash commands
and agents have no DSH equivalent to load. DSH bundles are npm/git packages with
`dsh.bundle.patch`; the equivalents are `agent/pre-step`, `ctx.commands`,
skills, and agent presets. Port behavior, not files.

## Adding a plugin

1. `plugins/<package-name>/` with `package.json` (`name` matching the directory,
   `type: "module"`, `dsh.bundle.patch`, optional `dsh.client`), `cordis.patch.yml`
   inserting one row, `locale/{zh,en}.json`, `docs/DETAIL{,.en}.md`, `icon.svg`,
   a `README.md`, and `test/`.
2. Add the package name to `ORDER` and `CATEGORY` in `scripts/build-index.mjs`.
3. `npm test`, then `npm run index`.
4. Install it locally and verify the behavior, not just the install result.

## Publishing

See `docs/PUBLISHING.md`. After pushing: `npm run index`, commit `index.json`,
push. A committed index must name the pushed commit — regenerating after a push
is not optional.
