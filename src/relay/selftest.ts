/**
 * @module RelaySelfTest
 * ─────────────────────────────────────────────────────────────────────────────
 * 莓莓印记 · 自动化**三档路自测**。跑在扩展里，由本机 App 通过 relay 触发。
 *
 * ── 为什么自测要写在插件里，而不是全放在宿主的 e2e 脚本里 ──────────────────
 * 这三档的差别**只有在浏览器进程内部才看得见**：
 *   · 「有没有挂 debugger」只有扩展自己知道（`chrome.debugger.getTargets()`）；
 *   · 「点击是不是可信事件」只有页面里的监听器看得见；
 *   · 「content script 抽取」根本不经过宿主。
 * 宿主脚本只能看到最终结果，看不见是哪条路走出来的 —— 而这一轮要证明的恰恰是**路**。
 *
 * ── 三档路（李博 0828 提的三点，逐条对上）────────────────────────────────
 * | 档 | 他的说法 | 承载 | 页面能不能发现我们 |
 * |---|---|---|---|
 * | **L1** | 「AI 接管电脑，全程用户可见」 | 桌面自动化（真鼠标真键盘） | 发现不了（事件来自操作系统） |
 * | **L2** | 「静默获取网页内容并执行操作」 | `chrome.debugger` CDP | **取决于开不开域**，见下 |
 * | **L3** | 「不让第三方知道 CDP 的存在，直接操作 DOM」 | content script ＋ Defuddle | 只有 `isTrusted=false` 这一处 |
 *
 * L1 的**桌面那一半在宿主**（`ax_helper`），插件这边只负责它需要的那一步：
 * 把目标标签切到前台、把窗口提到最前，好让用户看得见 AI 在干什么。
 *
 * ── 🔴 本模块要证明的四条判据（每条都带反证）──────────────────────────────
 * ① **L3 全程零 CDP**：抽完内容后 `chrome.debugger.getTargets()` 里这个标签
 *    `attached` 必须不为真。反证：L2 跑完同一个标签，它必须为真。
 * ② **`Runtime.enable` 是唯一会被时序探针出卖的开关**〔本机已先量过：
 *    不开域 0.6ms / 开了 3.2ms，5 倍〕。本模块在真浏览器里复量一遍，
 *    并**主动开一次**作为反证 —— 探针必须变红，否则说明探针本身失效了。
 * ③ **可信事件**：CDP `Input.dispatchMouseEvent` 出来的点击 `isTrusted === true`；
 *    而 L3 那种 `el.click()` 是 `false`。⇒ **要点东西就别用 L3**，这是档位选择的硬边界。
 * ④ **插件自己能开新标签**（`chrome.tabs.create`），不需要桌面自动化 ——
 *    这一条是冲着「打开新标签插件完成不了」这个前提去的，成立与否直接改架构。
 *
 * ── 边界（别把这份报告读大了）───────────────────────────────────────────────
 * 探针只有三类（Error getter / `navigator.webdriver` / console 时序）。
 * **「我们这套探针探不到」不等于「第三方探不到」** —— 专业风控厂商的手段更多。
 * 报告里凡是「探不到」，读作「这三类探针探不到」。
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type LaneCase = {
  lane: 'env' | 'L1' | 'L2' | 'L3';
  name: string;
  ok: boolean;
  detail: string;
};

export type SelfTestReport = {
  cases: LaneCase[];
  timings: Record<string, number>;
  ua: string;
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/* ──────────────────── MAIN world 探针 ────────────────────
 * 这几个函数会被 `chrome.scripting.executeScript` 整个序列化注入页面主世界，
 * **不能引用模块作用域里的任何东西**（闭包不会跟过去，注入后是另一个 realm）。
 * 踩过的形状：引用了外面的常量 ⇒ 注入后 ReferenceError，而 executeScript
 * 只回一个 undefined，看着像「页面没响应」。
 */

/** 时序探针：Runtime 域开着的时候，每次 console.* 都要序列化成 RemoteObject 发出去。 */
function mainProbeTiming(): { consoleMs: number; webdriver: boolean; stackGetter: boolean } {
  const flags = { stackGetter: false };
  const err = new Error('probe');
  Object.defineProperty(err, 'stack', {
    configurable: true,
    get() { flags.stackGetter = true; return 'S'; },
  });
  console.debug(err);

  const big: Record<string, unknown> = {};
  for (let i = 0; i < 500; i++) big['k' + i] = { a: i, b: 'x'.repeat(200), c: [1, 2, 3, 4, 5] };
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) console.log(big);
  const consoleMs = performance.now() - t0;
  console.clear();

  return { consoleMs, webdriver: (navigator as { webdriver?: boolean }).webdriver === true, stackGetter: flags.stackGetter };
}

