# deepseek-plugin-market

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件市场，同时收纳一个给 **clds**（Claude Code + DeepSeek）使用的 Claude Code 插件：

- 仓库根是 DSH 的 **插件索引**（`index.json`，`format: 1`）；在 DSH 里打开 **Plugins → Discover → Add index source**，填入发布后的 `index.json` 地址即可浏览与安装。
- 根目录的 `.claude-plugin/marketplace.json` 是 Claude Code marketplace；clds profile 可以本地添加本仓库并安装英文教练。

## 收录的插件

| 插件 | 格式 | 作用 |
|---|---|---|
| [`dsh-english-buddy`](plugins/dsh-english-buddy/) | DSH | 在模型看到之前把 prompt 纠错或改写成英文（中文→英文、`::` 重写、`;;` 原样放行），输入框下方显示今天改了什么，`/english-buddy-today` 出日报 |
| [`dsh-deepseek-meter`](plugins/dsh-deepseek-meter/) | DSH | 输入框下方显示 DeepSeek 账户余额与今日 token 用量，悬停看明细，点击刷新 |
| [`clds-english-buddy-for-claude`](plugins/clds-english-buddy-for-claude/) | Claude Code | 在 clds/DeepSeek 下纠错、翻译、`::` 精炼；用 DeepSeek 的 Anthropic 兼容端点，不需要第二个 key；报表由脚本算，模型只展示 |

三个插件都是纯 JS、零运行时依赖。DSH 的两个只用 `node:*` 与 DSH 服务；clds 插件只用 `node:*` 与 Claude Code 的 hook/命令接口。

> `plugins/` 下可能同时有 DSH 插件和 Claude Code 插件。`scripts/build-index.mjs` 只索引带 `dsh.bundle.patch` 的目录；Claude Code 插件不会出现在 DSH 的 Discover 里。

## 目录结构

```
.
├── index.json                  # DSH 插件索引（脚本生成，勿手改）
├── .claude-plugin/marketplace.json  # Claude Code marketplace（clds 插件）
├── scripts/build-index.mjs     # 从带 dsh.bundle.patch 的插件生成索引
├── plugins/
│   ├── dsh-english-buddy/      # DSH 插件，自带 README / docs / locale / icon / test
│   ├── dsh-deepseek-meter/     # DSH 插件
│   └── clds-english-buddy-for-claude/  # Claude Code 插件（clds），不进 DSH 索引
├── docs/PUBLISHING.md          # 发到 GitHub 的步骤
├── AGENTS.md                   # 给 AI 编码代理的仓库约定与 DSH 事实
└── package.json                # 只有脚本入口，无依赖
```

## 本地安装

插件可以直接从本仓库目录装进某个 profile：

```sh
dsh plugin --profile desktop add ./plugins/dsh-english-buddy
dsh plugin --profile desktop add ./plugins/dsh-deepseek-meter
```

或者用 GUI：**Plugins → Add plugin** 选目录。开发时用 `link:` 装一次，之后改代码只需重启或重新启用插件行。

### clds 插件安装

`clds` 使用隔离 profile `~/.claude-deepseek`，所以要装进那个 profile：

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-deepseek" \
  claude plugin marketplace add "$PWD"

CLAUDE_CONFIG_DIR="$HOME/.claude-deepseek" \
  claude plugin install clds-english-buddy-for-claude@litang-deepseek-plugin-market
```

然后重启 `clds`，在会话里运行 `/clds-english-buddy-for-claude:doctor --probe` 验证。详见插件自己的 [README](plugins/clds-english-buddy-for-claude/README.md)。

## 生成索引

```sh
npm run index                       # 读 origin 远程，写 index.json
node scripts/build-index.mjs --repo-url https://github.com/<owner>/deepseek-plugin-market
```

没有 git 远程时脚本会报错并给出命令——因为索引里的 `source.url` 必须是绝对地址、`source.commit` 必须是精确的 40 位 sha，编不出来也不能编。

索引里每个版本长这样：

```json
{
  "version": "0.1.0",
  "publishTimestamp": 1795496325,
  "source": {
    "type": "git",
    "url": "https://github.com/<owner>/deepseek-plugin-market",
    "commit": "<40-hex>",
    "path": "plugins/dsh-english-buddy"
  }
}
```

## 测试

```sh
npm test
```

全部离线：`dsh-english-buddy` 的提示改写与历史存储（46 个断言级用例）、`dsh-deepseek-meter` 的状态路由，以及 `clds-english-buddy-for-claude` 的 43 个用例（provider 解析、语言检测、注解、literal guard、hook 端到端、报表、配置）。clds 插件的 hook 测试用本地 HTTP 桩，不联网、不需要凭据。

## 发布

见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。最短路径：

```sh
gh repo create deepseek-plugin-market --public --source . --remote origin --push
npm run index
git add index.json && git commit -m "chore: publish index" && git push
```

之后把 `https://raw.githubusercontent.com/<owner>/deepseek-plugin-market/main/index.json` 加进 DSH 的 Discover。

## 许可

ISC。`dsh-english-buddy` 与 `clds-english-buddy-for-claude` 的教练规则、输出格式与参考技能参考 [`xiaolai/english-buddy-for-claude`](https://github.com/xiaolai/english-buddy-for-claude)（ISC，Copyright © 2026 Xiaolai Li）；前者按 DSH 接口重写，后者按 Claude Code/clds 接口重写。
