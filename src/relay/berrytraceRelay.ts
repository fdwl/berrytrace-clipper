/**
 * @module BerrytraceRelay
 * ─────────────────────────────────────────────────────────────────────────────
 * 莓莓印记 · 自动化中继（S10）。把**本机 App** 和浏览器里某个标签页的 CDP 接通。
 *
 * ── 这一层刻意很薄，因为干活的两块都不是我们写的 ────────────────────────────
 *   · 扩展侧的转发引擎 `RelayConnection`：Apache-2.0，原样取自
 *     `microsoft/playwright` 的 `packages/extension/src/relayConnection.ts`。
 *     它把 `chrome.debugger.*` / `chrome.tabs.*` 暴露成一条 RPC 通道，**不含任何业务逻辑**。
 *   · 宿主侧是 `berrytrace_app` 的 `electron/services/browser-extension-relay.ts`，
 *     **那是我们自己写的最小版**，不是 Playwright 的 `cdpRelay`：本仓动作层只要五个方法，
 *     用裸 CDP 一一对应就够了，不需要把扩展伪装成一个完整 browser。
 *   ⇒ 我们只需要「把连接建起来、决定 attach 哪个标签」。
 *      **别往 `relayConnection.ts` 里塞逻辑**（那份要跟上游走），
 *      要加就加在本文件或宿主侧。
 *
 * ── 为什么不照抄官方那套「点扩展图标 → 选标签 → 连」的流程 ──────────────────
 * 官方的场景是**人坐在电脑前**，让 AI 接管眼前这个标签页。
 * 我们的场景是 **App 在后台跑任务，用户不该被打断**（李博 0826 的第一条约束就是「不干扰」，
 * 见 `台账/条目/0826-S10承载体三条路实测.md` 第四节）。
 * ⇒ 连接由 **App 侧发起**；标签一律 `active: false` 在后台开，不抢用户当前视图。
 *
 * ── 三条踩过的判据，改之前先看 ───────────────────────────────────────────────
 * 1. **`debugger` 权限是 optional 的**，不在 manifest 的常驻 `permissions` 里。
 *    纯剪藏用户永远不会看到「正在调试此浏览器」那条黄条，商店审核也好解释。
 *    ⇒ 每次建会话前必须 `chrome.permissions.request`，不能假设它已经在了。
 * 2. **Firefox / Safari 上这一层整个不启用**：Safari 没有 `chrome.debugger` API
 *    （台账同条第九节），Firefox 的 debugger API 形状也不同。
 *    运行时按 `chrome.debugger` 在不在来判，不靠构建期开关 —— 三套构建共用一份源码。
 * 3. **token 不是防君子的**：网页 JS 也能连 `ws://127.0.0.1`，WebSocket 不受同源策略拦。
 *    所以宿主侧必须同时校验 token 和 Origin，扩展侧则永远不把 token 写进页面可读的地方。
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { RelayConnection, debugLog } from './relayConnection';

/** 宿主 App 监听的默认端口。可被设置覆盖 —— 端口撞车是常态，不是异常。 */
const DEFAULT_RELAY_PORT = 47823;

/** 断线后的重连节奏。指数退避，封顶 30s：App 没开着的时候不该每秒敲一次。 */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

type RelaySettings = {
  /** 没配对过就是 null —— 此时**不连**，避免空连接把宿主日志刷满。 */
  token: string | null;
  port: number;
  /** 用户可以在设置里整个关掉自动化，剪藏功能不受影响。 */
  enabled: boolean;
};

/** App 在 relay 通道上发的控制指令（在 Playwright 那套 CDP 协议之外，先握手用）。 */
type ControlMessage =
  | { type: 'session.start'; url?: string; windowId?: number }
  | { type: 'session.stop' }
  | { type: 'ping' };

export class BerrytraceRelay {
  private _ws: WebSocket | null = null;
  private _connection: RelayConnection | null = null;
  private _reconnectDelay = RECONNECT_MIN_MS;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _stopped = false;

  /**
   * 这一层能不能用。**运行时判，不看构建目标** —— 同一份源码要能在
   * chrome / firefox / safari 三套产物里都不炸（判据 2）。
   */
  static isSupported(): boolean {
    return typeof chrome !== 'undefined' && !!(chrome as any).debugger && !!chrome.tabs;
  }

  async start(): Promise<void> {
    if (!BerrytraceRelay.isSupported()) {
      debugLog('本浏览器没有 chrome.debugger，自动化中继不启用（剪藏功能不受影响）');
      return;
    }
    this._stopped = false;
    await this._connectLoop();
  }

  stop(): void {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._connection?.close('本地停止');
    this._connection = null;
    this._ws?.close();
    this._ws = null;
  }

