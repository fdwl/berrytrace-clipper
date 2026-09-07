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
 *      它自己报不了自己的离开。
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
  cached = state && state.show ? state : state;
  broadcast(cached);
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
    cached = s ?? null;
    broadcast(cached);
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
