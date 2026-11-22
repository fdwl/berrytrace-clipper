/**
 * 点工具栏图标弹出的菜单页（menu.html）。三项：标记页面元素、Agent 对话框、提取网页内容。
 * 「提取网页内容」就是原来的剪藏弹窗（popup.html），在同一个弹窗里切过去，不动剪藏本身。
 * 只在 Chrome 构建里作为默认弹窗（manifest.chrome.json）；Firefox / Safari 仍直接是剪藏弹窗。
 */
import { statusView, STATUS_POLL_MS } from './menuStatus';

const note = document.getElementById('note');
const show = (text: string): void => {
  if (!note) return;
  note.textContent = text;
  note.style.display = 'block';
};

// 版本号与客户端连接状态（连接状态问后台，后台 ping 客户端）
const ver = document.getElementById('ver');
if (ver) ver.textContent = `v${chrome.runtime.getManifest().version}`;
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const statusHint = document.getElementById('status-hint');
function renderStatus(connected: boolean | undefined): void {
  const v = statusView(connected);
  statusEl?.classList.toggle('on', v.on);
  if (statusText) statusText.textContent = v.text;
  if (statusHint) statusHint.textContent = v.hint;
}
renderStatus(undefined);
// 菜单开着期间每秒问一次：后台刚被唤醒时连接常常还在握手，第一次答「没连上」不代表真没连上。
function pollStatus(): void {
  chrome.runtime.sendMessage({ type: 'berrytrace-client-status' }, (r: { connected?: boolean } | undefined) => {
    void chrome.runtime.lastError;
    renderStatus(!!r?.connected);
  });
}
pollStatus();
setInterval(pollStatus, STATUS_POLL_MS);

document.getElementById('m-annotate')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'berrytrace-annotate-toggle-active' }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
});

// 「Agent 对话框」= 浏览器右侧栏里的 mini Agent。侧栏页自己去连客户端（没开就静默唤醒），这里只负责打开侧栏。
// sidePanel.open 必须在用户点击的当下调用，所以放在这里而不是后台。
document.getElementById('m-agent')?.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id == null) { show('找不到当前标签页'); return; }
    // 不带 tabId：对所有标签页生效。只对当前标签设的话，换到别的页面侧栏就会回到默认的剪藏面板
    // （side-panel.html），在新页面上提示「This page cannot be clipped.」。
    await chrome.sidePanel.setOptions({ path: 'agent-panel.html', enabled: true });
    await chrome.sidePanel.open({ tabId: tab.id });
    window.close();
  } catch (e) {
    show(`打开侧栏失败：${String((e as Error)?.message ?? e)}`);
  }
});

document.getElementById('m-clip')?.addEventListener('click', () => {
  window.location.href = 'popup.html';
});

export {};
