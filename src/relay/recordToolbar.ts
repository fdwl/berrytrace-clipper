/**
 * 录制 · 页面里那条工具条（宿主规划的第 7 屏）＋ 元素拾取（第 5 屏）＋ 标注卡（第 6 屏）
 *
 * 李博 0907：「我正在录制过程中，当我访问的网站，里面我如何进行录制？」
 * 答案就是这个文件：录制一开始，他打开的**每一个页面**上自己浮起这条。
 *
 * ── 🔴 它跑在别人的网站里，所以有三条不能破的规矩 ─────────────────────────
 * 1. **shadow DOM 隔离**，而且根节点 `all: initial` —— 站点的 CSS 会污染一切，
 *    从字号到 box-sizing 到 button 的默认外观。不隔离的结果不是"有点丑"，
 *    是**在某些站点上整条看不见**，而那正好等于"在录但没提示"。
 * 2. **不依赖宿主的 CSS 变量**。这里一个 var 都不用，颜色全是字面值。
 * 3. **z-index 顶格**，并且 `position: fixed`。站点里 999999 的浮层遍地都是。
 *
 * ── 判定不在这里 ──────────────────────────────────────────────────────────
 * 该不该显示、该不该采集，是宿主算好之后**下发的两个布尔**（show / capture）。
 * 这里只负责把它画出来。理由见宿主仓 `browser-protocol.ts` 的文件头。
 */

import type { ElementSnapshot } from './recordSnapshot';
import { snapshotElement } from './recordSnapshot';

/** 与宿主 `browser-protocol.ts` 的 BrowserRecordingState 逐字段对应 */
export interface RecordingStateView {
  show: boolean;
  capture: boolean;
  phase: string;
  sessionId: string | null;
  steps: number;
  screenshotOnly: number;
  annotations: number;
  elapsedMs: number;
  suspendReason?: 'annotating' | 'paused' | 'own-window';
}

export interface ToolbarHandlers {
  onMark(): void;
  onStop(): void;
  onAnnotate(target: ElementSnapshot, intent: string, note: string): void;
}

/**
 * 四个意图，**措辞与宿主那张卡一致**（规划 7.3 第 6 屏：两张卡必须长得一模一样）。
 * 那边的原本在 `src/views/recording/annotate-tools.ts` 的 ANNOTATION_INTENTS。
 * 这是**文案**的副本，不是判据的副本 —— 判据一律留在宿主。
 */
const INTENTS: Array<{ intent: string; label: string; hint: string }> = [
  { intent: 'extract', label: '我要这块数据', hint: '这块内容就是我要的产物（列表、表格、某个值）' },
  { intent: 'reference', label: '参考', hint: '这一步为什么这么做' },
  { intent: 'validation', label: '校验', hint: '跑完要满足这个条件' },
  { intent: 'other', label: '其他', hint: '就是想标一下' },
];

const SVG = {
  crosshair: '<circle cx="12" cy="12" r="9"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  star: '<path d="M12 3l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.3 6.8 19l1-5.75-4.2-4.1 5.8-.85z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>',
};

