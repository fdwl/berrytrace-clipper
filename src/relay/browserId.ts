/**
 * 从 UA 判断连上来的是哪个浏览器，握手时报给宿主（宿主按这个名字分「谁连着、谁没连」）。
 *
 * 顺序要紧：Edge、华为浏览器的 UA 里**同时含有** `Chrome/`，必须先判它们，最后才落到 chrome。
 *
 * 🔴 华为浏览器（Windows）的 UA 形如 `... Chrome/99.0.4844.84 Safari/537.36 HBPC/12.1.4.300`。
 * 2026-11-25 Windows 实测：它被报成 `chrome`，宿主于是把它当成 Chrome ——
 * 「Chrome 已连接」其实是华为浏览器，而它的内核是 Chrome 99，跑不动美团页面（只剩「没开 JavaScript」的提示），
 * 真正的 Chrome 里根本没装扩展，自动安装也因为「有一个浏览器已连着」不触发。
 * 宿主侧的名字表（`electron/native/desktop/browsers.ts` 的 `hwbrowser`）早就有这个 id。
 *
 * 只认实测过的 UA 特征。其它国产浏览器（如 360 安全浏览器）没有在手的 UA 样本，不凭猜测加。
 * 失效条件：宿主 `electron/native/desktop/browsers.ts` 里不再有 `hwbrowser` 这个 id 时删掉那一行。
 */
export function browserIdFromUserAgent(ua: string): string {
  if (/\bEdg\//.test(ua)) return 'edge';
  if (/\bOPR\//.test(ua)) return 'opera';
  if (/\bHBPC\//.test(ua)) return 'hwbrowser';
  if (/\bChrome\//.test(ua)) return 'chrome';
  return 'other';
}
