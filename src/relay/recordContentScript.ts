/**
 * 录制 · 页面这一侧的**编排**（注入用户访问的每一个页面）
 *
 * 李博 0907：「我正在录制过程中，当我访问的网站，里面我如何进行录制？」
 *
 * 这个文件把三件事接起来：
 *   ① 页面一打开就问 service worker「现在在录吗」—— **新开的标签自己会亮**，
 *      不需要用户做任何事（宿主规划里的 R5）；
 *   ② 在录 ⇒ 挂上那条工具条（recordToolbar.ts）；
 *   ③ 该采集 ⇒ 把点击/输入/滚动抄成结构事实发上去（recordSnapshot.ts）。
 *
 * ── 🔴 不在录的时候，这个文件必须几乎什么都不做 ───────────────────────────
 * 它被注入**用户访问的每一个页面**。所以：不挂任何监听、不建任何 DOM、
 * 不读 DOM，只发一条消息然后等。这条纪律和 relay-wake.js 那份是同一条 ——
 * 「录制让我的浏览器变卡」是这条功能被关掉的最快理由。
 *
 * ── 判定不在这里 ──────────────────────────────────────────────────────────
 * `show` / `capture` 是宿主算好下发的两个布尔，这里不看相位、不做任何推导。
 * 理由见宿主仓 `src/views/recording/browser-protocol.ts` 的文件头。
 *
 * ── 如实登记的两条缺口 ────────────────────────────────────────────────────
 * ⚠️ ① **只在顶层框架里跑**（manifest 没开 all_frames）。iframe 里的点击采不到。
 *    开 all_frames 的话每个 iframe 都会挂一条工具条；而只采集不挂 UI 又会产出
 *    **在顶层文档里解析不出来的选择器** —— 那比不采更坏（它看起来是有效定位）。
 *    要做对得先有 frame 路径，那是下一轮的事。
 * ⚠️ ② 键盘只取「一段输入的结果」（change 事件），不记按键序列。这是有意的：
 *    逐键是键盘记录器行为，而且中文输入法下按键序列毫无意义。
 */

import type { WebInteraction } from './recordSnapshot';
import { mayReadValue, snapshotElement } from './recordSnapshot';
import { RecordToolbar, type RecordingStateView } from './recordToolbar';

/**
 * 同一个页面只装一份。
 *
 * ── 🔴 它不能是一个布尔（0907 第九轮，真浏览器里当场量到的）───────────────
 * 头一版写的是 `if (w[FLAG]) return`。**扩展一重载，这个页面就再也装不上了**：
 * · `chrome.runtime.reload()` 之后，页面里那份 content script **不会被卸掉**，
 *   它变成一个"孤儿" —— JS 还在跑、监听器还在、DOM 还在，
 *   但它手上的 `chrome.*` 已经失效（`Extension context invalidated`）。
 * · 于是那个布尔还是 `true`，补注入进来的新一份当场 return，
 *   而孤儿那份**永远收不到任何消息**了。用户看到的是：装了新插件、
 *   重载过了、页面上还是什么都没有 —— **和"根本没装"一模一样**。
 *
 * 所以标记里放的是一对函数：新来的那份先问「你还活着吗」。
 * 活着就让位（真的重复注入），死了就叫它把自己的 DOM 收掉，然后接手。
 *
 * ⚠️ 「活着」只能由**它自己的闭包**去问 —— 孤儿手上的 `chrome` 引用才是失效的
 * 那一个。新来的这份问自己的 `chrome` 永远是活的，那不成其为判据。
 */
const FLAG = '__berrytraceRecordingInstalled';
export interface 装着的 { 活着(): boolean; 拆(): void }
type Flagged = Window & { [FLAG]?: 装着的 | boolean };

/**
 * 页面上已经有一份了，这一份该怎么办。
 *
 * 判定抠出来是因为**探测取决于浏览器**（扩展有没有被重载、孤儿的 chrome
 * 失效了没有），而判定不该取决于浏览器：`chrome.runtime.reload()` 在无头
 * 浏览器里根本复现不出来（实测：重载之后扩展的 service worker 再也没起来，
 * 等 150 秒也不回来），而它在真浏览器里是天天发生的事。
 * CLAUDE.md 六点六④。
 */
