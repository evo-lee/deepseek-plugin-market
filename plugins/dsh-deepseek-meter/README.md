# dsh-deepseek-meter

DeepSeek Harness 插件：在会话输入框下方显示 **DeepSeek API 余额**、**今日花费（估算）** 和 **今日 token 用量**。

```
● 余额 ¥61.17 · 今日花费 ≈¥1.78
```

- 余额来自 DeepSeek 公开接口 `GET /user/balance`，使用 `DEEPSEEK_API_KEY` 凭据（Host 侧解析，不下发浏览器），优先显示人民币钱包。
- 今日花费把本机今天的 DeepSeek 调用按官方价目表折算：峰值时段全价、空闲时段半价，每条调用按发生时间判定峰谷；金额随钱包币种（人民币 / 美元）。
- 用量按本机会话日志里模型上报的 usage 累加：输入 / 缓存命中 / 缓存写入 / 输出、调用次数、会话数；只统计 provider 或 model 以 `deepseek` 开头的调用，fork 继承的事件不重复计入。
- 悬停看明细（含 token 拆分与估算口径）；点击立即刷新；后台每 60 秒刷新，页面隐藏时暂停。
- 余额低于 5 或接口返回欠费时，圆点与文字转为警示色；刷新失败时保留上次成功的数据并标注。

## 安装

已在 `desktop` profile 里安装（软链到本目录，修改立即生效）。其它环境：**Plugins → Add plugin** 选择本目录，或

```sh
dsh plugin --profile desktop add ./plugins/dsh-deepseek-meter
```

Host 侧改动需要重启或重新启用插件行；客户端改动刷新页面即可。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host：注册 `GET /api/deepseek-meter/state`，查余额、按 provider 折叠今日用量并按价目表计价，内存缓存 20 秒 |
| `client.js` | Client：向 `conversation.composer.dock` 注册一颗状态药丸 |
| `cordis.patch.yml` | 插入 `deepseek-meter` 插件行 |
| `locale/{zh,en}.json` | 插件管理器的标题、描述与详情页入口 |
| `docs/DETAIL.md` / `DETAIL.en.md` | 插件详情页正文（中 / 英） |
| `test/state.test.mjs` | Host 路由的离线测试（桩掉凭据、会话查询与 fetch） |

## 配置

插件行可覆盖四个字段：

```yaml
- id: deepseek-meter
  config:
    apiKeyRef: DEEPSEEK_API_KEY
    origin: https://api.deepseek.com
    providers: ['deepseek']
    pricing:                      # 可选：覆盖价目表（给峰值单价，空闲自动半价）
      CNY:
        deepseek-flash: { hit: 0.04, miss: 2, out: 8 }
      USD:
        deepseek-flash: { hit: 0.006, miss: 0.3, out: 1.2 }
```

内置价目表为 2026-11-18 版官方价格：`deepseek-flash` 峰值缓存命中 ¥0.04 / 未命中 ¥2 / 输出 ¥8，`deepseek-v4-pro` ¥0.30 / ¥9 / ¥27（每百万 token），美元表同步内置；峰值时段按北京时间周一至周五 09:00–12:00、14:00–18:00 判定。

## 测试

```sh
node test/state.test.mjs
```

覆盖：正常余额 + 用量、fork 前缀跳过、非 DeepSeek provider 排除、model 前缀匹配、缺密钥、余额接口 401、单个会话读取失败、无 connection 服务、连接晚到后才注册、峰谷时段判定、按发生时间计价、旧模型名归一到 Flash 价、未知模型标注未定价。

## 已知限制

- DeepSeek 没有公开的用量或账单查询接口，「今日用量」「今日花费」都是本机实际调用的口径，不是平台后台账单。
- 花费是按官方价目表推算的估算值：法定节假日按峰值计（只会高估），价格调整后需要更新价目表或 `pricing` 配置。
- 花费只覆盖本机经 DSH 发出的调用；同一把密钥在其它程序里的消耗不计入。
- 未配置密钥时余额显示 `—`，不会显示 0。
- 只读最近 7 天内创建的最多 60 个会话日志；更早或更多的会话不计入今日合计。