/** 装一个可信度探针：一个按钮 + 一个记录 `isTrusted` 的监听器。回它的中心坐标。 */
function mainInstallTrustProbe(): { x: number; y: number } {
  const w = window as unknown as { __btTrust?: { clicks: number; trusted: boolean | null } };
  w.__btTrust = { clicks: 0, trusted: null };
  let btn = document.getElementById('bt-selftest-btn') as HTMLButtonElement | null;
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'bt-selftest-btn';
    btn.textContent = 'bt-selftest';
    btn.style.cssText = 'position:fixed;left:12px;top:12px;z-index:2147483647;width:140px;height:40px';
    document.body.appendChild(btn);
  }
  btn.addEventListener('click', (e) => {
    w.__btTrust!.clicks++;
    w.__btTrust!.trusted = e.isTrusted;
  });
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function mainReadTrustProbe(): { clicks: number; trusted: boolean | null } {
  const w = window as unknown as { __btTrust?: { clicks: number; trusted: boolean | null } };
  return w.__btTrust ?? { clicks: -1, trusted: null };
}

/** L3 那种「页面内点击」：DOM 直接点，**没有任何 CDP 参与**。 */
function mainDomClick(): void {
  (document.getElementById('bt-selftest-btn') as HTMLButtonElement | null)?.click();
}

/* ──────────────────── 工具 ──────────────────── */

/**
 * HTML → Markdown。**必须绕到 offscreen 文档里做**。
 *
 * 🔴 在 service worker 里直接调 `createMarkdownContent()` **不报错**，
 * 只会返回一句 `Partial conversion completed with errors. Original HTML: …`
 * 后面跟着原样 HTML —— 因为 turndown 要 DOM，而 worker 里没有。
 * 这是静默降级：`markdown.length > 50` 这种判据照样绿。0828 实测被骗过一轮。
 */
async function htmlToMarkdown(html: string, url: string): Promise<{ ok: boolean; markdown?: string; error?: string }> {
  const OFFSCREEN = 'offscreen.html';
  // `hasDocument()` 在部分版本上没有，用 getContexts 兜底；两条都失败就直接试着建。
  try {
    const existing = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] });
    if (!existing || existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN,
        reasons: ['DOM_PARSER' as chrome.offscreen.Reason],
        justification: '把抓到的网页 HTML 转成 Markdown（turndown 需要 DOM）',
      });
    }
  } catch (e) {
    // 已经建过会抛「Only a single offscreen document may be created」，那是正常的
    if (!String((e as Error)?.message ?? '').includes('single offscreen')) {
      return { ok: false, error: String((e as Error)?.message ?? e) };
    }
  }
  const res = await chrome.runtime.sendMessage({ target: 'bt-offscreen', action: 'html2md', html, url });
  return (res ?? { ok: false, error: '离屏文档没有回音' }) as { ok: boolean; markdown?: string; error?: string };
}

async function inMainWorld<T>(tabId: number, func: () => T): Promise<T | undefined> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: func as () => unknown,
  });
  return res?.result as T | undefined;
}

/** 等 content script 就绪。**不要用固定 sleep** —— 慢机器上它比你想的晚。 */
async function waitContentScript(tabId: number, tries = 30): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      if (r) return true;
    } catch {
      // content script 还没注入，正常，继续等
    }
    await sleep(300);
  }
  return false;
}

async function isDebuggerAttached(tabId: number): Promise<boolean> {
  const targets = await chrome.debugger.getTargets();
  return targets.some(t => t.tabId === tabId && t.attached === true);
}

/* ──────────────────── 主流程 ──────────────────── */

/**
 * @param onCase 每条判据出结果就回调一次。
 *
 * 🔴 **这个回调不是锦上添花，是诊断的唯一手段。**〔0828 实测〕
 * 第一次在李博的 Mac 上跑，连接在自测中途断了，宿主只看到一句
 * `BROWSER_EXTENSION_DISCONNECTED` —— **断在哪一步完全不知道**，
 * 而扩展那边的报错停在浏览器里，他的日常浏览器又没有调试端口可以进去看。
 * 逐条上报之后，「最后一条成功的判据」就是断点的位置。
 */
