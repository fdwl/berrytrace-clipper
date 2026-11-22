/**
 * 标记模式 · service worker 这一跳
 *
 * 页面脚本 ↔ 这里 ↔ 中继 ↔ 宿主 `berrytrace.chat.handoff`。做三件事：
 *  ① 开关：快捷键 / 右键菜单 → 往当前标签注入 `relay-annotate.js` 并发 toggle；
 *  ② 截图：content script 没有 captureVisibleTab，由这里代拍，回整张图给页面去裁；
 *  ③ 转交：把一次标记原样交给宿主。没连上就当场回 NOT_CONNECTED（页面据此提示），不排队、不重试。
 *
 * 🔴 转交不设超时：宿主要落截图文件，慢就慢，判失败只看连接断开 / 宿主回错
 *    （李博 2026-10-22「等待就是等待」）。下面 NO_DEADLINE 是 setTimeout 能接受的最大值（约 24 天），
 *    因为 sendToHost 的第三个参数必须是数。
 *    失效条件：sendToHost 支持「不设超时」之后，改成那个写法并删 NO_DEADLINE。
 */
import type { HostChannel } from '../recordSwBridge';
import { CHAT_HANDOFF_METHOD } from './annotateCore';

const NO_DEADLINE = 2_147_483_647;
const MENU_ID = 'berrytrace-annotate-toggle';
export const ANNOTATE_COMMAND = 'toggle_annotate';

let channel: HostChannel | null = null;

/** 开着的侧栏页（长连接）。有它，标记就送侧栏；没有，走老路（客户端右栏）。 */
const panelPorts = new Set<chrome.runtime.Port>();
/** 已经发过唤醒、还没连上：避免侧栏每 1.5 秒轮询时反复弹唤醒链接。连上后清掉。 */
let wakeSent = false;

/** 静默唤醒客户端：berrytrace://wake?silent=true（客户端不开窗、不抢焦点）。用完立刻关掉那个空标签。 */
function wakeClientSilently(): void {
  if (wakeSent) return;
  wakeSent = true;
  chrome.tabs.create({ url: 'berrytrace://wake?silent=true', active: false }, (tab) => {
    void chrome.runtime.lastError;
    if (tab?.id == null) return;
    const id = tab.id;
    const close = (tabId: number): void => {
      if (tabId !== id) return;
      chrome.tabs.onUpdated.removeListener(close);
      chrome.tabs.remove(id, () => void chrome.runtime.lastError);
    };
    chrome.tabs.onUpdated.addListener(close);
  });
}

const TERMINAL_PANEL_ERRORS = /^(PANEL_HOST_UNAVAILABLE|PANEL_HOST_EXITED)/;

export function rebindAnnotateChannel(ch: HostChannel): void {
  channel = ch;
}

/** 注入（重复注入安全：页面脚本顶上有安装标记）并切换。 */
async function toggleOnTab(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['relay-annotate.js'] });
  await chrome.tabs.sendMessage(tabId, { type: 'berrytrace-annotate-toggle' });
}

async function toggleActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null || !/^https?:/i.test(tab.url ?? '')) return;
  try { await toggleOnTab(tab.id); } catch { /* 商店页 / chrome:// 等注入被系统拒绝：没有可标记的东西，静默 */ }
}

