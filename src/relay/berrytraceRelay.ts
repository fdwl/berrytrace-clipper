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
 * 1. 🔴 **`debugger` 只能是必需权限，不能是 optional**〔0828 实测订正〕。
 *    本文件上一版写的是「optional + 每次建会话前 `permissions.request`」，
 *    **那条路从写下来那天起就不通**：Chrome 把 `debugger` 列在「不可选」名单里，
 *    `request()` 当场拒 `Only permissions specified in the manifest may be requested.`；
 *    而 `getManifest().optional_permissions` 里**还照样看得见它** ——
 *    配置看着生效、运行时静默失效，不实测发现不了。
 *    （同一份 optional 里的 `tabs` 就能正常弹确认框，所以不是写法问题。）
 *    ⇒ manifest 里它已挪进常驻 `permissions`。本层只 `contains` 确认，不 `request`。
 *    代价：将来上商店时安装页会多一条权限说明。解压安装那条路不弹任何框。
 * 2. **Firefox / Safari 上这一层整个不启用**：Safari 没有 `chrome.debugger` API
 *    （台账同条第九节），Firefox 的 debugger API 形状也不同。
 *    运行时按 `chrome.debugger` 在不在来判，不靠构建期开关 —— 三套构建共用一份源码。
 * 3. **token 不是防君子的**：网页 JS 也能连 `ws://127.0.0.1`，WebSocket 不受同源策略拦。
 *    所以宿主侧必须同时校验 token 和 Origin，扩展侧则永远不把 token 写进页面可读的地方。
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { RelayConnection, debugLog } from './relayConnection';
import { runSelfTest } from './selftest';

/** 宿主 App 监听的默认端口。可被设置覆盖 —— 端口撞车是常态，不是异常。 */
const DEFAULT_RELAY_PORT = 47823;

/** 断线后的重连节奏。指数退避，封顶 30s：App 没开着的时候不该每秒敲一次。 */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * 🔴 **MV3 的两条硬约束，这一层的形状全是被它们逼出来的**（0828 本机实测，都踩过）：
 *
 * 1. **service worker 空闲 30 秒就被回收**，连接跟着断。
 *    Chrome 116 起 WebSocket 收发消息会重置这个计时器 ⇒ 只要我们自己按时说话，
 *    连着的时候就不会被回收。间隔取 20s，留 10s 余量（网络抖一下不至于正好踩线）。
 * 2. 🔴 **被回收之后，没有任何东西会主动把它叫醒去重连。**
 *    `setTimeout` 排的重连随 worker 一起消失 —— 这就是 0828 那次
 *    「配对页说连上了，宿主等了 180 秒一个连接都没有」的真正原因：
 *    连接确实建过，SW 一死就没了，而重连定时器也死在里面。
 *    ⇒ **必须用 `chrome.alarms`**：它是少数几个能把已回收的 worker 重新拉起来的事件源。
 *    最小周期 30 秒（Chrome 120 起；再早是 1 分钟）。
 *
 * ⚠️ 别拿 `setInterval` 替代闹钟，也别拿闹钟替代心跳 —— 它们解决的是**两件事**：
 *    心跳让活着的别死，闹钟让死了的复活。少任何一条，通道都会在几分钟内静默失效。
 */
const HEARTBEAT_MS = 20000;
const ALARM_NAME = 'berrytrace-relay-keepalive';
const ALARM_PERIOD_MINUTES = 0.5;

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

/** 宿主发来的、我们自己命名空间下的 RPC（`berrytrace.*`）。见 {@link BerrytraceRelay._onHostRpc}。 */
type HostRpc = { id: number; method: string; params?: unknown[] };

/**
 * 本次 service worker 实例是什么时候起来的。
 *
 * 🔴 这是**分辨「连接一直在」和「断了又重连」的唯一办法**：两种情况 ping 都会 pong，
 * 但后者中间有一段时间宿主发什么都石沉大海。service worker 每次被回收再唤醒，
 * 整个模块重新执行一遍 ⇒ 这个值会变。
 */
