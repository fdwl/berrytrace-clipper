/**
 * 浏览器右侧栏里的 mini Agent（agent-panel.html）。
 *
 * 流程：问后台要对话页地址 → 后台经中继问客户端（客户端按需拉起「只出对话页」的网页服务，回地址）→ iframe 打开。
 * 客户端没在跑：后台先用 berrytrace://wake?silent=true 静默唤醒（不开窗、不抢焦点），然后这里
 * 每 1.5 秒再问一次，界面写着「正在启动客户端…」。
 * 🔴 不设期限：只有后台明确回「客户端缺网页形态产物」这类终局错误才停下来报错
 * （李博 2026-10-22「等待就是等待」）。
 *
 * 标记：后台拿到客户端拼好的交接后，经这条长连接送来，这里 postMessage 进 iframe（对面只认扩展页来源）。
 */
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
      frame.addEventListener('load', () => { frameReady = true; flush(); }, { once: true });
      frame.src = r.url;
      state.style.display = 'none';
      frame.style.display = 'block';
      return;
    }
    if (r && !r.ok && r.terminal) { show(r.error, true); return; }
    show('正在启动莓莓印记客户端…');
    await new Promise((x) => setTimeout(x, 1500));
  }
}

// 长连接：让后台知道侧栏开着（标记才往这里送），也用它收标记。
const port = chrome.runtime.connect({ name: 'bt-agent-panel' });
port.onMessage.addListener((m: { type?: string; spec?: unknown }) => {
  if (m?.type === 'handoff') { pending.push(m.spec); flush(); }
});

void boot();

export {};
