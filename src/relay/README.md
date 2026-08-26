# src/relay —— 自动化中继（S10）

这个目录把**本机 App** 和浏览器里某个标签页的 CDP 接通，让 App 能驱动
**用户日常浏览器里已经登录好**的页面跑自动化。剪藏功能不依赖它。

## 文件来源与许可（改之前先看）

| 文件 | 来源 | 许可 |
|---|---|---|
| `relayConnection.ts` | **原样取自** [`microsoft/playwright`](https://github.com/microsoft/playwright) 的 `packages/extension/src/relayConnection.ts` | Apache-2.0（版权头已随文件保留） |
| `berrytraceRelay.ts` | 我们自己写的接线层 | 随本仓（MIT） |

🔴 **`relayConnection.ts` 请保持与上游一致，不要往里塞业务逻辑。**
它是一条纯粹的 RPC 通道：把 `chrome.debugger.*` / `chrome.tabs.*` 这五个调用暴露给宿主，
自己不做任何决策。往里加东西的代价是以后跟不上上游的修复（重连、tab 生命周期那些边角
都是上游踩出来的）。要加逻辑就加在 `berrytraceRelay.ts` 或宿主侧。

跟进上游的做法：直接对比 playwright 仓里那个文件，覆盖，然后跑 `npx tsc --noEmit` 对基线。

## 为什么不照抄官方那套连接流程

官方的场景是**人坐在电脑前**，点扩展图标 → 在一个页面里挑标签 → 让 AI 接管它。
我们的场景是 **App 在后台跑任务，用户不该被打断**。所以：

- 连接由 **App 侧发起**（App 起 WebSocket 服务，扩展主动连出去并保持）；
- 标签一律 **`active: false`** 在后台开 —— 这是约束不是偏好，是「不干扰」的落点。

## 三条要守住的判据

1. **`debugger` 是 optional 权限**，不进常驻 `permissions`。纯剪藏用户永远不会看到
   「正在调试此浏览器」黄条，商店审核也好解释。每次建会话前必须 `permissions.request`。
2. **Firefox / Safari 上整层不启用**。Safari 根本没有 `chrome.debugger` API，
   Firefox 的形状也不同。按**运行时**有没有 `chrome.debugger` 来判，不靠构建期开关 ——
   三套构建共用一份源码。
3. **token 不是防君子的**：网页 JS 也能连 `ws://127.0.0.1`（WebSocket 不受同源策略拦）。
   宿主侧必须同时校验 token 和 Origin；扩展侧永远不把 token 写进页面可读的地方。

## 背景

设计与实测记录在主仓（`berrytrace_app`）：

- `台账/条目/0826-S10承载体三条路实测.md` —— 为什么承载体只能是浏览器插件
- `台账/条目/0826-S10插件基座选型.md` —— 为什么用 clipper 当外壳、relay 从 Playwright 移植
