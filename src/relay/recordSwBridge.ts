/**
 * 录制 · service worker 这一跳
 *
 * 链路：**页面 content script ↔ 这里 ↔ 本地 WebSocket 中继 ↔ 宿主 App**。
 *
 * 它做四件事，一件都不能少：
 *   ① 缓存宿主推来的录制态，并**广播给每一个标签页**；
 *   ② 页面新开时问「在录吗」，直接用缓存回答（宿主没连上时如实回 null）；
 *   ③ 把页面上的点击/输入/滚动/标注/打点/停止转给宿主；
 *   ④ **导航自己认**（tabs.onUpdated）—— content script 在导航那一刻正好被换掉，
 *      它自己报不了自己的离开；
 *   ⑤ **给已经开着的标签页补注入**（见 {@link tabsNeedingInjection}）——
 *      manifest 里的 content_scripts 只管"之后加载的页面"。
 *
 * ── 🔴 缓存为什么必须在这一层 ─────────────────────────────────────────────
 * 不缓存的话，每开一个标签都要往宿主问一趟；而 MV3 的 worker 随时会被回收，
 * 回收之后那一趟要先重连 WebSocket —— 用户看到的是**页面开了半天工具条才出来**，
 * 正是李博 0907 说的那个"插件还没准备好，需要用户等一下"。
 *
 * ⚠️ 缓存是会过期的：worker 被回收，缓存跟着没。所以 worker 一起来就
 * 主动问宿主要一次（`helloHost`），而不是等下一次状态推送。
 */

/** 与宿主 `browser-protocol.ts` 的 RECORDING_RPC 逐条对应。**两边必须一字不差** */
export const RECORDING_RPC = {
  state: 'berrytrace.recording.state',
  hello: 'berrytrace.recording.hello',
  event: 'berrytrace.recording.event',
  annotate: 'berrytrace.recording.annotate',
  mark: 'berrytrace.recording.mark',
  stop: 'berrytrace.recording.stop',
} as const;

export interface RecordingStateView {
  show: boolean;
  capture: boolean;
  phase: string;
  sessionId: string | null;
  steps: number;
  screenshotOnly: number;
  annotations: number;
  elapsedMs: number;
  suspendReason?: 'annotating' | 'paused' | 'own-window';
}

/** 这一层只需要中继的这一个能力，所以只要这一个 —— 免得和 relay 互相 import */
export interface HostChannel {
  sendToHost(method: string, params: unknown[]): Promise<unknown>;
}

let channel: HostChannel | null = null;
let cached: RecordingStateView | null = null;

/** 这一场里，往宿主发的上报被拒了几条。**只用来诊断，不改变任何行为** */
const stats = { sent: 0, refused: 0, failed: 0 };

export function recordingStats(): { sent: number; refused: number; failed: number; phase: string } {
  return { ...stats, phase: cached?.phase ?? 'unknown' };
}

/**
 * 这些标签页需要**补注入**一次 `relay-record.js`。
 *
 * ── 🔴 这条判据存在的理由（0907 第九轮，李博实机）────────────────────────
 * 「浏览器，对于**已经打开的页面**，没有工具条。」
 *
 * manifest 里的 `content_scripts` 只对**此后加载**的页面生效。用户按下开始录制
 * 那一刻已经开着的那十几个标签页，里面**一个字节的脚本都没有** ——
 * 它们既不会问"在录吗"，也收不到广播（`sendMessage` 那边没人接）。
 * 于是他切过去，看到的是什么都没有；而这一跳**全程零报错**：
 * 广播那边的 lastError 本来就当常态吞掉了（chrome:// 页面天天在置它）。
 *
 * ⚠️ 只挑 http/https。chrome:// 、扩展页、应用商店注入一律被系统拒绝，
 * 拒绝会以 lastError 的形式散在每一次补注入里，把真正的失败盖掉。
 * ⚠️ 重复注入是安全的：`recordContentScript.ts` 顶上那个 `__berrytraceRecordingInstalled`
 * 标记会让第二份当场返回。**但那是页面那侧兜的**，不是这里可以不管 ——
 * 兜不住的那天（比如标记改名）表现是一个页面上挂两条工具条。
 */
