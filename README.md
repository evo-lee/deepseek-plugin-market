# deepseek-plugin-market

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件市场：仓库根是一个 **插件索引**（`index.json`，DSH 的 `format: 1` 格式），`plugins/` 下是索引里列出的插件源码本体。

在 DSH 里打开 **Plugins → Discover → Add index source**，填入发布后的 `index.json` 地址即可浏览与安装。

## 收录的插件

| 插件 | 作用 |
|---|---|
| [`dsh-english-buddy`](plugins/dsh-english-buddy/) | 在模型看到之前把 prompt 纠错或改写成英文（中文→英文、`::` 重写、`;;` 原样放行），输入框下方显示今天改了什么，`/english-buddy-today` 出日报 |
| [`dsh-deepseek-meter`](plugins/dsh-deepseek-meter/) | 输入框下方显示 DeepSeek 账户余额与今日 token 用量，悬停看明细，点击刷新 |

两个插件都是纯 JS、零运行时依赖，只用 `node:*` 与 DSH 提供的服务。

## 目录结构

```
.
├── index.json                  # 插件索引（脚本生成，勿手改）
├── scripts/build-index.mjs     # 从各插件 package.json / locale / icon 生成索引
├── plugins/
│   ├── dsh-english-buddy/      # 一个插件一个目录，自带 README / docs / locale / icon / test
│   └── dsh-deepseek-meter/
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

三个套件、全部离线：`dsh-english-buddy` 的提示改写与历史存储（46 个断言级用例）、`dsh-deepseek-meter` 的状态路由。

## 发布

见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。最短路径：

```sh
gh repo create deepseek-plugin-market --public --source . --remote origin --push
npm run index
git add index.json && git commit -m "chore: publish index" && git push
```

之后把 `https://raw.githubusercontent.com/<owner>/deepseek-plugin-market/main/index.json` 加进 DSH 的 Discover。

## 许可

ISC。`dsh-english-buddy` 的教练规则与输出格式参考 [`xiaolai/english-buddy-for-claude`](https://github.com/xiaolai/english-buddy-for-claude)（ISC），实现按 DSH 接口重写。
