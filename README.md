# dsh-task-notify · 系统任务通知插件

> DeepSeek Harness (DSH) 系统级任务通知插件 —— 需要审批 / 需要回复 / 任务结束（后台任务、子任务、工作流）三类状态，推送到**电脑系统通知中心**（带系统提示音 + 分类型合成提示音），并附带应用内铃铛面板、Toast 与「清理」按钮。

English: System-level task notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Three event kinds — **approval required**, **awaiting your reply**, **task finished** (background job / subagent / workflow) — are pushed to the **OS notification center** with chimes, plus an in-app bell panel, toasts, and a clear button.

## 功能特性 / Features

- 🔔 侧栏底部铃铛入口，未读数角标；面板内展示全部通知（含时间、类型、状态）
- 🔔 **系统通知中心**横幅（`Notification` API）+ 分类型 Web Audio 合成提示音：
  - 需要审批 = 急促双响（880Hz × 2）
  - 需要回复 = 柔和单音（660Hz）
  - 任务结束 = 上行双音（523→784Hz）
- 🔔 Toast 浮层（最多 3 条，6 秒自动消失）
- 🔔 「测试通知」「重发」「全部已读」「清理」按钮；面板顶部实时诊断行（系统通知权限 / 挂载 / 轮询状态）
- 🌐 中 / 英双语界面（跟随 DSH locale）
- 🧩 宿主组合行监听**所有会话**的事件（区别于动态插件的单会话作用域）；队列上限 300 条

## 安装 / Install

> 需要 Node.js + pnpm（`dsh plugin` 底层调用 pnpm）。安装后重启 `dsh web`，刷新页面。

### 方式一：`dsh plugin add`（推荐）

```sh
dsh plugin --profile web add git+https://github.com/kaotusi/dsh-task-notify.git
```

> 若你的 profile 名不是 `web`，把 `--profile web` 换成实际 profile 名。
> 国内网络访问 github.com 不稳定时，可用方式二，或先配置代理。

### 方式二：手动拷贝（无需网络）

把本仓库 `lib/`、`package.json`、`cordis.patch.yml` 放进接收方 profile 的 node_modules（要求目录名严格为 `dsh-task-notify`，位于 `@deepseek-ai/` 作用域下）：

```bash
git clone https://github.com/kaotusi/dsh-task-notify.git
cp -r dsh-task-notify/{lib,package.json,cordis.patch.yml} \
      ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-task-notify/
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: task-notify
      name: '@deepseek-ai/dsh-task-notify'
```

> 说明：`dsh plugin add` 通过 `dsh.bundle` 清单（本包 `package.json` 中的 `dsh.bundle.patch`）自动完成上述两步。方式二仅用于无法使用 pnpm / 无网络的环境。

### 授权系统通知

重启后点击侧栏底部 🔔 铃铛 → 浏览器弹出通知授权框 → 允许；面板顶部诊断行显示 `系统通知: granted` 即就绪。

## 验证 / Verification

- 面板诊断行：`系统通知: granted · 挂载: 成功 · 轮询: 成功(N)`
- 触发任意后台任务（`run_in_background`）、审批（cordis 运行 / 沙箱提权）、子任务、工作流，通知中心应弹出对应横幅 + 提示音
- 面板「清理」按钮可彻底清空全部通知（面板 + 宿主队列）

## 目录结构 / Layout

```
dsh-task-notify/
├── README.md          ← 本文件
├── LICENSE            ← MIT
├── package.json       ← 插件清单（含 dsh.bundle 与 dsh.client 声明）
├── cordis.patch.yml   ← 宿主组合补丁片段（bundle 层）
└── lib/
    ├── index.js       ← host 半部：事件监听 + 队列 + Remote 服务 + 诊断工具
    ├── typert.js      ← host 半部 typert 清单（strict codec，4+1 个端点）
    └── client.js      ← client 半部：铃铛/面板/Toast/系统通知/清理按钮
```

## 实现说明 / How it works

- **host 半部**（`lib/index.js`）：通过组合行监听 `approval/request`、`agent/turn-stopping`、`subagent/end`、`workflow/end` 与后台任务 `onJobDone`，聚合进进程内队列（上限 300 条），并注册 `taskNotify` Remote 服务（`pull` / `ack` / `clear` / `purge` / `diag`）与 `ntfy_status` 诊断工具。
- **client 半部**（`lib/client.js`）：`__ModuleLoader__` 网页模块，轮询 `pull` 拉取队列，非读通知触发 OS 通知 + 提示音 + Toast；铃铛面板 / 样式全部内联，零构建。
  - 已推送 ID 用 `localStorage` 去重（刷新 / 多标签页不重复轰炸），每轮最多推 3 条新通知；
  - 以服务端快照为准做删除对账（另一标签页清理或宿主重启后不残留幽灵通知），面板保持服务端「最新在前」顺序；
  - 页面隐藏时跳过轮询，`visibilitychange` 回前台立即拉取。
- **客户端 RPC 走底层 connection seam**（`/api/taskNotify/pull` 等），不依赖 typert 命名空间 face —— 这是避免自挂载命名空间 inject 死锁的刻意设计，请勿回退为 `ctx.remote.<ns>` 调用。
- 修改任何文件后需**重启 Harness** 生效（typert 清单按包名缓存）。

## 测试 / Tests

```sh
npm test
```

Node 内置 test runner，零额外依赖：`test/client.test.mjs` 用 mock 的 window/React/Notification 驱动 client 纯逻辑（去重、删除对账、顺序、隐藏轮询、3 条预算）；`test/host.test.mjs` 覆盖 host 队列（key 去重、300 条 prune、ack/clear/purge）与 `ntfy_status` stale 诊断。host 组要求 peer 依赖可解析（本地开发可 `ln -s ~/.dsh/profiles/node_modules node_modules`）。

## 前置依赖 / Dependencies

插件只依赖 DSH 自带包与通用包，标准 profile 均已包含；`dsh plugin add` 时会由 pnpm 自动补齐 peer 依赖：

- `@deepseek-ai/dsh-tools`（host 半部注册诊断工具）
- `@deepseek-ai/dsh-typert-protocol`（host 半部 Remote 服务绑定）
- `zod`（typert 清单 strict codec）
- `react`（client 半部，网页模块加载器自带）

## License

[MIT](LICENSE)