function icon(path: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.bar {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  z-index: 2147483647;
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border-radius: 999px;
  background: rgb(28 28 30 / 0.94);
  border: 1px solid rgb(255 255 255 / 0.14);
  box-shadow: 0 8px 28px rgb(0 0 0 / 0.45);
  color: rgb(255 255 255 / 0.92);
  font-size: 12px; line-height: 1;
  user-select: none; -webkit-user-select: none;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #ff3b30; flex: none; }
.dot.paused { background: rgb(255 255 255 / 0.45); }
.clock { font-variant-numeric: tabular-nums; font-weight: 600; letter-spacing: .3px; }
.steps { font-variant-numeric: tabular-nums; font-weight: 600; color: rgb(255 255 255 / 0.72); }
.steps.degraded { color: #ffcc00; }
.why { color: #ffcc00; font-weight: 600; }
.sep { width: 1px; height: 14px; background: rgb(255 255 255 / 0.16); }
button.tool {
  appearance: none; -webkit-appearance: none; margin: 0;
  width: 26px; height: 26px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 8px; border: 1px solid transparent;
  background: transparent; color: rgb(255 255 255 / 0.9); cursor: pointer;
}
button.tool:hover { background: rgb(255 255 255 / 0.14); }
button.tool.on { background: rgb(10 132 255 / 0.9); color: #fff; }
button.tool.stop { color: #ff453a; }
button.tool svg { width: 15px; height: 15px; }
.badge {
  position: absolute; top: -3px; right: -3px; min-width: 13px; height: 13px;
  padding: 0 3px; border-radius: 999px; background: #ff3b30; color: #fff;
  font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center;
}
.badged { position: relative; display: inline-flex; }

/* 拾取态：跟着鼠标走的那一圈高亮。它自己不吃鼠标事件，否则就再也拾不到下一个了 */
.hl {
  position: fixed; pointer-events: none; z-index: 2147483646;
  border: 2px solid #0a84ff; border-radius: 3px;
  background: rgb(10 132 255 / 0.12);
  box-shadow: 0 0 0 9999px rgb(0 0 0 / 0.06);
}
.tip {
  position: fixed; top: 48px; left: 50%; transform: translateX(-50%);
  z-index: 2147483647; padding: 5px 10px; border-radius: 8px;
  background: rgb(10 132 255 / 0.95); color: #fff; font-size: 12px; font-weight: 600;
}

/* 标注卡：与宿主编辑器里那张同形（244 宽、圆角 12、第一项占满一行） */
.card {
  position: fixed; top: 48px; left: 50%; transform: translateX(-50%);
  z-index: 2147483647; width: 244px;
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px; border-radius: 12px;
  background: rgb(28 28 30 / 0.97);
  border: 1px solid rgb(255 255 255 / 0.16);
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.5);
  color: rgb(255 255 255 / 0.92); font-size: 12px;
}
.card .title { font-weight: 600; padding: 0 2px; }
.card .what {
  padding: 0 2px; color: rgb(255 255 255 / 0.6);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.card input {
  width: 100%; padding: 5px 8px; border-radius: 8px;
  border: 1px solid rgb(255 255 255 / 0.18);
  background: rgb(255 255 255 / 0.06); color: rgb(255 255 255 / 0.95);
  font-size: 12px; outline: none; user-select: text; -webkit-user-select: text;
}
.card input::placeholder { color: rgb(255 255 255 / 0.4); }
.card input:focus { border-color: rgb(10 132 255 / 0.9); }
.card .picks { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.card .picks button {
  appearance: none; -webkit-appearance: none; margin: 0;
  padding: 6px 8px; border-radius: 8px;
  border: 1px solid rgb(255 255 255 / 0.16);
  background: rgb(255 255 255 / 0.06); color: rgb(255 255 255 / 0.92);
  font-size: 12px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.card .picks button:hover { background: rgb(255 255 255 / 0.14); }
.card .picks button:first-child {
  grid-column: 1 / -1; font-weight: 600;
  background: rgb(10 132 255 / 0.85); border-color: rgb(10 132 255 / 0.9);
}
.hidden { display: none !important; }
`;

/**
 * 一条工具条的生命周期。**同一个页面只会有一份** —— 调用方保证。
 */
export class RecordToolbar {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private picking = false;
  private picked: ElementSnapshot | null = null;
  /** 拾取态下鼠标最后停在哪个元素上。点中的就是它 */
  private hover: Element | null = null;
  private tickTimer: number | null = null;
  private state: RecordingStateView | null = null;

  constructor(private readonly h: ToolbarHandlers) {}

  /** 这条工具条的宿主元素。采集那边靠它认出"这一下点的是我们自己" */
  public get element(): HTMLElement | null {
    return this.host;
  }

  public get isPicking(): boolean {
    return this.picking;
  }

  public mount(): void {
    if (this.host) return;
    const host = document.createElement('div');
    // 🔴 别给它任何站点可能命中的类名/ id：站点的全局选择器会打到它身上
    host.setAttribute('data-berrytrace-recording', '1');
    /*
     * closed：站点脚本拿不到 shadowRoot，改不了也读不了我们这条。
     * 这不是防攻击（同一个页面里防不住），是**防误伤** ——
     * 有的站点会遍历 DOM 做全局改写，open 的 shadow root 会被卷进去。
     */
    this.root = host.attachShadow({ mode: 'closed' });
    this.root.innerHTML = `<style>${STYLE}</style>
      <div class="bar" part="bar">
        <span class="dot"></span>
        <span class="clock">00:00</span>
        <span class="steps hidden"></span>
        <span class="why hidden"></span>
        <span class="sep"></span>
        <button class="tool" data-act="pick" title="标注：点一下页面上的东西，告诉我这块是什么">${icon(SVG.crosshair)}</button>
        <span class="badged"><button class="tool" data-act="mark" title="标记重点：只在时间轴上打个点">${icon(SVG.star)}</button></span>
        <button class="tool stop" data-act="stop" title="结束这次录制">${icon(SVG.stop)}</button>
      </div>
      <div class="hl hidden"></div>
      <div class="tip hidden">点一下你要标的东西（Esc 取消）</div>
      <div class="card hidden">
        <div class="title">这块是什么？</div>
        <div class="what"></div>
        <input placeholder="一句话说明（可不填）" maxlength="120" />
        <div class="picks"></div>
      </div>`;

    const picks = this.root.querySelector('.picks') as HTMLElement;
    for (const it of INTENTS) {
      const b = document.createElement('button');
      b.textContent = it.label;
      b.title = it.hint;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.commitAnnotation(it.intent);
      });
      picks.appendChild(b);
    }

    this.root.querySelector('.bar')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement | null)?.closest?.('button.tool') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'pick') this.togglePick();
      else if (act === 'mark') this.h.onMark();
      else if (act === 'stop') this.h.onStop();
    });

    document.documentElement.appendChild(host);
    this.host = host;
    // 秒表在本地走：宿主只在相位变化时推状态，不会每秒推一次
    this.tickTimer = window.setInterval(() => this.paint(), 1000);
    if (this.state) this.paint();
  }

  public unmount(): void {
    this.stopPick();
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.host?.remove();
    this.host = null;
    this.root = null;
  }

  /** 收到新状态。**只画，不判**（show/capture 是宿主算好的） */
  public update(s: RecordingStateView): void {
    // 本地秒表从这一刻起自己走
    this.state = { ...s };
    this.baseAt = Date.now();
    if (!s.capture && this.picking) this.stopPick();
    this.paint();
  }

  private baseAt = Date.now();

  private paint(): void {
    const root = this.root;
    const s = this.state;
    if (!root || !s) return;
    const el = <T extends Element>(q: string) => root.querySelector(q) as T | null;

    const running = s.capture;
    el<HTMLElement>('.dot')?.classList.toggle('paused', !running);
    // 挂起的那一段秒表不往前走 —— 走了的话用户会以为那段也录进去了
    const elapsed = running ? s.elapsedMs + (Date.now() - this.baseAt) : s.elapsedMs;
    const clock = el<HTMLElement>('.clock');
    if (clock) clock.textContent = mmss(elapsed);

    const steps = el<HTMLElement>('.steps');
    if (steps) {
      steps.classList.toggle('hidden', s.steps <= 0);
      steps.classList.toggle('degraded', s.screenshotOnly > 0);
      steps.textContent = s.steps > 999 ? '999+' : String(s.steps);
      steps.title = s.screenshotOnly > 0
        ? `采到 ${s.steps} 步，其中 ${s.screenshotOnly} 步没认出元素，只留了截图`
        : `采到 ${s.steps} 步，每一步都认出了元素`;
    }

    /*
     * 🔴 不采集的时候必须**说出为什么**。页面上没有别的上下文：
     * 用户看到一条不走的秒表，只会以为录制坏了。
     * （这不是"把状态写成文案"——它解释的是一个**异常态**，
     *   正常录制时这一格是不存在的。）
     */
    const why = el<HTMLElement>('.why');
    if (why) {
      const text = s.suspendReason === 'annotating' ? '标注中·不记录'
        : s.suspendReason === 'paused' ? '已暂停·不记录' : '';
      why.textContent = text;
      why.classList.toggle('hidden', !text);
    }

    const badgeHost = el<HTMLElement>('.badged');
    if (badgeHost) {
      badgeHost.querySelector('.badge')?.remove();
      if (s.annotations > 0) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = s.annotations > 99 ? '99+' : String(s.annotations);
        badgeHost.appendChild(b);
      }
    }
  }

  // ── 拾取（第 5 屏）────────────────────────────────────────────────────────

  private togglePick(): void {
    if (this.picking) this.stopPick();
    else this.startPick();
  }

  /**
   * 进拾取态。
   *
   * 🔴 三个监听全挂在 **capture 阶段并且 preventDefault** ——
   * 拾取时点中的那一下**绝不能落到页面上**：他想标的往往是一个链接或按钮，
   * 落下去页面就跳走了，而他要标的东西连同这次录制的上下文一起没了。
   */
  private startPick(): void {
    if (this.picking) return;
    this.picking = true;
    this.root?.querySelector('.tip')?.classList.remove('hidden');
    this.root?.querySelector('button[data-act="pick"]')?.classList.add('on');
    document.addEventListener('mousemove', this.onMove, true);
    document.addEventListener('click', this.onPickClick, true);
    document.addEventListener('keydown', this.onPickKey, true);
  }

  private stopPick(): void {
    this.picking = false;
    this.hover = null;
    this.root?.querySelector('.tip')?.classList.add('hidden');
    this.root?.querySelector('.hl')?.classList.add('hidden');
    this.root?.querySelector('button[data-act="pick"]')?.classList.remove('on');
    document.removeEventListener('mousemove', this.onMove, true);
    document.removeEventListener('click', this.onPickClick, true);
    document.removeEventListener('keydown', this.onPickKey, true);
  }

  private readonly onMove = (e: MouseEvent): void => {
    const el = e.target as Element | null;
    if (!el || el === this.host) return;
    this.hover = el;
    const box = el.getBoundingClientRect();
    const hl = this.root?.querySelector('.hl') as HTMLElement | null;
    if (!hl) return;
    hl.classList.remove('hidden');
    hl.style.left = `${box.left}px`;
    hl.style.top = `${box.top}px`;
    hl.style.width = `${box.width}px`;
    hl.style.height = `${box.height}px`;
  };

  private readonly onPickClick = (e: MouseEvent): void => {
    if ((e.target as Element | null) === this.host) return;
    e.preventDefault();
    e.stopPropagation();
    const el = (e.target as Element | null) ?? this.hover;
    if (!el) return;
    this.picked = snapshotElement(el);
    this.stopPick();
    this.openCard(el);
  };

  private readonly onPickKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    this.stopPick();
  };

  // ── 标注卡（第 6 屏）──────────────────────────────────────────────────────

  private openCard(el: Element): void {
    const card = this.root?.querySelector('.card') as HTMLElement | null;
    if (!card) return;
    const what = card.querySelector('.what') as HTMLElement;
    const label = this.picked?.ariaLabel ?? this.picked?.text ?? this.picked?.tag ?? '';
    what.textContent = label ? `${el.tagName.toLowerCase()} · ${label}` : el.tagName.toLowerCase();
    const input = card.querySelector('input') as HTMLInputElement;
    input.value = '';
    card.classList.remove('hidden');
    // 下一帧再聚焦：这一帧里那次 click 的收尾还会把焦点交给点击目标，
    // 当场 focus 会被它顶掉（宿主那侧的文字输入框踩过同一个坑）
    window.requestAnimationFrame(() => input.focus());
  }

  private commitAnnotation(intent: string): void {
    const card = this.root?.querySelector('.card') as HTMLElement | null;
    const input = card?.querySelector('input') as HTMLInputElement | null;
    const target = this.picked;
    this.picked = null;
    card?.classList.add('hidden');
    if (target) this.h.onAnnotate(target, intent, (input?.value ?? '').trim());
  }
}
