/**
 * 浏览器右侧栏里的 mini Agent（agent-panel.html）。
 *
 * 流程：问后台要对话页地址 → 后台经中继问客户端（客户端按需拉起「只出对话页」的网页服务，回地址）→ iframe 打开。
 * 客户端没在跑：这里显示「启动莓莓印记」链接（真 <a href="berrytrace://wake?silent=true">，用户点才算手势，
 * 确认框才会出现在眼前，勾「始终允许」后以后一点就起；原因与实测见 agentPanelState.ts），同时
 * 每 1.5 秒再问一次，连上就自动进对话页。
 * 🔴 不设期限：只有后台明确回「客户端缺网页形态产物」这类终局错误才停下来报错
 * （李博 2026-10-22「等待就是等待」）。
 *
 * 标记：后台拿到客户端拼好的交接后，经这条长连接送来，这里 postMessage 进 iframe（对面只认扩展页来源）。
 */
import { isFromPanelFrame } from './panelFrameGuard';
import { panelWaitView, WAKE_URL, type PanelWaitView } from './agentPanelState';

const msg = document.getElementById('msg') as HTMLElement;
const state = document.getElementById('state') as HTMLElement;
const frame = document.getElementById('frame') as HTMLIFrameElement;

let origin = '';
let frameReady = false;
const pending: unknown[] = [];

function show(text: string, retry = false): void {
  state.style.display = 'flex';
  frame.style.display = 'none';
  msg.textContent = text;
  state.querySelector('button')?.remove();
  if (retry) {
    const b = document.createElement('button');
    b.textContent = '重试';
    b.addEventListener('click', () => { void boot(); });
    state.appendChild(b);
  }
}

/**
 * 等客户端起来：隔 1.5 秒重画一次，所以「启动」链接只建一次、之后只改文字，
 * 不能每轮都删了重建（用户点到一半链接被换掉，点击就丢了）。
 */
function showWaiting(view: PanelWaitView): void {
  state.style.display = 'flex';
  frame.style.display = 'none';
  msg.textContent = view.text;
  state.querySelector('button')?.remove();
  let link = document.getElementById('bt-launch') as HTMLAnchorElement | null;
  if (view.showLaunch && !link) {
    link = document.createElement('a');
    link.id = 'bt-launch';
    link.href = WAKE_URL; // 必须是真链接、由用户点击：脚本导航会被浏览器当成无手势拦掉
    link.textContent = '启动莓莓印记';
    state.appendChild(link);
  }
  if (!view.showLaunch) link?.remove();
}

function flush(): void {
  if (!frameReady || !frame.contentWindow) return;
  while (pending.length) frame.contentWindow.postMessage({ type: 'berrytrace-handoff', spec: pending.shift() }, origin);
}

type UrlReply = { ok: true; url: string } | { ok: false; error: string; terminal?: boolean };

async function boot(): Promise<void> {
  show('正在连接莓莓印记客户端…');
  for (;;) {
    const r = await new Promise<UrlReply | undefined>((res) => chrome.runtime.sendMessage({ type: 'berrytrace-agent-panel-url' }, (x) => { void chrome.runtime.lastError; res(x); }));
    if (r?.ok) {
      origin = new URL(r.url).origin;
      frame.addEventListener('load', () => { frameReady = true; flush(); void postPageContext(); }, { once: true });
      frame.src = r.url;
      state.style.display = 'none';
      frame.style.display = 'block';
      return;
    }
    if (r && !r.ok && r.terminal) { show(r.error, true); return; }
    showWaiting(panelWaitView(r));
    await new Promise((x) => setTimeout(x, 1500));
  }
}

// ── 侧栏里的对话页 ↔ 扩展 ─────────────────────────────────────────────
/** 把本窗口当前标签页的网址和标题告诉对话页，让它随每条消息告诉 Agent「用户正在看哪一页」。 */
async function postPageContext(): Promise<void> {
  if (!frameReady || !frame.contentWindow) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  // caps：本扩展认得的侧栏能力。老版本不带这个字段，对话页据此把「截取当前页」置灰并说明，而不是点了没反应。
  frame.contentWindow.postMessage({ type: 'berrytrace-page-context', url: tab.url, title: tab.title ?? '', caps: ['capture-page'] }, origin);
}
chrome.tabs.onActivated.addListener(() => { void postPageContext(); });
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && (info.url || info.title || info.status === 'complete')) void postPageContext(); });

/** 对话页里的「标记网页元素」按钮：只认来自我们那个 iframe（来源与窗口都对得上）的消息。 */
window.addEventListener('message', (ev) => {
  if (!isFromPanelFrame(ev, origin, frame.contentWindow)) return;
  if (ev.data?.type === 'berrytrace-annotate-toggle') chrome.runtime.sendMessage({ type: 'berrytrace-annotate-toggle-active' }, () => { void chrome.runtime.lastError; });
  else if (ev.data?.type === 'berrytrace-panel-ready') void postPageContext();
  else if (ev.data?.type === 'berrytrace-capture-page') void captureCurrentPage();
});

let toastTimer: number | undefined;
function toast(text: string): void {
  let el = document.getElementById('bt-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'bt-toast';
    el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;padding:8px 12px;border-radius:8px;background:#333;color:#fff;font:13px system-ui;z-index:10;';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = 'block';
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el!.style.display = 'none'; }, 4000);
}

/** 对话页里的「截取当前页」：拍本窗口当前标签页的可见区域，走标记同一条交接路径，作为文件芯片填进输入框。 */
async function captureCurrentPage(): Promise<void> {
  try {
    const win = await chrome.windows.getCurrent();
    const dataUrl = await chrome.tabs.captureVisibleTab(win.id ?? chrome.windows.WINDOW_ID_CURRENT, { format: 'png' });
    const r = await new Promise<{ ok?: boolean; error?: string } | undefined>((res) => chrome.runtime.sendMessage(
      { type: 'berrytrace-annotate-send', payload: { files: [{ filename: `page-${Date.now()}.png`, base64: dataUrl.split(',')[1], label: '当前页截图' }] } },
      (x) => { void chrome.runtime.lastError; res(x); },
    ));
    if (!r?.ok) toast(`截图没送进输入框：${r?.error ?? '未知错误'}`);
  } catch (e) {
    toast(`截图失败：${String((e as Error)?.message ?? e)}`);
  }
}

// 长连接：让后台知道侧栏开着（标记才往这里送），也用它收标记。
const port = chrome.runtime.connect({ name: 'bt-agent-panel' });
port.onMessage.addListener((m: { type?: string; spec?: unknown }) => {
  if (m?.type === 'handoff') { pending.push(m.spec); flush(); }
});

void boot();

export {};
