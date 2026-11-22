/**
 * 标记模式 · 页面里的那一半（按需注入，不进 manifest 的 content_scripts）
 *
 * 开着时：悬停高亮、点击选中 → 弹一张小卡写备注 / 勾「附截图」→ 送进客户端输入框（只填不发）。可连续标多处，Esc 退出。
 *
 * 跑在别人的网站里，三条规矩同录制工具条（recordToolbar.ts 头部）：shadow DOM 隔离且根 `all: initial`、
 * 不依赖任何 CSS 变量、z-index 顶格 + fixed。
 * 失效条件：李博改口为「自动发送」或「不要标记模式」。
 */
import { snapshotElement } from '../recordSnapshot';
import { buildHandoffPayload, cropBox } from './annotateCore';

const FLAG = '__berrytraceAnnotateInstalled';
const w = window as unknown as Record<string, unknown>;

interface SendResult { ok: boolean; error?: string; dataUrl?: string }
const ask = (msg: unknown) => chrome.runtime.sendMessage(msg) as Promise<SendResult>;

function install(): void {
  let on = false;
  let sent = 0;
  let host: HTMLDivElement | null = null;
  let root: ShadowRoot | null = null;
  let box: HTMLDivElement | null = null;
  let status: HTMLDivElement | null = null;
  let card: HTMLDivElement | null = null;
  let hovered: Element | null = null;

  const inOwn = (t: EventTarget | null) => !!host && t instanceof Node && host.contains(t);

  function setStatus(text: string, bad = false): void {
    if (!status) return;
    status.textContent = text;
    status.style.color = bad ? '#ffb4a8' : '#fff';
  }

  function mount(): void {
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{all:initial}
        .bar{all:initial;position:fixed;top:12px;left:50%;transform:translateX(-50%);pointer-events:auto;
          background:#1f1f24;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:999px;
          box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center}
        .bar button{all:unset;cursor:pointer;color:#c9b6ff;font:13px system-ui,sans-serif}
        .hl{position:fixed;border:2px solid #7c5cff;background:rgba(124,92,255,.12);pointer-events:none;display:none}
        .card{all:initial;position:fixed;pointer-events:auto;width:280px;background:#fff;color:#222;
          font:13px/1.4 system-ui,sans-serif;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.3);padding:10px;
          display:flex;flex-direction:column;gap:8px;box-sizing:border-box}
        .card textarea{all:unset;box-sizing:border-box;width:100%;min-height:54px;border:1px solid #ccc;border-radius:6px;padding:6px;
          white-space:pre-wrap;color:#222;background:#fff;font:13px/1.4 system-ui,sans-serif}
        .card label{display:flex;gap:6px;align-items:center;color:#444}
        .row{display:flex;gap:8px;justify-content:flex-end}
        .card button{all:unset;cursor:pointer;padding:4px 12px;border-radius:6px;background:#eee;color:#222;font:13px system-ui,sans-serif}
        .card button.go{background:#7c5cff;color:#fff}
      </style>
      <div class="hl"></div>
      <div class="bar"><span>标记模式：点网页元素，送进莓莓印记输入框</span><span class="st"></span><button class="x">退出 (Esc)</button></div>`;
    box = root.querySelector('.hl');
    status = root.querySelector('.st');
    root.querySelector('.x')!.addEventListener('click', () => toggle(false));
    document.documentElement.appendChild(host);
  }

  function closeCard(): void { card?.remove(); card = null; }

  function onMove(e: MouseEvent): void {
    if (inOwn(e.target) || card) return;
    const el = e.target as Element | null;
    if (!el || el === hovered || !box) return;
    hovered = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  function onClick(e: MouseEvent): void {
    if (inOwn(e.target)) return;
    // 开着标记模式时，点击只用来选元素，不触发站点自己的跳转 / 按钮
    e.preventDefault();
    e.stopPropagation();
    if (card) { closeCard(); return; }
    openCard(e.target as Element);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (card) closeCard(); else toggle(false);
  }

  function openCard(el: Element): void {
    if (!root) return;
    const r = el.getBoundingClientRect();
    card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<textarea placeholder="备注（可不写）"></textarea><label><input type="checkbox" class="shot" checked>附这个元素的截图</label><div class="row"><button class="no">取消</button><button class="go">送给 Agent</button></div>';
    const left = Math.min(Math.max(8, r.left), window.innerWidth - 296);
    const below = r.bottom + 8 + 150 < window.innerHeight;
    card.style.left = `${left}px`;
    card.style.top = below ? `${r.bottom + 8}px` : `${Math.max(8, r.top - 158)}px`;
    root.appendChild(card);
    const ta = card.querySelector('textarea')!;
    // 键盘事件不让站点的全局快捷键截走
    for (const t of ['keydown', 'keyup', 'keypress']) ta.addEventListener(t, (ev) => { if ((ev as KeyboardEvent).key !== 'Escape') ev.stopPropagation(); });
    ta.focus();
    card.querySelector('.no')!.addEventListener('click', closeCard);
    card.querySelector('.go')!.addEventListener('click', () => {
      const note = ta.value;
      const wantShot = (card!.querySelector('.shot') as HTMLInputElement).checked;
      closeCard();
      void send(el, note, wantShot);
    });
  }

  /** 截图：先把自己的界面藏掉再拍，拍完裁到元素；元素在视口外就用整张 */
  async function shoot(el: Element): Promise<string | undefined> {
    const rect = el.getBoundingClientRect();
    if (host) host.style.visibility = 'hidden';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let res: SendResult;
    try { res = await ask({ type: 'berrytrace-annotate-capture' }); } finally { if (host) host.style.visibility = ''; }
    if (!res?.ok || !res.dataUrl) return undefined;
    const img = new Image();
    img.src = res.dataUrl;
    await img.decode();
    const b = cropBox({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, window.devicePixelRatio || 1, img.naturalWidth, img.naturalHeight);
    if (!b) return res.dataUrl.split(',')[1];
    const c = document.createElement('canvas');
    c.width = b.sw; c.height = b.sh;
    c.getContext('2d')!.drawImage(img, b.sx, b.sy, b.sw, b.sh, 0, 0, b.sw, b.sh);
    return c.toDataURL('image/png').split(',')[1];
  }

  async function send(el: Element, note: string, wantShot: boolean): Promise<void> {
    setStatus('正在送…');
    try {
      const shot = wantShot ? await shoot(el) : undefined;
      // 要了截图却没拍到：不静默丢，状态栏说一声（文字照常送）
      const shotFailed = wantShot && !shot;
      const payload = buildHandoffPayload({
        url: location.href,
        title: document.title,
        snap: snapshotElement(el),
        note,
        html: (el as HTMLElement).outerHTML?.slice(0, 2000),
      }, shot);
      void navigator.clipboard?.writeText(payload.snippet ?? "").catch(() => {}); // 与调试标记一致：同时进剪贴板，失败不影响送达
      const r = await ask({ type: 'berrytrace-annotate-send', payload });
      if (r?.ok) { sent += 1; setStatus(shotFailed ? `已送进输入框（第 ${sent} 条），但截图没拍到` : `已送进输入框（第 ${sent} 条）`, shotFailed); }
      else if (r?.error === 'NOT_CONNECTED') setStatus('客户端没连上：请先打开莓莓印记 App', true);
      else setStatus(`没送成：${r?.error ?? '未知错误'}`, true);
    } catch (e) {
      setStatus(`没送成：${String((e as Error)?.message ?? e)}`, true);
    }
  }

  function toggle(want?: boolean): void {
    const next = want ?? !on;
    if (next === on) return;
    on = next;
    if (on) {
      mount();
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
    } else {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      closeCard();
      host?.remove();
      host = root = box = status = null;
      hovered = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type === 'berrytrace-annotate-toggle') toggle();
    return undefined;
  });
  // 注入本身就是「开」：第一次注入后由 SW 发 toggle，这里不自开
}

if (!w[FLAG]) {
  w[FLAG] = true;
  install();
}
