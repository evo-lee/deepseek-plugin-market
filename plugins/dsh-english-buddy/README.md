# dsh-english-buddy

DeepSeek Harness 插件：在模型看到你的 prompt 之前，用 `deepseek-flash` 过一遍——**英文纠错，中文改写成英文**——并把改动显示在输入框下方。

```
你写：  把这个文件的错误处理改一下，别吞异常
模型收到：Fix the error handling in this file; do not swallow exceptions.
药丸：  ✎ 纠错 1 · 重述 1
```

- 走 `agent/pre-step`，在请求组装前替换消息文本；`prepareCall` 走本机已配好的 DeepSeek 路由，不需要第二个 API key。
- 只修可追溯的错误，不为「更优雅」改写；改写一律过 literal guard（代码、数字、路径、标识符、引号内容逐字保留），不过就原文照发。
- `::` 前缀进入重写模式（唯一允许扩写）；`;;` 前缀原样放行（需要保持中文时用）。
- 当天没有改动时药丸不出现；`/english-buddy-today`、`/english-buddy-stats` 出报告。

## 安装

已在 `desktop` profile 里安装。其它环境：**Plugins → Add plugin** 选择本目录，或

```sh
dsh plugin --profile desktop add ./dsh-english-buddy
```

Host 侧改动需要重启或重新启用插件行；客户端改动刷新页面即可。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 接线：校验配置、开历史存储、注册 pre-step 监听、两个命令、状态路由 |
| `pipeline.js` | 教练流水线：路由探测、辅助模型调用、pre-step 重写逻辑（与 Cordis 解耦，可离线测） |
| `diagnostics.js` | 降级记录：每个失败码各自的严重级别、去重、最近的失败窗口（供状态路由与药丸显示） |
| `coach.js` | 纯逻辑：模式判定、system prompt、输出解析、literal guard、词级 diff |
| `store.js` | 历史：按日 JSONL、容错读取、汇总、两个报告文本 |
| `client.js` | Client：向 `conversation.composer.dock` 注册纠错药丸 |
| `cordis.patch.yml` | 插入 `english-buddy` 插件行与默认配置 |
| `locale/{zh,en}.json` | 插件管理器标题、描述与详情页入口 |
| `docs/DETAIL.md` / `DETAIL.en.md` | 详情页正文 |
| `test/*.test.mjs` | 离线测试（`node test/coach.test.mjs`、`node test/store.test.mjs`） |

## 测试

```sh
node test/coach.test.mjs   # 模式判定、prompt、解析、literal guard、重写流水线（桩 llm）
node test/store.test.mjs   # JSONL、容错读取、汇总、保留期、报告文本
```

不联网，不需要凭据。

## 失败可见性

插件对用户 prompt 一律 fail-open（出错就原样放行，绝不阻断），但**没有一处失败是静默的**：每个降级路径都有稳定失败码，写进 Harness 日志，并在药丸悬停与 `/english-buddy-stats` 里显示最近一次。

| 失败码 | 含义 | 日志级别 |
|---|---|---|
| `no-route` | 没有可用的 DeepSeek 路由 | debug（每分钟去重） |
| `route-probe-failed` | 探测模型目录时出错 | debug |
| `prepare-failed` | `prepareCall` 失败（凭据/路由/能力） | warn |
| `thinking-required` | 该路由无法关闭思考 | warn |
| `stream-failed` | 流式请求中断或抛错 | warn |
| `finish-error` / `finish-aborted` / `finish-max-tokens` / `finish-missing` | 模型没以 `stop` 结束 | warn |
| `non-text-output` | 输出里含思考或工具调用块 | warn |
| `empty-output` / `unparsable-output` / `output-limit` | 输出不可用或超长 | warn |
| `aborted` | 用户取消，不算失败 | debug |
| `store-init-failed` / `store-read-failed` / `store-write-failed` / `store-prune-failed` | 历史读写问题 | warn |
| `store-parse-failed` | 某行 JSON 损坏（跳过该行） | debug |
| `listener-error` | 插件自身逻辑出错 | error |

## 已知限制

- transcript 里显示的是英文版，原文只留在本地 JSONL 与药丸悬停；要两者都给模型，把 `authoritative` 改成 `original`。
- literal guard 是机械检查，挡不住「换了词但意思变了」；这种时候用 `;;`。
- 每次提交多 0.8–2 秒；可用 `sampleRate`、`onDemand`、`timeoutMs` 收紧。
- 只移植了纠错/重述主干；上游的 `/review`、`/drill`、`writing-guide` 技能与批改子代理未包含。
- 规则与格式参考 [`xiaolai/english-buddy-for-claude`](https://github.com/xiaolai/english-buddy-for-claude)（ISC），实现按 DSH 接口重写。
