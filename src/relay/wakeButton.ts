/**
 * 弹窗里「唤醒录制工具条」那颗按钮的脚本（popup.html 里单独一个 script，不进上游的 popup.ts）。
 *
 * 点一下：让 service worker 强制连 App、问在不在录、给已开着的页面补工具条，
 * 然后把结果用一句话写在弹窗里。判定在 manualWake.ts，这里只管点和显示。
 * 失效条件见 manualWake.ts 文件头。
 */

import type { WakeReport } from './manualWake';

const button = document.getElementById('bt-wake');
const note = document.getElementById('bt-wake-note');

if (button && note) {
  let busy = false;
  const show = (text: string, bad: boolean): void => {
    note.textContent = text;
    note.style.display = 'block';
    note.style.color = bad ? 'var(--text-error, #c0392b)' : 'var(--text-muted, #666)';
  };
  button.addEventListener('click', (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    show('正在唤醒…', false);
    chrome.runtime.sendMessage({ type: 'berrytrace-recording-wake' }, (r: WakeReport | undefined) => {
      busy = false;
      const err = chrome.runtime.lastError;
      if (err || !r) {
        show('插件后台没有应答，请稍后再点一次；还不行就在 chrome://extensions 里重新加载本插件', true);
        return;
      }
      show(r.message, r.code !== 'ok' && r.code !== 'idle');
      if (r.pairUrl) chrome.tabs.create({ url: r.pairUrl });
    });
  });
}