const SW_STARTED_AT = Date.now();

/**
 * 中继的**自诊断日志**，落在 `chrome.storage.local.btRelayDiag` 里。
 *
 * 🔴 **为什么必须落盘、而不是 console.log**〔0828 实测逼出来的〕：
 * 用户日常那个浏览器**没有调试端口**（Chrome 136 起 `--remote-debugging-port`
 * 对默认 profile 直接忽略），扩展的 service worker 控制台**进不去**。
 * 那次的现象是「宿主看到连上了，但扩展一句话都没说过」——
 * 而两边的日志都不足以判断是 worker 死了、还是消息压根没到、还是分派走岔了。
 * 落进 storage 之后，欢迎页 `welcome.html?diag=1` 能把它显示出来，
 * 于是**用桌面自动化读一张网页**就能看到扩展内部状态。这是这台机器上唯一的窗口。
 *
 * 只留最近 40 条，避免把 storage 写胖。
 */
type DiagEntry = { t: number; e: string; d?: string };
let diagBuf: DiagEntry[] = [];
let diagFlush: ReturnType<typeof setTimeout> | null = null;

export function relayDiag(event: string, detail?: string): void {
  diagBuf.push({ t: Date.now(), e: event, d: detail });
  if (diagBuf.length > 40) diagBuf = diagBuf.slice(-40);
  // 攒一下再写：连上的那一瞬间会连着记好几条，一条一次 storage 写太浪费。
  if (diagFlush) return;
  diagFlush = setTimeout(() => {
    diagFlush = null;
    try {
      void chrome.storage.local.set({
        btRelayDiag: { swStartedAt: SW_STARTED_AT, updatedAt: Date.now(), log: diagBuf },
      });
    } catch { /* storage 写不了也不该把中继带塌 */ }
  }, 300);
}

export class BerrytraceRelay {
  private _ws: WebSocket | null = null;
  private _connection: RelayConnection | null = null;
  private _reconnectDelay = RECONNECT_MIN_MS;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _stopped = false;

