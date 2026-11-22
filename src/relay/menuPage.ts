/**
 * 点工具栏图标弹出的菜单页（menu.html）。三项：标记页面元素、Agent 对话框、提取网页内容。
 * 「提取网页内容」就是原来的剪藏弹窗（popup.html），在同一个弹窗里切过去，不动剪藏本身。
 * 只在 Chrome 构建里作为默认弹窗（manifest.chrome.json）；Firefox / Safari 仍直接是剪藏弹窗。
 */
const note = document.getElementById('note');
const show = (text: string): void => {
  if (!note) return;
  note.textContent = text;
  note.style.display = 'block';
};

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
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'agent-panel.html', enabled: true });
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
