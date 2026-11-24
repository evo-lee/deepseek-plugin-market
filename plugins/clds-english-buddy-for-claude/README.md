# clds-english-buddy-for-claude

给**用 `clds`、`clkc` 等 clai 启动器跑 Claude Code** 的人用的英文教练插件。默认适配 `clds` + DeepSeek，也支持 `clkc`（Kimi Code）、`clki`（Kimi/Moonshot）、`clmm`（MiniMax）、`clza`（Z.AI）以及任何通过 `ANTHROPIC_BASE_URL` 暴露 Anthropic Messages 端点的 clai provider。

它在提交 prompt 时做一件事：

- 英文有错 → 给出最小纠错，并在输入框下方显示改了什么；
- 中文/非英文 → 译成英文，再让模型按英文理解；
- `::` 开头 → 把粗糙想法重写成一个精确的 prompt；
- `;;` 开头 → 跳过教练，原文照发；
- 当天/长期数据 → 用脚本生成报表，模型只负责展示。

上游 [`xiaolai/english-buddy-for-claude`](https://github.com/xiaolai/english-buddy-for-claude) 的规则、六个技能和输出格式继续沿用。这个插件主要改造的是**它如何识别 clai 的凭据和端点**，以及**哪些部分交给脚本而不是模型**。

## 支持范围

已实机验证：

| 启动器 | provider | 凭据 | 端点 | 特殊处理 |
|---|---|---|---|---|
| `clds` | DeepSeek | `ANTHROPIC_AUTH_TOKEN`（Bearer） | `https://api.deepseek.com/anthropic/v1/messages` | `thinking: disabled`，12s，默认 `deepseek-flash` |
| `clkc` | Kimi Code | `ANTHROPIC_API_KEY`（x-api-key，也接受 Bearer） | `https://api.kimi.com/coding/v1/messages` | thinking 不可关闭；`effort: low`，30s，`max_tokens` ≥ 4096 |

按 Anthropic Messages 协议适配、未逐一实机验证：`clki`（Kimi/Moonshot，`https://api.moonshot.ai/anthropic/v1/messages`，Bearer，thinking 不可关闭，30s）、`clmm`（MiniMax）、`clza`（Z.AI）、`cldls`、`cllm`、`clol`、`clms`。它们的凭据按 `ANTHROPIC_AUTH_TOKEN` → Bearer、`ANTHROPIC_API_KEY` → x-api-key 解析。

`clcd`、`cloa`、`clgr`、`clgm` 走 Codex/Responses/Chat 协议。如果本地桥没有暴露 Anthropic Messages 端点，本插件不适用；`doctor` 会把它们显示为 `compatible`，能不能用取决于桥本身。

## 为什么原版在这些环境下不好用

`clds` 启动 Claude Code 时设置：

```sh
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY
ANTHROPIC_MODEL=deepseek-flash
CLAUDE_CONFIG_DIR=~/.claude-deepseek
```

`clkc` 则是另一套：

```sh
ANTHROPIC_BASE_URL=https://api.kimi.com/coding/
ANTHROPIC_API_KEY=$KIMI_CODE_API_KEY
ANTHROPIC_MODEL=k3.1-pro
CLAUDE_CONFIG_DIR=~/.claude-kimi-code
```

上游 hook 只认 `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / macOS keychain：

| 上游行为 | 在这些 profile 下的结果 |
|---|---|
| 不读 `ANTHROPIC_AUTH_TOKEN` | clds / clki 报 “no credentials”，完全不纠错 |
| 回退到 macOS keychain | 可能把 Anthropic 的 OAuth token 发到 DeepSeek/Kimi → 401，且有凭据外发风险 |
| 默认模型固定为 `claude-haiku-*` | clds 下会被映射，但 `doctor` 和日志看不出真实模型；Kimi 下则可能不是你想要的速度/价格 |
| 配置写在 `~/.claude/hooks/` | `~/.claude-deepseek`、`~/.claude-kimi-code` 都是隔离 profile，读不到 |
| `today` 让模型渲染统计表格 | 数据本身由脚本算，但表格、排名、lesson 由模型重写，换模型后容易漂 |
| 默认 5s 超时 | DeepSeek 通常够，Kimi Code 的强制 thinking 经常超过 5s |

## 这个版本怎么改的

| 环节 | 改法 |
|---|---|
| 凭据 | `ANTHROPIC_AUTH_TOKEN` → Bearer；`ANTHROPIC_API_KEY` → x-api-key（`sk-ant-oat` 例外，走 Bearer）；显式 token 可覆盖。**DeepSeek key 只在 DeepSeek 端点使用**；keychain 只对 `api.anthropic.com` 使用 |
| 端点 | 复用 `ANTHROPIC_BASE_URL`，统一拼 `/v1/messages`；裸 `api.deepseek.com` 自动补 `/anthropic` |
| provider 识别 | 按 hostname 区分 `deepseek` / `anthropic` / `kimi-code` / `kimi` / `compatible`，不同 family 使用不同的超时、thinking、effort、`max_tokens` |
| 模型 | 显式 env > 配置 `model` > `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_MODEL`；去掉 `[1m]`；DeepSeek 的 Claude 名字回落到 `deepseek-flash` |
| 思考 | DeepSeek 显式 `thinking: disabled`；Kimi K3/K3.1 Pro 不接受关闭思考，因此不发送 `thinking` 字段 |
| Kimi 延迟 | Kimi Code 发送 `output_config: {effort: "low"}`，并把 `max_tokens` 下限设为 4096（thinking 也占额度） |
| 超时 | DeepSeek 12s、Anthropic 5s、Kimi 30s、其他兼容端点 12s，可配 1–30s |
| 输出解析 | `CORRECTED:` / `ANNOTATIONS:` 契约，兼容上游“首行 + 空行”旧格式；容忍 code fence、bullet、`→`/`->`/`=>` |
| 安全护栏 | 代码、路径、URL、flag、数字、camelCase/snake_case 标识符必须逐字保留；不过就丢弃纠错、原文照发 |
| 报表 | `report.mjs` 从 JSONL 直接算 Markdown；`today` 包含确定性的 Lessons of the Day；命令用 `!` 注入，模型只展示 |
| `review` | 恢复上游做法：由**宿主模型**用 `Read` / `AskUserQuestion` 单次深度 review，不再额外调用教练端点 |
| 配置 | 读 `$CLAUDE_CONFIG_DIR/hooks/prompt_coach.json`，并回退读取 `~/.claude/hooks/prompt_coach.json` |
| 诊断 | `doctor` 显示端点、family、模型、thinking、effort、凭据来源、数据目录；`--probe` 做一次真实小请求 |
| 失败 | 一律 fail-open（不阻断 prompt），但每次失败都有稳定失败码、`systemMessage` 提示和 metrics 记录 |

> **诚实说明**：Claude Code 的 `UserPromptSubmit` hook 只能追加 `additionalContext`，不能替换用户原文。模型会同时看到你打的字和纠错后的 reading。本插件在上下文里明确要求“以纠错后的 reading 为准，同时逐字保留代码/路径/数字”。上游代码也是这个机制；其 README 的“Claude sees the corrected version”不是字面意义上的替换。

## 安装到任意 clai profile

插件本身与 provider 无关，装进哪个 profile 就服务哪个启动器。先选 profile：

```sh
PROFILE="$HOME/.claude-deepseek"    # clds
# PROFILE="$HOME/.claude-kimi-code" # clkc
# PROFILE="$HOME/.claude-kimi"      # clki
```

然后在仓库根目录执行：

```sh
CLAUDE_CONFIG_DIR="$PROFILE" \
  claude plugin marketplace add "$PWD"

CLAUDE_CONFIG_DIR="$PROFILE" \
  claude plugin install clds-english-buddy-for-claude@litang-deepseek-plugin-market
```

也可以在该 profile 的 Claude Code 里用 `/plugin marketplace add <绝对路径>` 和 `/plugin install ...`。安装后**退出并重新启动对应的启动器**（hook 在启动时加载）。

插件名保留 `clds-` 前缀是为了安装地址稳定；它并不只适用于 clds。

### 验证

```text
/clds-english-buddy-for-claude:doctor --probe
```

`clds` 下应看到：

- `Provider family` = `deepseek`
- `Messages endpoint` = `https://api.deepseek.com/anthropic/v1/messages`
- `Credential source` = `env:ANTHROPIC_AUTH_TOKEN`（或 key file）
- `Model` = `deepseek-flash`，`Thinking` = `disabled`，`Timeout` = `12s`
- `Live Probe` = `PASS`

`clkc` 下应看到：

- `Provider family` = `kimi-code`
- `Messages endpoint` = `https://api.kimi.com/coding/v1/messages`
- `Credential source` = `env:ANTHROPIC_API_KEY`，`Auth scheme` = `x-api-key`
- `Model` = `k3.1-pro`，`Thinking` = `not-sent`，`Effort` = `low`，`Max output tokens` = `4096`，`Timeout` = `30s`
- `Live Probe` = `PASS`

`doctor` 不会打印 key，只打印凭据来源。

## Kimi 的延迟

Kimi K3.1 Pro 和 K3 系列**只支持思考模式**，关闭思考会返回 400。因此即使 `effort=low`，一次自动纠错通常也要 3–8 秒。默认仍是 `coaching_mode=automatic`，但建议按需选择：

```text
/clds-english-buddy-for-claude:config --global --set coaching_mode=on-demand
```

`on-demand` 只处理 `::` 开头的 prompt；也可以用 `sample_rate` 抽样。若你的 Kimi Code 套餐提供 `kimi-for-coding`（K2.8 Preview），实测同样任务约 4 秒，可以把它当作教练模型：

```sh
ENGLISH_BUDDY_MODEL=kimi-for-coding
```

不要指望把 `thinking` 设成 `disabled` 来提速——Kimi 会直接拒绝。

## 使用

| 你输入 | 会发生什么 |
|---|---|
| `refactor the autentication modul, its got too many responsibilties` | 显示 `User intends to say: refactor the authentication module...`，模型按纠错后的意思执行 |
| `把这个文件的错误处理改一下，别吞异常` | 显示 `Translated (Chinese): Fix the error handling in this file...` |
| `:: 帮我看看项目结构，给出改进建议` | 显示 `Refined: ...`，模型按精炼后的 prompt 执行 |
| `;; 这行保持中文` | 不调用教练，只提示模型忽略开头的 `;;` |
| `/help`、`!npm test`、URL、代码块 | 跳过，不调用模型 |

干净的 prompt **不会**产生任何提示：沉默就是正确。

## 命令

插件命令都带命名空间前缀：

| 命令 | 作用 |
|---|---|
| `/clds-english-buddy-for-claude:today` | 今天的纠错报表、重复 pattern、Lessons of the Day、趋势 |
| `/clds-english-buddy-for-claude:stats --days 30` | 长期错误率、Top 10、周趋势 |
| `/clds-english-buddy-for-claude:mistakes --top 20` | 全时段高频错误 |
| `/clds-english-buddy-for-claude:config --show` | 查看合并后的配置 |
| `/clds-english-buddy-for-claude:config --set strictness=strict` | 写项目配置 `.english-buddy.json` |
| `/clds-english-buddy-for-claude:config --global --set summary_language=Chinese` | 写 profile 全局配置 |
| `/clds-english-buddy-for-claude:preview <text>` | 干跑：只显示会怎么改，不提交、不记历史 |
| `/clds-english-buddy-for-claude:review <text or path>` | 宿主模型单次深度 review，可用 `Read` 读文件 |
| `/clds-english-buddy-for-claude:drill` | 用你的高频错误做填空练习 |
| `/clds-english-buddy-for-claude:doctor [--probe]` | 诊断端点、凭据、模型、thinking/effort、数据目录 |

## 配置

优先级：项目 `.english-buddy.json` > `$CLAUDE_CONFIG_DIR/hooks/prompt_coach.json` > `~/.claude/hooks/prompt_coach.json`（旧版）> 默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `coaching_mode` | `automatic` | `on-demand` 时只处理 `::` |
| `auto_correct` | `true` | `false` 时自动纠错/翻译都跳过（`::` 仍可用） |
| `strictness` | `standard` | `gentle` / `standard` / `strict` |
| `sample_rate` | `1` | 0–1，自动模式的抽样比例 |
| `timeout_seconds` | provider 默认 | DeepSeek 12s、Kimi 30s、Anthropic 5s，可设 1–30 |
| `effort` | provider 默认 | 仅 Kimi Code：`low` / `high` / `max` / `none` |
| `max_input_chars` | `8000` | 超长输入跳过教练 |
| `summary_language` | `null` | 设成 `Chinese` 等，让模型在回复末尾加一段摘要 |
| `domain_terms` | `[]` | 必须原样保留的专有名词，三层合并 |
| `escape_prefix` | `;;` | 跳过教练的前缀 |
| `notify_on_failure` | `true` | 失败时显示 `systemMessage` |
| `model` | provider 默认 | 覆盖教练模型，例如 `deepseek-v4-pro`、`kimi-for-coding` |

环境变量优先级：`ENGLISH_BUDDY_*` > `CLAUDE_ENGLISH_BUDDY_*` > `CLDS_ENGLISH_BUDDY_*`。

```sh
ENGLISH_BUDDY_MODEL=deepseek-v4-pro
ENGLISH_BUDDY_TIMEOUT_SECONDS=15
ENGLISH_BUDDY_THINKING=enabled      # DeepSeek only；默认 disabled
ENGLISH_BUDDY_EFFORT=low            # Kimi Code only；默认 low
ENGLISH_BUDDY_BASE_URL=...          # 显式端点
ENGLISH_BUDDY_TOKEN=...             # 显式 token（不建议写进 shell 历史）
ENGLISH_BUDDY_AUTH_SCHEME=x-api-key # bearer | x-api-key
ENGLISH_BUDDY_DISABLE_KEYCHAIN=1    # 测试用
```

## 失败码

所有失败都 fail-open，且写进 `$CLAUDE_PLUGIN_DATA/coaching-metrics.jsonl`：

| 失败码 | 含义 |
|---|---|
| `missing-base-url` | clai profile 没有提供 `ANTHROPIC_BASE_URL`（失败关闭，不猜测 provider） |
| `no-credentials` | 当前 provider 没有可用凭据 |
| `no-model` | 端点有凭据但解析不出模型 |
| `oauth-expired` | Anthropic keychain token 过期 |
| `invalid-base-url` | 端点不是 https/loopback，或含凭据/query |
| `auth` | 端点返回 401/403 |
| `rate-limited` | 429 |
| `upstream-error` | 5xx |
| `not-found` | 404（端点或模型名不对） |
| `bad-request` | 400/422（例如请求了该 provider 不支持的参数） |
| `timeout` | 超过 `timeout_seconds` |
| `network` | 连接/读取失败 |
| `non-text-output` | 只返回了 thinking/tool block |
| `max-tokens` | 输出被截断 |
| `literal-changed` | 纠错改了代码/路径/数字，已丢弃 |
| `unparsable-output` | 输出不符合契约 |
| `empty-output` | 空响应 |

## 数据与隐私

- 历史在 `$CLAUDE_PLUGIN_DATA/history/YYYY-MM-DD.jsonl`；clds 下通常在 `~/.claude-deepseek/plugins/data/...`，clkc 下在 `~/.claude-kimi-code/plugins/data/...`。
- 你的 prompt 会被发到 `ANTHROPIC_BASE_URL` 指向的端点——也就是当前启动器本来就在用的 provider，没有新增第三方。
- `doctor` 只显示凭据**来源**，不显示值。
- 非 Anthropic 端点永远不会读取 macOS keychain 里的 Anthropic OAuth token。
- DeepSeek 的 key 或 key file 只会发给 DeepSeek 端点；不会因为文件存在就发给 Kimi 或 Anthropic。

## 测试

```sh
cd plugins/clds-english-buddy-for-claude
node --test test/*.test.mjs
```

52 个用例，全部离线：provider 解析（含 clds/clkc/clki 环境）、凭据隔离、manifest/marketplace 一致性、语言检测、注解解析、literal guard、hook 端到端（本地 HTTP 桩）、报表、配置。不需要网络或凭据。

## 已知限制

- Claude Code 不能替换用户原文；模型看到原文 + 纠错 reading。`::` / `;;` 同理，是上下文提示而不是原文替换。
- literal guard 是机械检查，挡不住“词换了、意思变了”；这种时候用 `;;` 或 `preview` 先看。
- DeepSeek 每次自动纠错约 0.5–2s；Kimi 因强制 thinking 通常 3–8s，可用 `coaching_mode=on-demand`、`sample_rate`、`ENGLISH_BUDDY_MODEL` 收紧。
- `/review` 使用宿主模型，因此在 clds 下就是 DeepSeek、在 clkc 下就是 Kimi；它不再额外调用教练端点，也不需要第二份凭据。
- 上游的 4 个 agents、`.claude/rules`、`evals/`、Codex 适配、Bedrock/Vertex/Foundry 分支没有移植；它们与 clai + Anthropic Messages 的运行时无关。

## 许可与来源

ISC。教练规则、输出格式和六个参考技能改编自 [`xiaolai/english-buddy-for-claude`](https://github.com/xiaolai/english-buddy-for-claude)（ISC，Copyright © 2026 Xiaolai Li）。clai provider 适配（clds/DeepSeek、clkc/Kimi Code、clki/Kimi）、确定性报表、`review` 恢复宿主模型、provider 解析和测试由本仓库维护。
