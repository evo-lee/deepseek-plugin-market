# 发布到 GitHub

索引里每个版本都指向一个**精确的 commit**，所以顺序是死的：先推代码，再生成索引，再推索引。

## 0. 前置

```sh
git config user.name  "…"
git config user.email "…"
gh auth status            # 用 gh 建仓则需要登录；否则按下面手动建
```

## 1. 建仓并首次推送

```sh
cd deepseek-plugin-market
git init -b main
git add -A
git commit -m "feat: DSH english-buddy/deepseek-meter + clds english-buddy + 市场索引"

gh repo create deepseek-plugin-market --public --source . --remote origin --push
# 不用 gh：
#   git remote add origin git@github.com:<owner>/deepseek-plugin-market.git
#   git push -u origin main
```

仓库必须**公开**：DSH 用 `git+<url>#<commit>&path:…` 安装，私有仓需要额外凭据。

## 2. 生成索引

```sh
npm run index
git add index.json
git commit -m "chore: publish plugin index"
git push
```

`npm run index` 从 `origin` 读取仓库地址、从 `HEAD` 读取 commit、从各插件的 `package.json` / `locale/*.json` / `icon.svg` 生成整份索引。没有 remote 时它会直接失败并打印该跑的命令——不会写一个看起来对但 commit 是假的索引。

> 索引提交本身会移动 `HEAD`，但索引里指的是**上一个**提交（也就是包含插件代码的那个），所以这是稳定且正确的。

## 3. 发布索引地址

二选一：

| 方式 | 地址 |
|---|---|
| 直接用 raw | `https://raw.githubusercontent.com/<owner>/deepseek-plugin-market/main/index.json` |
| GitHub Pages | Settings → Pages → Source: `main` / `/`，然后 `https://<owner>.github.io/deepseek-plugin-market/index.json` |

要求：`https:`、2xx、不重定向。图标已经内联成 `data:` URL，因此不依赖相对路径。

## 4. 在 DSH 里接上

**Plugins → Discover → Add index source**，粘贴上面的地址。之后插件卡片可以一键安装；`Discover` 需要先打开实验性的 **Custom plugin indexes** bundle。

## 5. 发新版本

```sh
# 1) 改版本号（DSH 索引按 package.json 的 version 建条目）
node -e "const f='plugins/dsh-english-buddy/package.json';const p=require('./'+f);p.version='0.1.1';require('fs').writeFileSync(f, JSON.stringify(p,null,2)+'\n')"
npm test
git add -A && git commit -m "chore(english-buddy): 0.1.1" && git push

# 2) 用新提交重建索引
npm run index
git add index.json && git commit -m "chore: publish index" && git push
```

## 6. Claude Code / clds 插件

根目录的 `.claude-plugin/marketplace.json` 只列 `clds-english-buddy-for-claude`。它不走 DSH 索引，也不需要 `index.json`；推送后直接：

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-deepseek" \
  claude plugin marketplace add <repo-url-or-local-path>

CLAUDE_CONFIG_DIR="$HOME/.claude-deepseek" \
  claude plugin install clds-english-buddy-for-claude@litang-deepseek-plugin-market
```

插件自身的版本在 `plugins/clds-english-buddy-for-claude/.claude-plugin/plugin.json` 与 `package.json` 里；发版时两处一起改。

## 上线前检查

- [ ] `npm test` 全绿（离线，无凭据），包括 `clds-english-buddy-for-claude` 的测试
- [ ] `npm run index` 成功，`index.json` 里的 `commit` 等于 `git rev-parse HEAD` **之前**那次提交
- [ ] `index.json` 只包含两个 DSH 插件，不包含 Claude Code 插件
- [ ] 每个 DSH 插件的 `locale/{zh,en}.json`、`docs/DETAIL{,.en}.md`、`icon.svg` 都在
- [ ] 仓库公开，`git+<url>#<commit>&path:plugins/<name>` 能拉到
- [ ] 在干净 profile 里从 Discover 装一次 DSH 插件，确认能装上、能跑
- [ ] 在 `~/.claude-deepseek` 里装一次 clds 插件，运行 `doctor --probe` 和 `today`