export async function runSelfTest(
  opts: { fixtureBase: string },
  onCase?: (c: LaneCase) => void,
): Promise<SelfTestReport> {
  const cases: LaneCase[] = [];
  const timings: Record<string, number> = {};
  const add = (lane: LaneCase['lane'], name: string, ok: boolean, detail = '') => {
    const c: LaneCase = { lane, name, ok, detail };
    cases.push(c);
    try { onCase?.(c); } catch { /* 上报失败不该把自测本身带塌 */ }
  };

  const url = `${opts.fixtureBase}/page?tag=selftest`;
  let tabId: number | null = null;
  let attached = false;

  try {
    /* ── env ── */
    const hasDebugger = await chrome.permissions.contains({ permissions: ['debugger'] });
    add('env', 'debugger 权限已授予', hasDebugger,
      hasDebugger ? '' : '未授予 —— L2 会整档跳过');

    if (!hasDebugger) {
      // 🔴 **这一步是判据，不是补救。**〔0828 实测〕
      // `debugger` 是 Chrome 的**不可选权限**：即使写进 `optional_permissions`
      // （`getManifest()` 里还照样读得到它），`permissions.request()` 也会当场拒
      // `Only permissions specified in the manifest may be requested.`
      // ⇒ 它只能是常驻权限。跑到这一支说明装的是旧包，报出来的原话就是证据。
      try {
        const granted = await chrome.permissions.request({ permissions: ['debugger'] });
        add('env', '反证：运行时申请 debugger 权限必然失败', false,
          `居然成功了，返回 ${granted} —— 与 0828 的实测相反，规则可能变了，要重新量`);
      } catch (e) {
        add('env', '反证：运行时申请 debugger 权限必然失败（它是不可选权限）', true,
          String((e as Error)?.message ?? e));
      }
    }

    /* ── ④ 插件自己开新标签 ── */
    const t0 = Date.now();
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id ?? null;
    timings.tabCreateMs = Date.now() - t0;
    add('L3', '④ 插件自己就能开新标签（不需要桌面自动化）', tabId != null,
      `tabId=${tabId} active=${tab.active} 耗时 ${timings.tabCreateMs}ms`);
    add('L3', '④b 新标签在后台，不抢用户焦点', tab.active === false, `active=${tab.active}`);
    if (tabId == null) throw new Error('标签没建起来');

    const ready = await waitContentScript(tabId);
    add('L3', 'content script 就绪', ready, ready ? '' : '等了 9 秒没等到 ping');

    /* ── L3 · 隐蔽档：content script + Defuddle，零 CDP ── */
    const t1 = Date.now();
    const extracted = await chrome.tabs.sendMessage(tabId, { action: 'getPageContent' }) as
      { content?: string; title?: string; success?: boolean; error?: string } | undefined;
    timings.extractMs = Date.now() - t1;

    const html = extracted?.content ?? '';
    add('L3', '① 用 clipper 自己的管线抽到正文（Defuddle 在页面里跑）',
      html.length > 50, `HTML ${html.length} 字符，标题「${extracted?.title ?? ''}」，耗时 ${timings.extractMs}ms`);

    const conv = html ? await htmlToMarkdown(html, url) : { ok: false, error: '没有 HTML' };
    const md = conv.markdown ?? '';
    // 🔴 判据里那句 `!md.includes('Partial conversion')` 是**反降级**判据：
    // 少了它，worker 里那条静默降级会以「有 50 个字符」的姿态混过去。
    // 判据钉在**正文结尾那个标记**上：抽取器只抽到标题时字数也能过百，
    // 只有结尾标记在，才说明整篇正文都拿到了。
    add('L3', '① 转成 Markdown（走 offscreen 文档，那里才有 DOM）',
      conv.ok && md.includes('BT-LANES-FIXTURE-END') && !md.includes('Partial conversion'),
      conv.ok ? `Markdown ${md.length} 字符：${JSON.stringify(md.slice(0, 70))}` : `失败：${conv.error}`);

    const attachedAfterL3 = await isDebuggerAttached(tabId);
    add('L3', '🔴 ① 判据：整档跑完，这个标签上一次 debugger 都没挂过',
      attachedAfterL3 === false, `getTargets().attached = ${attachedAfterL3}`);

    // 探针基线：这一档下页面看到的应该跟「完全没人动它」一样
    await inMainWorld(tabId, mainInstallTrustProbe);
    const baseline = await inMainWorld(tabId, mainProbeTiming);
    timings.consoleBaselineMs = baseline?.consoleMs ?? -1;
    add('L3', '② L3 下页面的时序探针 = 干净基线', (baseline?.consoleMs ?? 99) < 2,
      `60 次 console.log 大对象 = ${baseline?.consoleMs?.toFixed(2)}ms（挂了 Runtime.enable 会到 3ms+）`);
    add('L3', '② navigator.webdriver 仍是 false', baseline?.webdriver === false, `${baseline?.webdriver}`);

    // ③ 的一半：L3 的点击是不可信事件
    await inMainWorld(tabId, mainDomClick);
    await sleep(200);
    const afterDomClick = await inMainWorld(tabId, mainReadTrustProbe);
    add('L3', '🔴 ③ L3 的点击是 isTrusted=false（页面一眼看穿）',
      afterDomClick?.trusted === false,
      `clicks=${afterDomClick?.clicks} trusted=${afterDomClick?.trusted}`);

    /* ── L2 · 静默 CDP 档 ── */
    if (!hasDebugger) {
      add('L2', 'L2 整档跳过', false, '没有 debugger 权限');
    } else {
      await chrome.debugger.attach({ tabId }, '1.3');
      attached = true;
      add('L2', 'attach 成功', await isDebuggerAttached(tabId), '');

      // 🔴 刻意**不 enable 任何域**。Runtime.evaluate / Input.* 都不需要 enable。
      const title = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate',
        { expression: 'document.title', returnByValue: true }) as { result?: { value?: string } };
      add('L2', '不开任何域也能读 DOM', typeof title?.result?.value === 'string',
        `document.title = ${JSON.stringify(title?.result?.value)}`);

      const quiet = await inMainWorld(tabId, mainProbeTiming);
      timings.consoleAttachedNoDomainMs = quiet?.consoleMs ?? -1;
      add('L2', '🔴 ② 挂着 debugger 但不开域 ⇒ 时序探针与基线一致（探不到）',
        (quiet?.consoleMs ?? 99) < 2,
        `${quiet?.consoleMs?.toFixed(2)}ms vs 基线 ${baseline?.consoleMs?.toFixed(2)}ms`);

      // ③ 另一半：CDP 合成点击是可信事件
      //
      // 🔴 **必须先 `setFocusEmulationEnabled`**〔0828 实测〕：后台标签不合成画面，
      // `Input.dispatchMouseEvent` 的命中测试打空 —— 现象是**命令成功、点击没发生**
      // （clicks 一直是 0，没有任何报错）。这条跟「后台标签不渲染」是同一个根因，
      // 数据见 `台账/自动化/0828-后台标签页到底渲不渲染.md`。
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      const box = await inMainWorld(tabId, mainInstallTrustProbe);
      if (box) {
        for (const type of ['mousePressed', 'mouseReleased'] as const) {
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
            { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
        }
        await sleep(250);
        const afterCdpClick = await inMainWorld(tabId, mainReadTrustProbe);
        add('L2', '🔴 ③ CDP 合成点击是 isTrusted=true（页面分辨不出）',
          afterCdpClick?.trusted === true,
          `clicks=${afterCdpClick?.clicks} trusted=${afterCdpClick?.trusted}`);
      }

      // ② 的反证：主动开一次 Runtime.enable，探针**必须**变红。
      // 没有这一步，「探不到」可能只是探针本身坏了。
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
      const noisy = await inMainWorld(tabId, mainProbeTiming);
      timings.consoleRuntimeEnabledMs = noisy?.consoleMs ?? -1;
      const ratio = (noisy?.consoleMs ?? 0) / Math.max(quiet?.consoleMs ?? 1, 0.01);
      add('L2', '🔴 ② 反证：开了 Runtime.enable，探针必须变红',
        (noisy?.consoleMs ?? 0) > (quiet?.consoleMs ?? 0) * 2,
        `${noisy?.consoleMs?.toFixed(2)}ms，是不开域的 ${ratio.toFixed(1)} 倍`);
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.disable');
    }

    /* ── L1 · 可见接管（插件负责的那一步）── */
    const shown = await chrome.tabs.update(tabId, { active: true });
    if (shown?.windowId != null) await chrome.windows.update(shown.windowId, { focused: true });
    await sleep(400);
    const nowTab = await chrome.tabs.get(tabId);
    add('L1', '把标签摆到用户眼前（可见接管的插件侧那一步）',
      nowTab.active === true, `active=${nowTab.active} windowId=${nowTab.windowId}`);
    add('L1', '桌面自动化那一半不在插件里', true, '由宿主 ax_helper 负责，见宿主脚本 L1 段');

  } catch (e) {
    add('env', '自测本身挂了', false, String((e as Error)?.message ?? e));
  } finally {
    if (tabId != null) {
      if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  }

  return { cases, timings, ua: navigator.userAgent };
}