export function 该接手吗(上一份: 装着的 | boolean | undefined): 'take' | 'yield' | 'evict' {
  // 干净的页面
  if (!上一份) return 'take';
  /*
   * 旧版留下的布尔。它分辨不出死活 —— 但页面上此刻确实有一份（可能是孤儿）。
   * 保守按"活着"处理：这条只在"旧 content script + 新注入"这个过渡组合里
   * 走得到，而且下一次页面刷新就没有了。
   */
  if (上一份 === true) return 'yield';
  // 真的还活着 ⇒ 这一次是重复注入
  if (上一份.活着()) return 'yield';
  // 孤儿：扩展刚换过代码，它再也收不到任何消息了 ⇒ 让它收干净，这一份接手
  return 'evict';
}

/** 滚动上报的节流。太密的话一次滚轮能产出几十条，把事件流冲垮 */
const SCROLL_IDLE_MS = 400;

function main(): void {
  const w = window as Flagged;
  const 上一份 = w[FLAG];
  const 怎么办 = 该接手吗(上一份);
  if (怎么办 === 'yield') return;
  if (怎么办 === 'evict') {
    // 孤儿：让它把自己的 DOM 和监听器收干净，再接手
    try { (上一份 as 装着的).拆(); } catch { /* 孤儿拆自己时出错不该拦住新的这一份 */ }
  }

  let capturing = false;
  const toolbar = new RecordToolbar({
    onMark: () => { void send('berrytrace-recording-mark', undefined); },
    onStop: () => { void send('berrytrace-recording-stop', undefined); },
    onAnnotate: (target) => {
      void send('berrytrace-recording-annotate', {
        target,
        url: location.href, title: document.title,
        /*
         * 🔴 `visible-only`：我们标到的是**这一个元素**，而它未必装得下全部。
         * 列表往往一屏放不下 —— 如果他标的是那个容器，下游拿到的是整块；
         * 如果他标的是其中一行，下游只该认这一行。这里分不出来，
         * 所以一律如实写成"只覆盖了看得见的这一块"，**不许让下游以为拿到了全部**。
         */
        coverage: 'visible-only',
      });
    },
  });

  /*
   * 把"我在这儿，而且我还活着吗"登记上。
   * 🔴 `活着()` 问的是**这一份自己**手上的 chrome：扩展重载之后，
   * 孤儿这一份读 `chrome.runtime.id` 会拿到 undefined 或直接抛。
   */
  w[FLAG] = {
    活着: () => {
      try {
        return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
      } catch {
        return false;
      }
    },
    拆: () => {
      toolbar.unmount();
      setCapturing(false);
    },
  };

  // ── 与 service worker 的一问一答 ──────────────────────────────────────────

  function send(type: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (r) => {
          // 没人接会置 lastError；不读的话浏览器会往**用户的每个网页**
          // 控制台打一条 Unchecked runtime.lastError，那是不可接受的噪音
          void chrome.runtime.lastError;
          resolve(r);
        });
      } catch {
        // 扩展正在重载 / 上下文失效。这条路叫不动完全不该影响用户的网页
        resolve(undefined);
      }
    });
  }

  /**
   * 收到一份新状态。
   *
   * 🔴 **顺序是「先挂界面，再开采集」**。反过来的话会有一小段
   * "在采集但页面上没有任何提示" —— 那正是这条功能唯一不许违反的约束。
   */
  function apply(s: RecordingStateView | null | undefined): void {
    if (!s || !s.show) {
      toolbar.unmount();
      setCapturing(false);
      return;
    }
    toolbar.mount();
    toolbar.update(s);
    setCapturing(s.capture);
  }

  chrome.runtime.onMessage.addListener((msg: { type?: string; state?: RecordingStateView }) => {
    if (msg?.type === 'berrytrace-recording-state') apply(msg.state);
    // 不回值 ⇒ 不要 return true，否则通道会挂着等一个永远不来的应答
    return undefined;
  });

  // 页面一打开就问一次。**这一问本身还顺带把睡着的 worker 叫醒了**
  void send('berrytrace-recording-hello', undefined).then((r) => apply(r as RecordingStateView | null));

  // ── 采集 ──────────────────────────────────────────────────────────────────

  function setCapturing(on: boolean): void {
    if (on === capturing) return;
    capturing = on;
    if (on) {
      document.addEventListener('click', onClick, true);
      document.addEventListener('change', onChange, true);
      window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    } else {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('change', onChange, true);
      window.removeEventListener('scroll', onScroll, true);
      if (scrollTimer !== null) window.clearTimeout(scrollTimer);
      scrollTimer = null;
    }
  }

  /** 这一下是点在我们自己这条工具条上吗。**采集要绕开自己** */
  function isOurs(e: Event): boolean {
    const host = toolbar.element;
    if (!host) return false;
    // shadow root 是 closed 的，所以工具条内部任何一次点击，
    // 在页面看来 target 都是宿主那个 div —— 一次比较就够
    return e.target === host;
  }

  function report(it: WebInteraction): void {
    void send('berrytrace-recording-event', it);
  }

  function onClick(e: MouseEvent): void {
    // 拾取态下那一下是"我要标这个"，不是"我要点这个"。
    // 不排除的话，事件流里会多出一次他根本没打算做的点击
    if (toolbar.isPicking || isOurs(e)) return;
    const el = e.target as Element | null;
    report({
      kind: 'click',
      at: Date.now(),
      url: location.href,
      title: document.title,
      target: el && el.nodeType === 1 ? snapshotElement(el) : undefined,
      double: e.detail >= 2 ? true : undefined,
    });
  }

  function onChange(e: Event): void {
    if (isOurs(e)) return;
    const el = e.target as Element | null;
    if (!el || el.nodeType !== 1) return;
    const snap = snapshotElement(el);
    /*
     * 🔴 密码框的值**根本不读**（见 recordSnapshot.ts 的 mayReadValue）。
     * 宿主那边还会按 autocomplete / name 再判一次并脱敏 ——
     * 这里这一道是"根本没读"，那一道是"读到了也不存"，两件事都要有。
     */
    const it: WebInteraction = {
      kind: 'input',
      at: Date.now(),
      url: location.href,
      title: document.title,
      target: snap,
    };
    /*
     * 🔴 读不得的时候，`value` 这个键**根本不放上去**，不是放一个 undefined。
     * 〔0907 第七轮，真浏览器里当场量到的〕写成 `value: 可读 ? el.value : undefined`
     * 的话，这个键**是存在的** —— 后面碰巧有一跳 JSON 序列化会把它抹掉，
     * 于是看起来没事。但那是**下游替我们兜住的**，不是我们没读：
     * 哪天中间那跳换成结构化克隆（`chrome.runtime` 本来就是结构化克隆），
     * 一个 undefined 的键会原样传下去，而"有这个键"和"没有这个键"
     * 在下游是两种含义。
     */
    if (mayReadValue(el)) it.value = (el as HTMLInputElement).value;
    report(it);
  }

  let scrollTimer: number | null = null;
  let scrollFromX = 0;
  let scrollFromY = 0;
  let scrollPending = false;

  /**
   * 滚动**只在停下来之后报一条**，报的是这一整段的位移。
   *
   * 逐帧报的话一次滚轮能产出几十条事件，而下游要的只是
   * 「他往下滚了大约 800 像素找到了那个东西」这一件事。
   */
  function onScroll(): void {
    if (!scrollPending) {
      scrollPending = true;
      scrollFromX = window.scrollX;
      scrollFromY = window.scrollY;
    }
    if (scrollTimer !== null) window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      scrollTimer = null;
      scrollPending = false;
      const dx = window.scrollX - scrollFromX;
      const dy = window.scrollY - scrollFromY;
      // 净位移是 0 就别报：来回滚了一趟等于没动过
      if (dx === 0 && dy === 0) return;
      report({ kind: 'scroll', at: Date.now(), url: location.href, title: document.title, dx, dy });
    }, SCROLL_IDLE_MS);
  }
}

try {
  main();
} catch {
  /* 任何意外都不许影响用户的网页 —— 录制不成是小事，把别人的站点搞坏是大事 */
}