  /**
   * 连着没有。
   *
   * 🔴 **`CONNECTING` 也要算「有连接」**〔0828 实测踩到〕：
   * 只认 `OPEN` 的话，握手那两三百毫秒里 `connected` 是 false，
   * 闹钟（30s 一次）或者配对回调只要落在这个窗口里就会**再开一条**。
   * 宿主那边「后来的顶掉先来的」，于是**在飞的命令当场被拒成 `DISCONNECTED`** ——
   * 表现是「刚连上就断、一条判据都没跑」，而两边日志都看不出重复连接。
   */
  get connected(): boolean {
    return this._ws?.readyState === WebSocket.OPEN || this._ws?.readyState === WebSocket.CONNECTING;
  }

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
    relayDiag('start');
    await this._connectLoop();
  }

  stop(): void {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopHeartbeat();
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
      relayDiag('standby', `enabled=${settings.enabled} hasToken=${!!settings.token}`);
      return;
    }
    relayDiag('connect-attempt', `port=${settings.port}`);
    this._open(settings);
  }

  private _open(settings: RelaySettings): void {
    // 🔴 **重入闸**。这一层有三个地方会叫 `start()`：SW 每次唤醒、配对完成、保活闹钟。
    // 没有这道闸，它们会各开一条连接 —— 见 `connected` 上面那段。
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
      debugLog('已经有连接了，不重复开');
      relayDiag('open-skipped', `readyState=${this._ws.readyState}`);
      return;
    }
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
      relayDiag('open');
      // 连上就把退避重置掉，否则一次长断线会让后面每次重连都慢 30s。
      this._reconnectDelay = RECONNECT_MIN_MS;
      this._startHeartbeat(ws);
    };

    ws.onclose = (ev: CloseEvent) => {
      relayDiag('close', `code=${ev?.code} reason=${ev?.reason ?? ''}`);
      this._stopHeartbeat();
      this._connection = null;
      this._ws = null;
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      relayDiag('error');
      // onerror 之后一定还会来一次 onclose，重连只挂在 onclose 上，别重复排队。
    };

    ws.onmessage = (event: MessageEvent) => {
      // RelayConnection 一旦接管，就由它自己处理 onmessage；这里只处理接管**之前**
      // 的控制消息。判据：接管后 this._connection 非空。
      if (this._connection) return;
      let msg: ControlMessage | HostRpc;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      // 宿主的 RPC 走 `{id, method, params}`（跟 RelayConnection 同一种形状，
      // 好让宿主那边共用同一套 _pending 对号）。我们只认自己命名空间下的方法，
      // **别在这里放行 `chrome.*`** —— 那是 RelayConnection 的白名单说了算的。
      relayDiag('recv', JSON.stringify(msg).slice(0, 120));
      if ('method' in msg && typeof msg.method === 'string' && msg.method.startsWith('berrytrace.')) {
        void this._onHostRpc(msg as HostRpc, ws);
        return;
      }
      void this._onControlMessage(msg as ControlMessage, ws);
    };
  }

  /**
   * 宿主发来的、**我们自己命名空间**的 RPC。今天只有一条：三档路自测。
   *
   * 应答用 `{id, result}` / `{id, error}` —— 与 RelayConnection 的形状一致，
   * 这样宿主侧不用为它单开一条等待通道（宿主 `_onMessage` 按「有没有 method」分派，
   * 没有 method 的就去 `_pending` 里对号）。
   */
  private async _onHostRpc(msg: HostRpc, ws: WebSocket): Promise<void> {
    try {
      if (msg.method === 'berrytrace.ping') {
        // 通讯层的活体判据。宿主用它量「静默 N 秒之后这条 WebSocket 还在不在」——
        // MV3 的 service worker 空闲 30 秒就被回收，回收了这条连接就没了。
        // 回 `swStartedAt` 是为了分辨**两种成功**：连接一直没断，还是断了又重连
        // （重连也能 pong，但 swStartedAt 会变 ⇒ 中间那段时间指令是发不出去的）。
        ws.send(JSON.stringify({ id: msg.id, result: { pong: true, swStartedAt: SW_STARTED_AT, now: Date.now() } }));
        return;
      }
      if (msg.method === 'berrytrace.env') {
        // 🔴 **故障隔离用的最小 RPC**：只读几个不会失败的东西，一个标签都不开。
        // 0828 在李博的 Mac 上，自测一发出去连接就没了、一条判据都没推上来 ——
        // 分不清是「RPC 通路本身不通」还是「自测里某一步把 worker 干掉了」。
        // 有了这条：它通 ⇒ 通路没问题，问题在自测里；它也不通 ⇒ 问题在通路上。
        const manifest = chrome.runtime.getManifest();
        ws.send(JSON.stringify({
          id: msg.id,
          result: {
            hasDebuggerPermission: await chrome.permissions.contains({ permissions: ['debugger'] }),
            permissions: manifest.permissions ?? [],
            optionalPermissions: (manifest as { optional_permissions?: string[] }).optional_permissions ?? [],
            version: manifest.version,
            hasOffscreen: typeof chrome.offscreen !== 'undefined',
            hasAlarms: typeof chrome.alarms !== 'undefined',
            ua: navigator.userAgent,
            swStartedAt: SW_STARTED_AT,
          },
        }));
        return;
      }
      if (msg.method === 'berrytrace.listTabs') {
        // 给 L1（桌面自动化）当**回读判据**：真键盘真鼠标开出来的标签，
        // 只有在这份清单里出现了才算数。桌面那边 helper 说 ok 不算数
        // —— 那是 0828 那一轮七条缺陷的同一个形状。
        const tabs = await chrome.tabs.query({});
        ws.send(JSON.stringify({
          id: msg.id,
          result: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })),
        }));
        return;
      }
      if (msg.method === 'berrytrace.selftest') {
        const report = await runSelfTest(
          (msg.params?.[0] ?? {}) as { fixtureBase: string },
          // 逐条上报：连接万一中途断了，宿主至少知道断在哪一条上。
          (c) => { try { ws.send(JSON.stringify({ method: 'berrytrace.case', params: [c] })); } catch { /* 断了就断了 */ } },
        );
        ws.send(JSON.stringify({ id: msg.id, result: report }));
        return;
      }
      ws.send(JSON.stringify({ id: msg.id, error: `未知方法 ${msg.method}` }));
    } catch (e: any) {
      ws.send(JSON.stringify({ id: msg.id, error: String(e?.message ?? e) }));
    }
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
      // 🔴 **这里只能 `contains`，不能 `request`**（0828 实测订正）。
      // `chrome.permissions.request()` 要求**用户手势**，而这段代码跑在
      // service worker 里响应一条 WebSocket 消息 —— 那里没有手势，调了必然抛。
      // 授权动作被挪到扩展自己的欢迎页上（`welcome.html` 的「开启自动化」按钮），
      // 那里的点击是真手势。这一层只负责「没授权就明确说没授权」，不假装能补救。
      const granted = await chrome.permissions.contains({ permissions: ['debugger'] });
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

  /**
   * 心跳。**它不是为了探活，是为了不被回收** —— 探活是宿主的事。
   * Chrome 116 起 WebSocket 的收发都会重置 service worker 的 30 秒空闲计时器，
   * 所以只要我们每 20 秒说一句话，连着的时候这个 worker 就不会死。
   */
  private _startHeartbeat(ws: WebSocket): void {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'heartbeat', swStartedAt: SW_STARTED_AT }));
        relayDiag('heartbeat');
      } catch {
        // 发不出去说明已经断了，onclose 会接手重连，这里不必也不该重复处理
      }
    }, HEARTBEAT_MS);
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
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
let alarmListenerInstalled = false;

