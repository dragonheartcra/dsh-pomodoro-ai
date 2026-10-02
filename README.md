# dsh-pomodoro-ai

[DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的 **AI 番茄钟**插件。

一个全局唯一的钟 + 一个会话级的「管家」+ 一个 DSH 窗口内的浮层部件。
你把任务丢给管家会话的 AI，它帮你拆解、估番茄数、排期、启动计时；到点它主动来找你。
**其他会话连番茄钟工具都看不见**——你在别的项目里干活时，不会有第二个 AI 来碰你的钟。

[English](README.en.md)

<p align="center">
  <img src="docs/widget-expanded.png" width="300" alt="展开态：圆环、控制按钮、计划/声音/周统计面板">
  &nbsp;&nbsp;
  <img src="docs/widget-mini.png" width="120" alt="迷你态：只有一个会随时间烧短的圆环 + 时间 + focus/relax">
</p>

---

## 它解决什么问题

- **你不想手动管计时器**：跟 AI 说「帮我拆一下今天的活」，它登记计划、算番茄数、启动第一个番茄，你直接去干活。
- **你同时开很多会话跑不同项目**：番茄钟只属于你指定的那一个会话。其他会话的请求里连工具 schema 都不出现（顺带省 token），硬调也只会拿到 `UNKNOWN_TOOL`。
- **你要如实记录**：暂停发生在哪一刻、暂停了多久、关机期间哪一段走完了（无法核实会明确标注），全部进事件流；统计按**本地自然日**聚合。
- **你不想被"提醒"绑架**：阶段结束默认只通知一次，且投递到管家会话——AI 会带着权威状态（实际时长、暂停次数与时间点）来找你，而不是一个空响铃。

## 特性

| 能力 | 说明 |
|---|---|
| AI 工具面 | `pomodoro_plan` / `start` / `control` / `status` / `noise` 五个工具，**只对管家会话可见** |
| 轮次模型 | `专注 → 短休 → … → 长休`（每 N 轮），长短休可各自关闭 |
| 浮层部件 | DSH 窗口内可拖动浮层；展开态含计划/声音/周统计三个折叠面板；迷你态只有一个会"烧短"的圆环 + 时间 + `focus`/`relax` 小字 |
| 背景音 | FlowTunes 环境音**多路叠加**（每路独立音量）+ 音乐频道顺序播放 / 本地文件夹 |
| 提示音 | 专注 / 短休 / 长休结束三种提示音 + 可选滴答声 |
| 周统计 | 近 7 天柱状图 + 今日汇总，按本地自然日切分 |
| 到点主动开口 | 通过官方 `@deepseek-ai/dsh-schedule` 把提醒投递为**该会话的后续回合** |
| 不丢计时 | 绝对 `deadlineAt` 推进：刷新页面、关掉窗口都不影响；重启后按剩余时间重新武装提醒 |
| 状态迁移 | `state.json` 版本化迁移（当前 v3），旧版本无损升级 |

## 安装

```powershell
# 1) 装插件（官方 CLI，走 GitHub）
dsh plugin --profile desktop add github:dragonheartcra/dsh-pomodoro-ai

# 2) 给 profile 补一条官方持久提醒服务（阶段结束通知靠它）
#    编辑 ~/.dsh/profiles/desktop/cordis.patch.yml，追加：
#      - insert:
#          - id: schedule
#            name: '@deepseek-ai/dsh-schedule'
```

重启 DSH（或启用官方 HMR 免重启），右下角就会出现浮层。

> 本包**没有构建步骤、没有运行时依赖**：`lib/*.js` 直接就是成品，`require` 只有 `react`。

## 用法

### 1. 指定一个会话当「管家」

在你想管理番茄钟的那个会话里输入：

```text
/pomodoro 接管      # 让当前会话成为管家（其他会话立刻看不见工具）
/pomodoro 释放      # 解除
/pomodoro           # 看状态：谁是管家、挂载在哪、计时到哪了
```

别名 `/pomo`。（命令名必须是 ASCII——官方注册表限制 `^[a-z][a-z0-9_-]*$`。）

### 2. 跟管家会话的 AI 说话

```text
帮我拆一下今天的活，然后开始第一个番茄
现在这个番茄还剩多久？我今天一共专注了多久？
把专注时长改成 45 分钟，每 2 轮长休
放点雨声和篝火，音量小一点
```

### 3. 浮层

- 展开态：环 + 时间 + 阶段；下面四个按钮（暂停/继续、跳过、重置、停止）；三个折叠面板（计划、声音、近 7 天）；底部今日统计。
- 迷你态：**只有一个圆**——环随时间"烧短"，中间是时间，下面一行小字 `focus` / `relax`（短休与长休都是 `relax`，靠环的颜色区分）。**点一下展开**，拖动可搬位置。
- 头部有「配色」按钮：自动 / 墨白 / 深色 / 浅色四套自带调色板。

## 会话隔离（管家会话）

**为什么**：DSH 里同时跑很多项目，只有一个会话该管番茄钟。全局注册工具的代价是三重的——
每个会话的请求都带 5 个工具 schema（白付 token）、任何会话都能 `pomodoro_start` 抢走绑定、
任何会话都能操作全局唯一的那只钟。

**做法**：工具**不全局注册**，只注册进「管家会话」的 agent scope。

| 层 | 位置 | 说明 |
|---|---|---|
| 时钟 / 状态 / 事件流 / HTTP 路由 / 浮层数据源 | 全局 | 一次只能专注一件事，单例是正确语义 |
| 到点提醒 | 全局，投递给**管家会话** | `reminderTarget = manager ?? watch` |
| 5 个工具 | **管家会话的 `agent.ctx`** | 其他会话不可见 |
| 指定管家 | 人类命令 `/pomodoro 接管` | `invocation.agent` 就是当前会话 |

官方依据（`cordis_inspect_query` 查到的精确契约）：

- `tools.register()`：*"Register globally **or in the calling agent scope**"*
- `tools.schemas(scope?)` / `get(name, scope?)`：*"the viewing scope (**the agent**)"*
- `tools.execute()`：*"an **invisible** tool reports `UNKNOWN_TOOL`"*
- 事件 `agent/created`（serial）：*"ready for **per-agent initialization**"* → 会话重开时自动重新挂载
- 命令 `handler(invocation)`：`invocation.agent` = 输入该命令的会话

**三道闸**：

1. `assertToolSchema` —— 注册前校验（空 `parameters` 会被上游 400 拒绝并**挂掉全站所有会话**，有前科）
2. `register` 进管家 scope
3. 注册后**回读隔离校验**：该 scope 里工具齐全（5/5）**且全局视图里一个都没有**；任一不满足就整体回滚

外加每个工具 `execute` 里的第二道闸（非管家会话直接拒绝），以及 15 秒一轮的**对账器**兜底
（防止"启动时服务未就绪"或"事件没等到"导致工具没挂上）。

## 架构

```
lib/store.js    纯逻辑内核：状态机 / 轮次 / 持久化 / 统计 / 事件流。零 DSH 依赖 → node 直接单测
lib/index.js    host 半：HTTP 路由 + 1s tick + 5 个工具（只挂进管家 scope）+ 到点通知
                工具与路由抽成工厂（createTools / createApiHandler / createFlowLoader）→ 脱离 DSH 可测
lib/client.js   client 半：shell.overlay 浮层 + 音频引擎（手写 bundle，无构建步骤）
tools/          三套测试（227 项断言，全部脱离 DSH 可跑）
```

**权威在 host**：浮层只渲染 + 发命令，倒计时用 host 给的绝对 `deadlineAt` 本地推算——
轮询抖动或页面卡顿都不会让显示与 host 漂移。

### 数据落在哪

```
$DSH_HOME/pomodoro/
├── state.json     权威状态（版本化，当前 v3）
├── events.jsonl   追加式事件流（每次阶段变化 / 暂停 / 恢复 / 离线结算 / 配置变更）
└── probe.jsonl    诊断探针（host 装配指纹、客户端上报、提醒武装/消费记录）
```

`events.jsonl` 每条都带来源：`ai` / `widget` / `human` / `system`——所以"谁在什么时候做了什么"是可查的。

## 配置

用 `pomodoro_control` 的 `action=config` 改，或直接写 `state.json`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `focusMin` | 25 | 专注时长（分钟） |
| `shortBreakMin` | 5 | 短休时长 |
| `longBreakMin` | 15 | 长休时长 |
| `roundsPerCycle` | 4 | 每几个番茄进长休 |
| `shortBreaksEnabled` | true | 关掉则跳过短休 |
| `longBreaksEnabled` | true | 关掉则用短休顶替长休 |
| `autoBreak` | true | 专注结束是否自动进休息 |
| `autoNextFocus` | false | 休息结束是否自动开始下一段（默认停住等你） |
| `notifyOnPhaseEnd` | true | 阶段结束是否通知 |
| `cueVolume` | 0.7 | 提示音音量 |
| `tickDuringWork` / `tickDuringBreak` | false | 滴答声 |
| `flowDataDir` / `loopIconsDir` / `cueDir` / `musicDir` | 空 | 音源目录，见下 |

### 静态资源（插件**不含任何第三方资产**）

环境音清单/图标/提示音需要你自己提供，三种方式任选：

1. 环境变量 `POMODORO_STATIC` 指向你的 static 目录（期望其下有 `flowtunes/`、`loop-icons/`、`audio/`）
2. 把文件放进 `$DSH_HOME/pomodoro/{flowtunes,loop-icons,audio}`
3. 用 `config.set` 显式指定四个目录

缺了不影响计时：环境音/图标/提示音各自降级（路由 404、界面提示缺哪些文件）。

- `flowtunes/`：`channels.json`、`catalog.json`、`ambient.json`
- `loop-icons/`：`<环境音 id>.svg`
- `audio/`：`alert-work.mp3`、`alert-short-break.mp3`、`alert-long-break.mp3`、`tick.mp3`
- `musicDir`：本地音乐文件夹（host 流式提供，支持 Range）

环境音/音乐的音频本身从 FlowTunes 公共桶**运行时流式播放**（`loop-audio-v3` / `track-audio-v3`），
仓库里不含任何音频文件。

## HTTP 路由

| 路由 | 说明 |
|---|---|
| `GET /pomodoro-ai/api/health` | 健康检查（build、pid、是否拿到 schedule、目录） |
| `GET /pomodoro-ai/api/state` | 权威状态快照（浮层就靠它） |
| `POST /pomodoro-ai/api/command` | 命令入口（浮层用；`{action, payload, source}`） |
| `GET /pomodoro-ai/api/events?limit=N` | 最近事件 |
| `GET /pomodoro-ai/api/flow/data` | 频道 + 曲目目录 + 环境音清单 + 本地曲目 + URL 模板 |
| `GET /pomodoro-ai/api/flow/icon/<id>` | 环境音图标（SVG） |
| `GET /pomodoro-ai/api/cue/<name>` | 提示音（支持 Range） |
| `GET /pomodoro-ai/api/audio/<file>` | 本地音乐（支持 Range） |

## 测试

```powershell
npm test                      # 227 项断言，全部脱离 DSH
node tools/smoke.mjs          # 内核：轮次周期 / 暂停 / 离线结算 / 持久化 / 统计 / 背景音 / 迁移 / 管家
node tools/host-smoke.mjs     # 工具 schema 与行为 / 管家隔离 / 全部路由 / Range / 路径穿越
node tools/client-check.mjs   # 在 node 里模拟 __ModuleLoader__ 与 React，把浮层真渲染一遍
```

三套都只用 `node:*`，不需要浏览器、不需要 DSH。`host-smoke` 里有一节「真实音源目录」，
设了 `POMODORO_STATIC` 才会跑（验证你的数据文件与提示音真的能被读到）。

**为什么这么设计**：DSH 官方装配会缓存 ESM，改 host 代码原本必须重启。能提前验证的测试价值极高——
上面这些坑几乎每一个都是靠"能脱离宿主跑"才被抓到的。

## 工程笔记（踩过的坑，都留了回归测试）

- **工具 schema 是全局的**：`parameters: {}` 会被上游 400 拒绝，**挂掉所有会话**。现在有三道闸 + 注册前校验。
- **CSS 变量"存在但为空"**：`var(--x, fallback)` 遇到空值会判定整条声明无效、**不会**用回退值。
  我们曾因此得到一个"白底白字"的按钮。结论：**凡是"文字压在什么颜色上"的地方，对比度必须自己保证**，
  不能托付给主题 token。
- **热重载会留下孤儿音频**：旧 bundle 启动的 `<audio>`/Web Audio 节点没有句柄指向它，会一直响且停不掉，
  只能刷新页面。现在所有发声节点登记进 `window` 上的注册表，**新 bundle 载入的第一件事**就是回收上一版。
- **加载顺序**：profile patch 层比 bundle 层后装配，所以插件 `apply` 时可能还拿不到某些服务
  （`schedule`、`agents`）。所有跨服务调用都做了"等就绪 / 对账器兜底"。
- **两端契约不一致**：浮层发 `addLoop: "rain"`、内核只认 `{id, volume}` → 静默失败。
  现在内核兼容两种形状，并且有一条测试直接扫客户端源码的调用形状。
- **serial 事件的监听器抛错会让会话创建失败**：`agent/created` 的监听器全部 try/catch 吞掉并记 probe。

## 已知边界

- **HTTP 路由在 localhost 上没有鉴权**：任何有 shell 权限的会话理论上都能 `curl /command` 绕过工具闸门。
  这是**已知且接受**的取舍（单机本地工具的合理上限）；要收紧可以用 `webServer.tapIndex` 注入随机 token。
- **环境音/音乐需要联网**（FlowTunes 公共桶）。数据与图标属于该服务的授权范围，**不在本仓库内**，
  请自行确认你的使用方式。
- 浮层在所有会话可见（它是全局那只钟的显示器）；工具隔离才是"其他会话感知不到"的部分。

## 致谢

- 轮次模型与音量模型移植自 [elegant-pomodoro](https://github.com/dragonheartcra/elegant-pomodoro)（MIT），
  后者又源自 [Pomotroid](https://github.com/Splode/pomotroid)（MIT, © 2018 Christopher Murphy）。
- 到点通知基于官方 `@deepseek-ai/dsh-schedule`。
- 环境音/音乐数据来自 FlowTunes 的公开接口，**未随本仓库分发**。

## 许可

[MIT](LICENSE) © 2026 dragonheartcra
