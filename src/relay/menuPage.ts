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

document.getElementById('m-agent')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'berrytrace-open-mini-agent' }, (r: { ok: boolean; error?: string } | undefined) => {
    if (chrome.runtime.lastError || !r) { show('插件后台没有应答，请在 chrome://extensions 里重新加载本插件'); return; }
    if (r.ok) { window.close(); return; }
    show(r.error === 'NOT_CONNECTED' ? '没连上客户端：请先启动莓莓印记客户端' : `打开失败：${r.error ?? '未知原因'}`);
  });
});

document.getElementById('m-clip')?.addEventListener('click', () => {
  window.location.href = 'popup.html';
});
