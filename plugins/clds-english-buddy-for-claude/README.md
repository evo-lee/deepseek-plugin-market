# clds-english-buddy-for-claude

给 **用 `clds` 跑 Claude Code、模型走 DeepSeek** 的人用的英文教练插件。它在你提交 prompt 时做一件事：

- 英文有错 → 给出最小纠错，并在输入框下方显示改了什么；
- 中文/非英文 → 译成英文，再让模型按英文理解；
- `::` 开头 → 把粗糙想法重写成一个精确的 prompt；
- `;;` 开头 → 跳过教练，原文照发；
- 当天/长期数据 → 用脚本生成报表，模型只负责展示。

原有 [`xiaolai/english-buddy-for-claude`](https://github.com/xiaolai/english-buddy-for-claude) 的规则和技能仍然沿用；这个插件主要改造的是**它是怎么调用 DeepSeek 的**，以及**报表为什么不再让模型算**。

## 为什么原版在 clds 下不好用

`clds` 启动 Claude Code 时是这么设置环境的：

```sh
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY
ANTHROPIC_MODEL=deepseek-flash
CLAUDE_CONFIG_DIR=~/.claude-deepseek
```

而上游插件的 hook 只认 `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / macOS keychain：

| 上游行为 | 在 clds 下的结果 |
|---|---|
| 只读 `ANTHROPIC_API_KEY` | clds 明确 unset 了它 → 报 “no credentials”，完全不纠错 |
| 回退到 macOS keychain | 可能把 Anthropic 的 OAuth token 发到 `api.deepseek.com` → 401，且有凭据外发风险 |
| 默认模型 `claude-haiku-*` | DeepSeek 会映射成 `deepseek-flash`，但 `doctor` 和日志里看不出真实模型 |
| 报表让模型读 JSONL 再算数 | DeepSeek 擅长的不是精确算术；日期、百分比、pattern 排名容易漂 |
| 配置写在 `~/.claude/hooks/` | clds 使用隔离的 `~/.claude-deepseek`，读不到 |
| 依赖 `Task` 子代理做 review | 多一层编排，模型不同就会放大格式漂移 |
| README 说“模型只看到英文版” | Claude Code 的 `UserPromptSubmit` hook **没有**替换 prompt 的能力；模型会同时看到原文和纠错 |

## 这个版本怎么改的

| 环节 | 改法 |
|---|---|
| 凭据 | 依次读 `ANTHROPIC_AUTH_TOKEN`（clds 的 DeepSeek key）→ `ANTHROPIC_API_KEY` → `DEEPSEEK_API_KEY` → `~/.config/claude-driven-ai-providers/deepseek-api-key`；**只有**目标是 `api.anthropic.com` 时才碰 keychain |
| 端点 | 直接复用 `ANTHROPIC_BASE_URL`，拼出 `.../v1/messages`；DeepSeek 默认 `https://api.deepseek.com/anthropic` |
| 模型 | 显式用 `deepseek-flash`（可从 `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_MODEL` 推导，去掉 `[1m]` 后缀），不再把 Claude 名字当默认值 |
| 思考 | DeepSeek 端点显式 `thinking: {type: "disabled"}`，避免 thinking block 和额外延迟 |
| 超时 | DeepSeek 默认 12s（上游 5s），可配 1–30s |
| 输出解析 | 新的 `CORRECTED:` / `ANNOTATIONS:` 契约，兼容上游“首行 + 空行”旧格式；容忍 code fence、bullet、`→`/`->`/`=>` |
| 安全护栏 | 代码、路径、URL、flag、数字、camelCase/snake_case 标识符必须逐字保留；不过就丢弃纠错、原文照发 |
| 报表 | `report.mjs` 从 JSONL 直接算 Markdown；命令用 `!` 注入脚本输出，模型只展示，不重算 |
| 配置 | 读 `$CLAUDE_CONFIG_DIR/hooks/prompt_coach.json`，并回退读取 `~/.claude/hooks/prompt_coach.json` |
| 诊断 | `/clds-english-buddy-for-claude:doctor` 显示端点、凭据来源、模型、数据目录，`--probe` 做一次真实小请求 |
| 失败 | 一律 fail-open（不阻断 prompt），但每次失败都有稳定失败码、`systemMessage` 提示和 metrics 记录 |

> **诚实说明**：Claude Code 的 `UserPromptSubmit` hook 只能追加 `additionalContext`，不能替换用户原文。模型会同时看到你打的字和纠错后的 reading。本插件在上下文里明确要求“以纠错后的 reading 为准，同时逐字保留代码/路径/数字”，这是 Claude Code 能做到的最好版本。

## 安装到 clds 配置

`clds` 使用独立 profile `~/.claude-deepseek`，插件必须装进这个 profile。

### 方式一：本地 marketplace（推荐）

仓库根有 `.claude-plugin/marketplace.json`。在仓库目录执行：

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-deepseek" \
  claude plugin marketplace add "$PWD"

CLAUDE_CONFIG_DIR="$HOME/.claude-deepseek" \
  claude plugin install clds-english-buddy-for-claude@litang-deepseek-plugin-market
```

然后**退出并重新启动 `clds`**（插件 hook 在启动时加载）。

### 方式二：在 clds 里用 `/plugin`

```text
/plugin marketplace add /绝对路径/deepseek-plugin-market
/plugin install clds-english-buddy-for-claude@litang-deepseek-plugin-market
```

重启 clds。

### 验证

```text
/clds-english-buddy-for-claude:doctor --probe
```

应该看到：

- `Provider family` = `deepseek`
- `Messages endpoint` = `https://api.deepseek.com/anthropic/v1/messages`
- `Credential source` = `env:ANTHROPIC_AUTH_TOKEN`（或 key file）
- `Model` = `deepseek-flash`
- `Live Probe` = `PASS`

`doctor` 不会打印 key，只打印凭据来源。

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
| `/clds-english-buddy-for-claude:today` | 今天的纠错报表、重复 pattern、focus areas、趋势 |
| `/clds-english-buddy-for-claude:stats --days 30` | 长期错误率、Top 10、周趋势 |
| `/clds-english-buddy-for-claude:mistakes --top 20` | 全时段高频错误 |
| `/clds-english-buddy-for-claude:config --show` | 查看合并后的配置 |
| `/clds-english-buddy-for-claude:config --set strictness=strict` | 写项目配置 `.english-buddy.json` |
| `/clds-english-buddy-for-claude:config --global --set summary_language=Chinese` | 写 profile 全局配置 |
| `/clds-english-buddy-for-claude:preview <text>` | 干跑：只显示会怎么改，不提交、不记历史 |
| `/clds-english-buddy-for-claude:review <text or --file path>` | 单次深度 review，输出 Markdown |
| `/clds-english-buddy-for-claude:drill` | 用你的高频错误做填空练习 |
| `/clds-english-buddy-for-claude:doctor [--probe]` | 诊断端点、凭据、模型、数据目录 |

## 配置

优先级：项目 `.english-buddy.json` > `$CLAUDE_CONFIG_DIR/hooks/prompt_coach.json` > `~/.claude/hooks/prompt_coach.json`（旧版）> 默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `coaching_mode` | `automatic` | `on-demand` 时只处理 `::` |
| `auto_correct` | `true` | `false` 时自动纠错/翻译都跳过（`::` 仍可用） |
| `strictness` | `standard` | `gentle` / `standard` / `strict` |
| `sample_rate` | `1` | 0–1，自动模式的抽样比例 |
| `timeout_seconds` | provider 默认 | DeepSeek 12s，可设 1–30 |
| `max_input_chars` | `8000` | 超长输入跳过教练 |
| `summary_language` | `null` | 设成 `Chinese` 等，让模型在回复末尾加一段摘要 |
| `domain_terms` | `[]` | 必须原样保留的专有名词，三层合并 |
| `escape_prefix` | `;;` | 跳过教练的前缀 |
| `notify_on_failure` | `true` | 失败时显示 `systemMessage` |
| `model` | provider 默认 | 覆盖教练模型，例如 `deepseek-v4-pro` |

环境变量覆盖：

```sh
CLDS_ENGLISH_BUDDY_MODEL=deepseek-v4-pro
CLDS_ENGLISH_BUDDY_TIMEOUT_SECONDS=15
CLDS_ENGLISH_BUDDY_THINKING=enabled   # 默认 disabled
CLDS_ENGLISH_BUDDY_BASE_URL=...       # 显式端点
CLDS_ENGLISH_BUDDY_TOKEN=...          # 显式 token（不建议写进 shell 历史）
CLDS_ENGLISH_BUDDY_DISABLE_KEYCHAIN=1 # 测试用
```

## 失败码

所有失败都 fail-open，且写进 `%CLAUDE_PLUGIN_DATA%/coaching-metrics.jsonl`：

| 失败码 | 含义 |
|---|---|
| `no-credentials` | 没找到 DeepSeek/Anthropic 凭据 |
| `oauth-expired` | Anthropic keychain token 过期 |
| `invalid-base-url` | 端点不是 https/loopback，或含凭据/query |
| `auth` | 端点返回 401/403 |
| `rate-limited` | 429 |
| `upstream-error` | 5xx |
| `timeout` | 超过 `timeout_seconds` |
| `network` | 连接/读取失败 |
| `non-text-output` | 只返回了 thinking/tool block |
| `max-tokens` | 输出被截断 |
| `literal-changed` | 纠错改了代码/路径/数字，已丢弃 |
| `unparsable-output` | 输出不符合契约 |
| `empty-output` | 空响应 |

## 数据与隐私

- 历史在 `$CLAUDE_PLUGIN_DATA/history/YYYY-MM-DD.jsonl`；clds 下通常在 `~/.claude-deepseek/plugins/data/...`。
- 你的 prompt 会被发到 `ANTHROPIC_BASE_URL` 指向的端点（clds 下就是 DeepSeek）。这和主模型本来就在用的地址相同，没有新增第三方。
- `doctor` 只显示凭据**来源**，不显示值。
- 非 Anthropic 端点永远不会读取 macOS keychain 里的 Anthropic OAuth token。

## 测试

```sh
cd plugins/clds-english-buddy-for-claude
node --test test/*.test.mjs
```

43 个用例，全部离线：provider 解析、语言检测、注解解析、literal guard、hook 端到端（本地 HTTP 桩）、报表、配置。不需要网络或凭据。

## 已知限制

- Claude Code 不能替换用户原文；模型看到原文 + 纠错 reading。`::` / `;;` 同理，是上下文提示而不是原文替换。
- literal guard 是机械检查，挡不住“词换了、意思变了”；这种时候用 `;;` 或 `preview` 先看。
- 每次自动纠错多约 0.5–2s 和一次小模型调用；可用 `sample_rate`、`coaching_mode=on-demand`、`timeout_seconds` 收紧。
- `review` 是单次模型调用，不再用上游的多子代理编排；换来的是更稳定的格式和更少的 token。
- 只移植了纠错/翻译/精炼/报表/review/drill；上游的 `writing-guide` 五个参考技能已包含，`.claude/rules` 没有作为运行时规则加载。

## 许可与来源

ISC。教练规则、输出格式和五个参考技能改编自 [`xiaolai/english-buddy-for-claude`](https://github.com/xiaolai/english-buddy-for-claude)（ISC，Copyright © 2026 Xiaolai Li）。DeepSeek/clds 适配、确定性报表、provider 解析和测试由本仓库维护。
