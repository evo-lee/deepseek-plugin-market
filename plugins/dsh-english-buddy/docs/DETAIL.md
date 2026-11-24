# 英文提示教练

在模型看到你的 prompt 之前，用 `deepseek-flash` 过一遍：**英文纠错，中文改写成英文**，并把改动显示在输入框下方。目标是让 agent 拿到一条更准确的英文 prompt，同时让你看到自己哪里可以写得更好。

## 工作方式

每次提交 prompt，插件会先判断它属于哪种情况：

| 你的输入 | 发生了什么 | 模型看到 |
|---|---|---|
| 英文，有错 | 纠错，只改可追溯的错误 | 修正后的英文 |
| 英文，没错 | 什么都不做 | 你的原句 |
| 中文 / 中英混排 | 忠实地重述成英文，保留全部意图与细节，不新增要求 | 英文版 |
| `::` 开头 | 重写成结构更清晰的英文指令（唯一允许扩写、具体化的模式） | 重写后的版本 |
| `;;` 开头 | 原样放行，`;;` 被剥掉，不调用模型 | 你的原句（可保持中文） |

「沉默即正确」：当天没有任何改动时，输入框下方的药丸不出现。

## 两条硬约束

**1. 只改错，不替你优化。** 语法正确、标点正确、一遍能读懂的句子不做任何改动——哪怕存在「更优雅」的写法。不缩短、不为流畅度重排、不添加过渡、不升级语域。这是为了避免把「你的错误」变成「模型的改写」，让日报里出现的每一处改动都对应一个真实可学的错误。

**2. 每次改写都过 literal guard。** 从你的原始 prompt 里抽出反引号片段、带单位的数字、文件路径、代码标识符、命令行参数、引号内文本；任何一个没有逐字出现在改写结果里，**整次改写作废、原文照发**。这是机械底线，它能挡住「改写时悄悄丢掉一个约束」，但证明不了语义等价——所以 `;;` 才是最终逃生口。

## 表达建议（只提示，不改写）

中文重述与 `::` 重写时，模型会顺带指出至多 2 处「这句还缺点什么」，例如没有说明改哪个文件、没说明是否保留现有行为。它们只出现在药丸的悬停说明里，**不会进入模型看到的 prompt**，也不会改变你的原意。

## 药丸

- 当天有改动才出现：`✎ 修正 3 处` 或 `✎ 纠错 3 · 重述 2`。
- 悬停：今天最近 5 条改写，含逐词对照（`autentication → authentication   (spelling)`）与表达建议。
- 底部：今日英文提示数、更正率、无错数；失败次数与 literal 拦截次数。
- 点击立即刷新；后台每 15 秒刷新，页面隐藏时暂停。
- 没有可用的 DeepSeek 路由时显示 `✎ 纠错未启用`，悬停说明原因。

## 命令

| 命令 | 内容 |
|---|---|
| `/english-buddy-today` | 今日报告：英文提示数、更正数、更正率、无错数、中文重述数；最近 10 条改写；今日三课；表达建议 |
| `/english-buddy-stats` | 近 7 / 30 天更正率对比、最常犯的 5 个模式、literal 拦截次数 |

更正率的分母**只算英文提示**：中文重述不是错误，混进去指标就失去意义。

## 配置

改 `cordis.patch.yml` 里的 `english-buddy` 行：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `automatic` | `automatic` 处理所有可用 prompt；`onDemand` 只处理 `::`；`off` 完全关闭 |
| `authoritative` | `rewrite` | `rewrite`：模型只看到英文版；`original`：保留原句，把英文版作为附加上下文注入（上游插件的做法） |
| `strictness` | `standard` | `gentle` 只修明确错误；`strict` 也提示母语者会觉得别扭的写法 |
| `translate` | `auto` | `auto` 把中文改写成英文；`off` 中文原样通过 |
| `escapePrefix` | `;;` | 原样放行的前缀，`null` 关闭 |
| `provider` | `null` | 显式路由；`null` 表示自动探测 `deepseek-account` → `deepseek-official` |
| `model` | `deepseek-flash` | 教练模型 |
| `timeoutMs` | `4000` | 单次改写预算（100–30000）。这是上限，正常 0.8–2 秒 |
| `maxInputChars` | `4000` | 超过则跳过 |
| `maxOutputTokens` | `1600` | 输出上限 |
| `sampleRate` | `1` | 0–1，按 prompt 哈希确定性采样 |
| `domainTerms` | `[]` | 当作正确英文的专有名词，例如 `["MagicDNS", "Headscale"]` |
| `retentionDays` | `120` | 历史保留天数；`0` 表示完全不落盘 |
| `hints` | `true` | 是否请求「表达建议」（只显示） |

## 数据与隐私

- 需要发给 `deepseek-flash` 的内容：**你的 prompt 全文**。用的是你已经在 DSH 里配好的 DeepSeek 路由与凭据，不看单独的 API key。
- 历史落在 `$DSH_HOME/english-buddy/corrections-YYYY-MM-DD.jsonl`，每行一条，包含改写前后的文本。它和 DSH 自己的会话日志同级敏感，只在本机。`retentionDays: 0` 可以完全不落盘。
- 药丸通过本机回环的 `GET /api/english-buddy/state` 读取汇总，不发往浏览器以外的地方。
- 每次改写会作为一次辅助模型调用计入 usage 统计，`dsh-deepseek-meter` 的「今日 tok」会略微变大。

## 跳过什么

不会处理：斜杠命令、`$skill` 调用、10 字以下且不到 3 个词的碎片、以 URL / shell 命令 / 括号开头的片断、超过 `maxInputChars` 的 prompt、采样未命中的 prompt、子代理与注入上下文（只处理真人输入的 `source.kind === 'user'` 消息）。

## 失败可见性

出错时一律原样放行你的 prompt，但失败不会静默消失：每个降级路径都有稳定失败码，写进 Harness 日志，并在药丸悬停与 `/english-buddy-stats` 里显示最近一次。常见的有 `no-route`（没有可用的 DeepSeek 路由）、`prepare-failed`、`stream-failed`（请求中断）、`finish-max-tokens`（输出被截断）、`store-write-failed`（历史写不进盘）。插件自身逻辑出错记为 `listener-error`，并且永远不会影响这次提交。

## 已知限制

- 改写后 transcript 显示的是英文版，不是你原始的中文/错句；原文只保留在本地 JSONL 与药丸悬停里。想要「原文 + 英文版都给模型」，把 `authoritative` 改成 `original`。
- literal guard 是机械检查，挡不住「用词换了但意思变了」。发现改写丢信息时用 `;;` 旁路。
- 每次提交多 0.8–2 秒延迟。可以用 `sampleRate`、`onDemand`、`timeoutMs` 收紧。
- 命令在 action 描述里用的是连字符命名（`/english-buddy-today`），因为 DSH 的命令名不允许冒号。
- 本插件只覆盖纠错/重述这一条主干。上游的 `/review` 深度批改、`/drill` 刷题、`writing-guide` 技能与 4 个批改子代理尚未移植。

## 与上游的关系

模式划分、纠错规则、注释格式与 literal guard 的思路来自 [`xiaolai/english-buddy-for-claude`](https://github.com/xiaolai/english-buddy-for-claude)（ISC）。实现按 DeepSeek Harness 的 `agent/pre-step`、`ctx.llm`、slot 与命令接口重写，没有复用其 Claude Code hook 代码。
