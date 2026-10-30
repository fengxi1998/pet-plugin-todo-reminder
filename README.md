# 到点提醒 · 吐梨邦插件

独立待办插件：写下的待办可以带到期时间，**到点桌宠会主动冒泡提醒**，逾期未办还会周期性催你。
基于官方插件体系（[create-pet-plugin](https://github.com/ShunyuYao/create-pet-plugin)）。

| 项目 | 值 |
|---|---|
| 插件 ID | `todo-reminder` |
| 当前版本 | 1.0.4 |
| 最低宿主版本 | 0.29.3（Windows 11 实测） |
| SDK 契约 | `apiVersion: 1` |
| Node 内建模块 | **不使用**（`nodeAccess: false`） |
| 联网 | **不联网**（无 `net:` 权限） |

## 功能

三类能力，对应三种使用场景：

| kind | 入口 | 做什么 |
|---|---|---|
| `tool` | `tool/index.js` | 常驻层：注册 5 个 Agent 工具、每 30 秒巡检到期、逾期催办、早间播报、状态徽标 |
| `panel` | `panel/panel.html` | 待办面板：添加（可带时间）、三个过滤页签（待办/今天/已完成）、逾期红底、一键推迟 5 分钟 |
| `dashboard-card` | `card/card.html` | 看板卡片：待办/今天到期/已逾期统计 + 最近到期一条 + 快速添加 |

### tool 注册的 5 个工具（宿主 Agent 可直接调用）

参数声明放在 `schema.parameters`（宿主 Agent 适配层从该字段读取入参 JSON Schema，
`schema.description` 作为工具描述）；5 个工具必填项：`reminder_add` 必填 `text`，
`reminder_done` / `reminder_delete` / `reminder_snooze` 必填 `target`，`reminder_list` 无必填。

| 工具 | 参数 | 行为 |
|---|---|---|
| `reminder_add` | `text`、`due?` | 添加待办；`due` 可传 `2026-10-30T18:00:00+08:00` 或 `2026-10-30 18:00` |
| `reminder_list` | `onlyPending?` | 列出待办（含是否逾期标记） |
| `reminder_done` | `target`（id 或内容关键字） | 标记完成 |
| `reminder_delete` | `target` | 删除 |
| `reminder_snooze` | `target`、`minutes?` | 推迟 N 分钟（默认 5），并重新武装提醒 |

### 容量上限（200 条）

待办上限 **200 条**，工具、面板、看板卡片三侧一致：

- 已满时再新增会被**明确拒绝**（工具返回 `ok:false` 与原因；面板 toast 提示；卡片弹宿主对话框），不做静默截断。
- 历史数据若已超限（旧版本写入），原样保留，完成/删除照常可用，靠删除自然回落到上限内。

### 提醒机制

- **检测粒度 30 秒**：`scheduler.every(30s)` 巡检，到期后桌宠冒泡「到点了：xxx」并播 `unread` 动作。
- **气泡显示 30 秒**：宿主对插件气泡的默认时长只有 4 秒（`applyPluginPet` 兜底），提醒文案读不完，
  所以每次冒泡都显式传第二个参数（SDK 冻结契约支持）。早间播报 8 秒。
  注意头顶五胶囊强互斥：思考中/差事/朗读胶囊出现时会收掉气泡，这是宿主行为，插件无法豁免。
- **逾期催办**：提醒后仍未完成的，每 10 分钟催一次，最多 3 次；之后不再打扰，只靠徽标红档 + 面板红底提示。
- **停机补账**：宿主重启后首轮巡检会把「已逾期但还没提醒过」的旧账立即补上。
- **早间播报**：每天 09:00 播报今天到期数与逾期数。
- **跨插件广播（提醒）**：提醒发生时广播 `todo-reminder:remind` 事件（载荷 `{items:[{text,due}], overdue}`）。
  其它对话型插件可自行监听并写入各自的对话记录。
- **跨插件广播（完成）**：一条待办被标记完成时广播一次 `todo-reminder:completed` 事件
  （载荷 `{id, text, doneAt}`）——工具 `reminder_done` 与面板勾选两条路径都会广播，
  取消完成不广播，同一次完成只发一次。其它插件（如游戏类）可据此发放联动奖励；
  本插件不依赖任何监听方，无人接收也不影响提醒主流程。

## 申请的权限（7 项）

| 权限 | 用途 |
|---|---|
| `storage` | 待办数据存在插件私有存储（`%APPDATA%\desktop-pet-shell\plugins\todo-reminder\data.json`），卸载插件即随之删除 |
| `pet` | 到点时让桌宠冒泡、播放动作，并设置宠物脚下的状态徽标 |
| `ui` | 打开与关闭插件面板（徽标点击时 `onClick: 'openPanel'`） |
| `events` | 面板/卡片与常驻层之间同步数据变更；对外广播 `todo-reminder:remind` 与 `todo-reminder:completed` |
| `scheduler` | 每 30 秒巡检到期、每 10 分钟催办、每天 09:00 早间播报 |
| `tools` | 向宿主 Agent 注册 5 个待办管理工具 |
| `dashboard` | 在看板挂载本插件的卡片区块 |

**未申请、也不使用的**：`net:*`（不联网）、`clipboard`（不读剪贴板）、`appearance`（不改动外观）、
`secrets`（不接触凭据）、`files`（不读写用户文件）。

### 实验能力说明

`badge.set` / `badge.clear` 属 SDK 的 **B 档（experimental）** 能力，需要 `pet` 权限。
旧宿主若不支持，调用会失败；此时插件的徽标显示不可用，但**冒泡提醒与面板功能不受影响**，
核心提醒链路全部走已冻结（A 档）能力。宿主限制徽标最多 2 段、每段不超过 4 个码点，
本插件据此设计（`待N` / `逾N`）；与其它插件的徽标名额冲突时静默让位。

## 数据与隐私

- 待办内容只存在插件自己的 `storage` 里，**不出本机、不上传**。
- 本插件不发起任何网络请求，没有 `net:` 权限，也没有可触发网络请求的代码路径。
- 不读剪贴板、不读文件、不写文件、不起子进程。
- 卸载插件时其私有数据随插件目录一并移除。

## 安装

**市场安装（推荐）**：桌宠「设置 → 插件中心 → 插件市场」搜索「到点提醒」。

**手动安装（开发调试用）**：下载 `plugin.zip` 解压后，在
「设置 → 插件中心 → 开发者模式 → 手动安装 → 从文件夹安装」选择解压目录。
手动安装不经过审核，只用于本地调试。

## 开发

```bash
# 校验 manifest、打包清单与政策红线，并产出 dist/plugin.zip
node scripts/build.js

# 只校验不产出（CI 的 PR 检查用）
node scripts/build.js --check-only

# 校验标签与 manifest.version 一致（CI 发布前用）
node scripts/build.js --check-only --check-tag v1.0.4
```

`scripts/build.js` 在打包前会强制检查：

- manifest 字段合法（ID 格式、`x.y.z` 版本号、description 单行且 ≤200 码点）
- manifest 声明的入口全部在打包清单里，且清单文件全部存在
- **政策红线扫描**：Node 内建模块 `require`、动态 `require`、`eval`/`new Function`、任何联网调用
  （`fetch` / `XMLHttpRequest` / 硬编码 URL）——任一命中即构建失败

ZIP 顶层直接是 `manifest.json`（宿主安装管线的解析要求），文件顺序固定、时间戳归零，
保证同样的源码打出同样的包与摘要。

## 验证记录

| 项目 | 结果 |
|---|---|
| 宿主 manifest 校验 | 通过（宿主 `loadManifest` 真实路径） |
| 工具逻辑测试 | 模拟 SDK 12 项断言通过（宿主参数转换存活 / 提醒触发 / 催办上限 / snooze 重武装 / 关键字定位 / completed 恰好一次且载荷 {id,text,doneAt} / 容量满拒绝且不截断 / 定时器销毁无泄漏） |
| 面板与卡片真渲染 | Chromium 实渲染 + 交互 12 项断言通过（含面板 completed 广播、面板/卡片满载拒绝路径），零运行时异常 |
| 停用 / 重启 / 卸载 | 停用清空定时器与徽标；重启后首轮巡检补提醒旧账；卸载移除私有数据 |

## 已知取舍

- **提醒粒度 30 秒**：更细的粒度意义不大（桌宠冒泡本身有动画延迟），30 秒是精度与空转的平衡点。
- **催办上限 3 次**：超过后由徽标红档接管，避免「桌宠烦人」。
- **没有系统通知**：SDK 的已冻结能力里没有系统级 notification 出口，提醒走桌宠冒泡 + 动作 + 徽标，
  这正好也是「桌宠替你盯时间」的形态。

## 许可证

MIT，见 [LICENSE](LICENSE)。
