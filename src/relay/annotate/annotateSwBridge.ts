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

  chrome.runtime.onMessage.addListener((msg: { type?: string; payload?: unknown }, sender, sendResponse) => {
    if (msg?.type === 'berrytrace-annotate-capture') {
      chrome.tabs.captureVisibleTab(sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: 'png' })
        .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
        .catch((e: Error) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
      return true;
    }
    if (msg?.type === 'berrytrace-annotate-send') {
      const ch2 = channel;
      if (!ch2) { sendResponse({ ok: false, error: 'NOT_CONNECTED' }); return undefined; }
      ch2.sendToHost(CHAT_HANDOFF_METHOD, [msg.payload], NO_DEADLINE)
        .then(() => sendResponse({ ok: true }))
        .catch((e: Error) => {
          const m = String(e?.message ?? e);
          sendResponse({ ok: false, error: m.startsWith('RELAY_NOT_CONNECTED') ? 'NOT_CONNECTED' : m });
        });
      return true;
    }
    return undefined;
  });
}