  private async _settings(): Promise<RelaySettings> {
    const raw = await chrome.storage.local.get(['btRelayToken', 'btRelayPort', 'btRelayEnabled']);
    return {
      token: (raw.btRelayToken as string) ?? null,
      port: (raw.btRelayPort as number) ?? DEFAULT_RELAY_PORT,
      // 默认开：装了插件却还要再找个开关打开，等于又加一道安装摩擦。
      enabled: raw.btRelayEnabled !== false,
    };
  }

  private async _connectLoop(): Promise<void> {
    if (this._stopped) return;
    const settings = await this._settings();
    if (!settings.enabled || !settings.token) {
      // 没配对过就安静地待着。**不要在这里重试** —— 配对完成时会显式再调 start()。
      debugLog('自动化中继未配对或已关闭，待机');
      return;
    }
    this._open(settings);
  }

  private _open(settings: RelaySettings): void {
    const url = `ws://127.0.0.1:${settings.port}/extension?token=${encodeURIComponent(settings.token!)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.onopen = () => {
      debugLog('自动化中继已连上宿主', settings.port);
      // 连上就把退避重置掉，否则一次长断线会让后面每次重连都慢 30s。
      this._reconnectDelay = RECONNECT_MIN_MS;
    };

    ws.onclose = () => {
      this._connection = null;
      this._ws = null;
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // onerror 之后一定还会来一次 onclose，重连只挂在 onclose 上，别重复排队。
    };

    ws.onmessage = (event: MessageEvent) => {
      // RelayConnection 一旦接管，就由它自己处理 onmessage；这里只处理接管**之前**
      // 的控制消息。判据：接管后 this._connection 非空。
      if (this._connection) return;
      let msg: ControlMessage;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      void this._onControlMessage(msg, ws);
    };
  }

  private async _onControlMessage(msg: ControlMessage, ws: WebSocket): Promise<void> {
    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      case 'session.stop':
        this._connection?.close('宿主要求结束会话');
        this._connection = null;
        return;
      case 'session.start':
        await this._startSession(msg, ws);
        return;
    }
  }

  /**
   * 建一次自动化会话：后台开标签 → attach → 把 ws 交给 RelayConnection。
   *
   * 🔴 `active: false` 这一条是**约束不是偏好**：它是「不干扰」的落点。
   * 改成 true 之前先想清楚用户正在干什么 —— 抢标签焦点是我们被否掉过的形态。
   */
  private async _startSession(msg: { url?: string; windowId?: number }, ws: WebSocket): Promise<void> {
    try {
      // 判据 1：debugger 是 optional 权限，每次都要确认，不能假设它在。
      const granted = await chrome.permissions.request({ permissions: ['debugger'] });
      if (!granted) {
        ws.send(JSON.stringify({ type: 'session.error', error: 'PERMISSION_DENIED_DEBUGGER' }));
        return;
      }

      const tab = await chrome.tabs.create({
        url: msg.url ?? 'about:blank',
        active: false,
        windowId: msg.windowId,
      });

      const connection = new RelayConnection(ws);
      connection.onclose = () => {
        this._connection = null;
      };
      this._connection = connection;
      connection.attachTab(tab as chrome.tabs.Tab);
      // 宿主会一直扣着 Playwright 侧的 CDP 消息，直到收到这一声。
      connection.didInitialize();
    } catch (e: any) {
      ws.send(JSON.stringify({ type: 'session.error', error: String(e?.message ?? e) }));
    }
  }

  private _scheduleReconnect(): void {
    if (this._stopped || this._reconnectTimer) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      void this._connectLoop();
    }, delay);
  }
}

let singleton: BerrytraceRelay | null = null;
let pairListenerInstalled = false;

/** background 里调一次即可。重复调用是安全的（service worker 会重启，这很常见）。 */
export function initBerrytraceRelay(): BerrytraceRelay {
  if (!singleton) singleton = new BerrytraceRelay();
  void singleton.start();
  // service worker 每次重启都会重新执行本文件，监听器只装一次，
  // 否则一条配对消息会触发好几次重连。
  if (!pairListenerInstalled && typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    pairListenerInstalled = true;
    chrome.runtime.onMessage.addListener((message: { type?: string } | undefined) => {
      // 用户在配对页点了「允许」，token 刚落盘 —— 立刻连，
      // 不然他要盯着一个「未连接」的界面等完整个退避周期。
      if (message?.type === 'berrytrace-relay-paired') restartBerrytraceRelay();
    });
  }
  return singleton;
}

/** 配对完成（拿到 token）之后调它，立刻连上，不用等退避计时。 */
export function restartBerrytraceRelay(): void {
  singleton?.stop();
  singleton = null;
  initBerrytraceRelay();
}