/** background 里调一次即可。重复调用是安全的（service worker 会重启，这很常见）。 */
export function initBerrytraceRelay(): BerrytraceRelay {
  if (!singleton) singleton = new BerrytraceRelay();
  void singleton.start();
  installKeepaliveAlarm();
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

/**
 * 🔴 **把已经被回收的 service worker 重新拉起来的那条路。**
 *
 * 0828 实测踩到的形状：配对页显示「已连上」，宿主却等了 180 秒一个连接都没有。
 * 原因不是没连上 —— 是连上之后 SW 空闲 30 秒被回收，连接跟着没了，
 * 而排在 `setTimeout` 里的重连**也死在同一个 worker 里**。
 * 从那一刻起，除非用户手动动一下浏览器，这条通道永远不会自己回来。
 *
 * `chrome.alarms` 是少数几个能唤醒已回收 worker 的事件源。周期 30 秒（最小值）。
 * ⚠️ 监听器必须**在顶层同步注册**：MV3 的 worker 被唤醒时会重新执行整个模块，
 * 事件在那一轮就派发 —— 注册进任何 `await` 后面都可能错过它，而且零报错。
 */
function installKeepaliveAlarm(): void {
  if (!chrome.alarms) return;   // Safari 之类没有这套 API，静默跳过
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  if (!alarmListenerInstalled) {
    alarmListenerInstalled = true;
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== ALARM_NAME) return;
      // 已经连着就什么都不做 —— 闹钟只负责「死了的复活」，不负责「活着的保活」。
      if (singleton?.connected) return;
      void singleton?.start();
    });
  }
}

/** 配对完成（拿到 token）之后调它，立刻连上，不用等退避计时。 */
export function restartBerrytraceRelay(): void {
  singleton?.stop();
  singleton = null;
  initBerrytraceRelay();
}