export function tabsNeedingInjection(
  tabs: ReadonlyArray<{ id?: number; url?: string }>,
): number[] {
  const out: number[] = [];
  for (const t of tabs) {
    if (typeof t.id !== 'number') continue;
    if (typeof t.url !== 'string' || !/^https?:\/\//i.test(t.url)) continue;
    out.push(t.id);
  }
  return out;
}

/**
 * 往已经开着的标签页里补一次。
 *
 * 🔴 **只在"从没在录变成在录"时扫一遍**，不是每次状态推送都扫：
 * 角标数字一变就是一次推送，一秒钟能来好几次 —— 每次都去 executeScript
 * 的话，用户机器上会有几十个标签页同时被注入，浏览器当场卡一下，
 * 而"录制让我的浏览器变卡"是这条功能被关掉的最快理由。
 */
function sweepInjectExisting(): void {
  try {
    chrome.tabs.query({}, (tabs) => {
      void chrome.runtime.lastError;
      for (const id of tabsNeedingInjection(tabs as Array<{ id?: number; url?: string }>)) {
        try {
          const r = chrome.scripting.executeScript({
            target: { tabId: id },
            files: ['relay-record.js'],
          }) as unknown as Promise<unknown> | undefined;
          // 拒绝是常态（受保护的页面、正在崩溃的标签），一条都不该打日志
          if (r && typeof (r as Promise<unknown>).catch === 'function') {
            void (r as Promise<unknown>).catch(() => {});
          }
        } catch { /* 这一个注入不进去，不影响别的 */ }
      }
    });
  } catch { /* 没有 scripting 权限 / 上下文没了。下一次开始录制再说 */ }
}

/**
 * 把状态发给每一个标签页。
 *
 * ⚠️ `sendMessage` 对没有 content script 的标签（chrome:// 之类）会置 lastError，
 * 那是**正常**的，不是故障 —— 逐个吞掉，不打日志。每次状态变化打一屏日志的话，
 * 真正的故障会被埋掉。
 */
function broadcast(state: RecordingStateView | null): void {
  try {
    chrome.tabs.query({}, (tabs) => {
      void chrome.runtime.lastError;
      for (const t of tabs) {
        if (typeof t.id !== 'number') continue;
        try {
          chrome.tabs.sendMessage(t.id, { type: 'berrytrace-recording-state', state }, () => {
            void chrome.runtime.lastError;
          });
        } catch { /* 这个标签没人接，正常 */ }
      }
    });
  } catch { /* 权限或上下文没了，下一次状态变化再说 */ }
}

/** 宿主推来一份新状态。**缓存 + 广播**，这是页面亮起来的唯一来源 */
export function onHostRecordingState(state: RecordingStateView | null): void {
  const 之前 = cached?.show === true
  cached = state
  broadcast(cached)
  // 从"没在录"翻成"在录"的那一下，把已经开着的标签页补上（见 tabsNeedingInjection）
  if (!之前 && cached?.show === true) sweepInjectExisting()
}

/**
 * 主动问宿主要一次当前状态。worker 一起来、以及中继（重）连上时调。
 *
 * 🔴 问不到**不等于没在录**，所以失败时**不动缓存也不广播** ——
 * 广播一个 null 会把页面上那条工具条撤掉，而录制其实还在跑：
 * 那就是"在录但没提示"，本模块唯一不许出现的状态。
 */
export async function helloHost(): Promise<void> {
  if (!channel) return;
  try {
    const s = (await channel.sendToHost(RECORDING_RPC.hello, [])) as RecordingStateView | null;
    const 之前 = cached?.show === true;
    cached = s ?? null;
    broadcast(cached);
    /*
     * 🔴 worker 刚起来（MV3 随时回收）时缓存是空的，而录制可能已经在跑了 ——
     * 这一趟问回来的 show:true 对**所有**已经开着的标签页都是"补注入"的信号，
     * 不只是对新开的那个。少了这一句，worker 被回收一次之后，
     * 用户切回旧标签页看到的还是什么都没有。
     */
    if (!之前 && cached?.show === true) sweepInjectExisting();
  } catch {
    /* 宿主没起来 / 中继没连上。保持现状，等下一次推送 */
  }
}

async function forward(method: string, payload: unknown): Promise<unknown> {
  if (!channel) {
    stats.refused += 1;
    return { ok: false, reason: '还没连上 App' };
  }
  try {
    stats.sent += 1;
    const r = (await channel.sendToHost(method, payload === undefined ? [] : [payload])) as
      { ok?: boolean; state?: RecordingStateView } | undefined;
    // 宿主每条应答都捎回一份最新状态 —— 顺手更新缓存，
    // 页面上的角标就不用等下一次推送了
    if (r && r.state) {
      cached = r.state;
      broadcast(cached);
    }
    if (r && r.ok === false) stats.refused += 1;
    return r;
  } catch (e) {
    stats.failed += 1;
    return { ok: false, reason: String((e as Error)?.message ?? e) };
  }
}

/**
 * 装上这一跳。**在 service worker 顶层同步调**（和别的事件源同一条纪律：
 * 注册这件事本身就是唤醒源，回调体空不空都得注册）。
 */
export function installRecordingSwBridge(ch: HostChannel): void {
  channel = ch;
  /*
   * 🔴 装上 = **这个 worker 刚起来**，所以缓存从零开始。
   * MV3 里 worker 被回收之后一切内存状态都没了；留着上一条命的缓存
   * 会让新起来的 worker 用一个可能早就过期的状态去回答页面
   * （"在录吗"——它答"在"，而录制半小时前就停了）。
   * 补上的那一手不在这个函数里：中继一连上就会调
   * {@link onRelayConnectedForRecording} 去现问一次。
   */
  cached = null;
  stats.sent = 0;
  stats.refused = 0;
  stats.failed = 0;

  chrome.runtime.onMessage.addListener((msg: { type?: string; payload?: unknown }, _sender, sendResponse) => {
    const type = msg?.type;
    if (type === 'berrytrace-recording-hello') {
      // 🔴 用缓存直接回，**不等宿主** —— 等的话新标签要愣好几秒才亮工具条
      sendResponse(cached);
      return undefined;
    }
    if (type === 'berrytrace-recording-event') {
      void forward(RECORDING_RPC.event, msg.payload).then(sendResponse);
      return true;
    }
    if (type === 'berrytrace-recording-annotate') {
      void forward(RECORDING_RPC.annotate, msg.payload).then(sendResponse);
      return true;
    }
    if (type === 'berrytrace-recording-mark') {
      void forward(RECORDING_RPC.mark, undefined).then(sendResponse);
      return true;
    }
    if (type === 'berrytrace-recording-stop') {
      void forward(RECORDING_RPC.stop, undefined).then(sendResponse);
      return true;
    }
    return undefined;
  });

  /*
   * 导航只能在这一层认。
   *
   * 🔴 content script 在真导航那一刻**连同页面一起被换掉**了 ——
   * 它报不了自己的离开，也来不及报新页面的到达（新的那份要等 document_idle）。
   * 而"他从哪儿跳到哪儿"是整条录制里最要紧的骨架之一：少了它，
   * 生成出来的自动化会在一个它以为还停在上一页的地方去点东西。
   */
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!cached?.capture) return;
    if (!changeInfo.url) return;
    if (!/^https?:/i.test(changeInfo.url)) return;
    void forward(RECORDING_RPC.event, {
      kind: 'navigate',
      at: Date.now(),
      url: changeInfo.url,
      title: tab?.title,
      navKind: 'load',
    });
  });
}

/** 中继（重）连上了。worker 刚起来时缓存是空的，这时候要主动去要一次 */
export function onRelayConnectedForRecording(): void {
  void helloHost();
}
