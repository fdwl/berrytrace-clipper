/**
 * background service worker 的**真实入口**（webpack 的 `background` entry 指向这里，
 * 不是 `src/background.ts`）。
 *
 * ── 为什么要多这一层 ────────────────────────────────────────────────────────
 * 我们要在 background 里起自动化中继，最直觉的做法是往 `src/background.ts` 末尾
 * 加两行。但那个文件是**上游的**，改了它就等于在每次合并 obsidian 上游时给自己埋一个冲突点
 * （李博 0826：「这些替换是否可以做成 patch 的，不然我们合并 obsidian 开源项目，
 * 每次都会出现冲突」）。
 *
 * ⇒ 改成：上游那个文件**一个字都不动**，我们自己拿一个入口文件把它 import 进来，
 *   再挂上我们的东西。冲突面从「上游高频改动的 1100 行文件」缩到「我们自己的 10 行」。
 *
 * 🔴 **踩过一次**（0826）：patch 化那一版把 40 个源文件 `git checkout` 回上游，
 *    `src/background.ts` 也在里面 —— 于是之前加在它末尾的 `initBerrytraceRelay()`
 *    被一起还原掉了。构建照样绿、`relay-pair.js` 照样产出，只是 background 里
 *    再也没人启动中继，表现是「插件装好了却连不上」。
 *    **这就是为什么接线不能寄生在上游文件里。**
 *
 * ⚠️ import 顺序有讲究：先让上游的 background 完成它自己的初始化（消息监听、
 *    右键菜单、内容脚本注入那一套），我们再挂中继。中继是附加能力，不该抢在前面。
 */

import '../background';
import { initBerrytraceRelay, relayDiag } from './berrytraceRelay';
import { initWelcomeOnInstall } from '../welcome/onInstall';

/**
 * 🔴 **顶层异常要落盘。**〔0828 实测逼出来的〕
 * service worker 里一个未捕获的异常，在用户机器上是**完全看不见的**：
 * 他的日常浏览器没有调试端口（Chrome 136 起对默认 profile 忽略
 * `--remote-debugging-port`），SW 控制台进不去。
 * 那次的现象是「WebSocket 连上了，然后这个 worker 什么都不做」——
 * 而分不清是「早死」「消息没到」还是「分派走岔」。落进 storage 之后
 * `welcome.html?diag=1` 能读出来。
 */
self.addEventListener('error', (e: ErrorEvent) => {
  relayDiag('sw-error', `${e.message} @${e.filename}:${e.lineno}`);
});
self.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  relayDiag('sw-unhandled', String((e.reason as Error)?.message ?? e.reason).slice(0, 200));
});

// 剪藏和自动化是同一个扩展里的两件事：剪藏是用户看得见、愿意装的功能，
// 自动化是它搭的车。装一次解决两件事 —— 安装摩擦才是这条线的主要矛盾。
// 这里只起一个待机的连接器：没配对过就安静待着，不连、不重试、不打日志噪音。
// Firefox / Safari 上它会自己识别出没有 chrome.debugger 而整个不启用。
relayDiag('entry-begin');
initBerrytraceRelay();
relayDiag('entry-relay-done');

// 首次安装弹欢迎页。**必须在顶层同步注册** —— MV3 的 service worker 装完就被叫起来，
// `onInstalled` 只发一次；放进任何 await 后面都可能错过它，表现是「装了没弹」且零报错。
try {
  initWelcomeOnInstall();
  relayDiag('entry-done');
} catch (e) {
  // 欢迎页那一段挂了**绝不能把中继一起带走** —— 它们是两件不相干的事，
  // 而 MV3 里模块求值抛异常会让整个 worker 起不来。
  relayDiag('entry-welcome-threw', String((e as Error)?.message ?? e));
}