/** 在 service worker 顶层同步调。 */
export function installAnnotateSwBridge(ch: HostChannel): void {
  channel = ch;

  chrome.commands?.onCommand.addListener((cmd) => {
    if (cmd === ANNOTATE_COMMAND) void toggleActiveTab();
  });

  chrome.contextMenus?.create(
    { id: MENU_ID, title: '莓莓印记：标记模式（开/关）', contexts: ['page'] },
    () => void chrome.runtime.lastError, // 重复 id（worker 重启）会报错，吞掉
  );
  chrome.contextMenus?.onClicked.addListener((info) => {
    if (info.menuItemId === MENU_ID) void toggleActiveTab();
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'bt-agent-panel') return;
    panelPorts.add(port);
    port.onDisconnect.addListener(() => panelPorts.delete(port));
  });

  chrome.runtime.onMessage.addListener((msg: { type?: string; payload?: unknown }, sender, sendResponse) => {
    // 侧栏要对话页地址：客户端按需拉起网页服务后回地址。没连上就静默唤醒客户端，由侧栏自己隔一阵再问。
    if (msg?.type === 'berrytrace-agent-panel-url') {
      const ch4 = channel;
      const notConnected = (): void => { wakeClientSilently(); sendResponse({ ok: false, error: 'NOT_CONNECTED' }); };
      if (!ch4) { notConnected(); return undefined; }
      ch4.sendToHost('berrytrace.chat.agentPanel', [], NO_DEADLINE)
        .then((r) => {
          wakeSent = false;
          const url = (r as { url?: string } | null)?.url;
          sendResponse(url ? { ok: true, url } : { ok: false, error: '客户端没有回对话页地址', terminal: true });
        })
        .catch((e: Error) => {
          const m = String(e?.message ?? e);
          if (m.startsWith('RELAY_NOT_CONNECTED')) { notConnected(); return; }
          sendResponse({ ok: false, error: m.replace(/^PANEL_HOST_[A-Z]+:\s*/, ''), terminal: TERMINAL_PANEL_ERRORS.test(m) });
        });
      return true;
    }
    // 菜单页顶部的连接状态：问客户端一声 ping。没连上中继会立刻拒绝（RELAY_NOT_CONNECTED）；
    // 其它错误（比如老版本客户端不认 ping）说明中继通着，按已连接算。
    if (msg?.type === 'berrytrace-client-status') {
      const ch5 = channel;
      if (!ch5) { sendResponse({ connected: false }); return undefined; }
      ch5.sendToHost('berrytrace.chat.ping', [], NO_DEADLINE)
        .then(() => sendResponse({ connected: true }))
        .catch((e: Error) => sendResponse({ connected: !String(e?.message ?? e).startsWith('RELAY_NOT_CONNECTED') }));
      return true;
    }
    // 菜单里「扩展是不是最新」：问客户端（判据与它的自动升级同一套）。没连上中继 → NOT_CONNECTED；
    // 老版本客户端不认这个前缀 → status 缺省（菜单显示「客户端版本较旧」）。立即更新走 updateNow。
    if (msg?.type === 'berrytrace-extension-update-status' || msg?.type === 'berrytrace-extension-update-now') {
      const ch6 = channel;
      if (!ch6) { sendResponse({ ok: false, error: 'NOT_CONNECTED' }); return undefined; }
      const method = msg.type === 'berrytrace-extension-update-now' ? 'berrytrace.extension.updateNow' : 'berrytrace.extension.updateStatus';
      ch6.sendToHost(method, [], NO_DEADLINE)
        .then((r) => sendResponse({ ok: true, status: (r as { status?: string } | null)?.status }))
        .catch((e: Error) => {
          const m = String(e?.message ?? e);
          sendResponse({ ok: false, error: m.startsWith('RELAY_NOT_CONNECTED') ? 'NOT_CONNECTED' : m });
        });
      return true;
    }
    // 菜单里的「Agent 对话框」：让客户端唤出 mini Agent 小窗（宿主侧 berrytrace.chat.openMiniAgent）
    if (msg?.type === 'berrytrace-open-mini-agent') {
      const ch3 = channel;
      if (!ch3) { sendResponse({ ok: false, error: 'NOT_CONNECTED' }); return undefined; }
      ch3.sendToHost('berrytrace.chat.openMiniAgent', [], NO_DEADLINE)
        .then(() => sendResponse({ ok: true }))
        .catch((e: Error) => {
          const m = String(e?.message ?? e);
          sendResponse({ ok: false, error: m.startsWith('RELAY_NOT_CONNECTED') ? 'NOT_CONNECTED' : m });
        });
      return true;
    }
    // 弹窗里的「标记」图标：开关当前标签页的标记模式（和快捷键、右键菜单同一条路）
    if (msg?.type === 'berrytrace-annotate-toggle-active') {
      void toggleActiveTab().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg?.type === 'berrytrace-annotate-capture') {
      chrome.tabs.captureVisibleTab(sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: 'png' })
        .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
        .catch((e: Error) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
      return true;
    }
    if (msg?.type === 'berrytrace-annotate-send') {
      const ch2 = channel;
      if (!ch2) { sendResponse({ ok: false, error: 'NOT_CONNECTED' }); return undefined; }
      // 侧栏开着：让客户端只把拼好的交接回给我，由我送进侧栏输入框（客户端窗口不动、不抢焦点）。
      const toPanel = panelPorts.size > 0;
      const payload = toPanel ? { ...(msg.payload as object), returnSpec: true } : msg.payload;
      ch2.sendToHost(CHAT_HANDOFF_METHOD, [payload], NO_DEADLINE)
        .then((r) => {
          const spec = (r as { spec?: unknown } | null)?.spec;
          if (toPanel && spec) for (const p of panelPorts) p.postMessage({ type: 'handoff', spec });
          sendResponse({ ok: true });
        })
        .catch((e: Error) => {
          const m = String(e?.message ?? e);
          sendResponse({ ok: false, error: m.startsWith('RELAY_NOT_CONNECTED') ? 'NOT_CONNECTED' : m });
        });
      return true;
    }
    return undefined;
  });
}
