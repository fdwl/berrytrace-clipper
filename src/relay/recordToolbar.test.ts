// @vitest-environment jsdom
/**
 * 守卫：页面里的工具条 —— hover 外框跟着采集常开；拾取（标注）不拦页面自己的事件；
 * 点图标节点时快照带祖先链（名字在祖先身上）。
 * 1020 录制调查档 R2-B / R4。
 *
 * 失效条件：工具条改成由宿主下发 hoverPick 布尔、或快照不再带祖先链之后按新形状重写。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordToolbar, type RecordingStateView } from './recordToolbar';
import { snapshotElement, type ElementSnapshot } from './recordSnapshot';

const 录制中: RecordingStateView = {
  show: true, capture: true, phase: 'recording', sessionId: 's1',
  steps: 0, screenshotOnly: 0, annotations: 0, elapsedMs: 0,
};
const 暂停: RecordingStateView = { ...录制中, capture: false, suspendReason: 'paused' };

let shadow: ShadowRoot | null = null;
const realAttach = Element.prototype.attachShadow;

beforeEach(() => {
  // closed 的 shadow root 外面读不到：测试里让它开着，只为能查到 .hl
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    shadow = realAttach.call(this, { ...init, mode: 'open' });
    return shadow;
  };
  document.body.innerHTML = '<a id="link" href="#x"><svg id="icon"></svg>签到</a><div id="plain">内容</div>';
});
afterEach(() => {
  Element.prototype.attachShadow = realAttach;
  document.body.innerHTML = '';
  shadow = null;
});

function 造(onAnnotate: (t: ElementSnapshot) => void = () => {}) {
  const tb = new RecordToolbar({ onMark() {}, onStop() {}, onAnnotate });
  tb.mount();
  return tb;
}
const hl = () => shadow!.querySelector('.hl') as HTMLElement;

describe('hover 外框', () => {
  it('采集中鼠标移到元素上就出现外框；暂停后撤掉', () => {
    const tb = 造();
    tb.update(录制中);
    // 对照组：移动之前外框是藏着的，否则下面的「出现」分辨不出是 hover 触发的
    expect(hl().classList.contains('hidden')).toBe(true);
    document.getElementById('plain')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(hl().classList.contains('hidden')).toBe(false);
    tb.update(暂停);
    expect(hl().classList.contains('hidden')).toBe(true);
    // 暂停后再移动不应再出现
    document.getElementById('plain')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(hl().classList.contains('hidden')).toBe(true);
    tb.unmount();
  });
});

describe('拾取不拦页面事件', () => {
  it('🔴 拾取态点一个链接：click 没被 preventDefault、没被 stopPropagation，并且仍上报标注', () => {
    const annotated: string[] = [];
    const tb = 造((t) => annotated.push(t.tag));
    tb.update(录制中);
    (tb as unknown as { startPick(): void }).startPick();
    let reachedPage = false;
    document.getElementById('link')!.addEventListener('click', () => { reachedPage = true; });
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('link')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(reachedPage).toBe(true);
    expect(annotated).toEqual(['a']);
    tb.unmount();
  });

  it('Esc 退出拾取态，且不 preventDefault', () => {
    const tb = 造();
    tb.update(录制中);
    (tb as unknown as { startPick(): void }).startPick();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(tb.isPicking).toBe(false);
    tb.unmount();
  });
});

describe('快照带祖先链', () => {
  it('点按钮里的图标：祖先里有带文字的 a', () => {
    const snap = snapshotElement(document.getElementById('icon')!);
    expect(snap.tag).toBe('svg');
    expect(snap.ancestors?.[0]).toMatchObject({ tag: 'a', text: '签到' });
  });

  it('祖先全是没名字的容器 ⇒ 不给这一格（缺席，不是空数组）', () => {
    document.body.innerHTML = '<div><div><span id="x"></span></div></div>';
    expect(snapshotElement(document.getElementById('x')!).ancestors).toBeUndefined();
  });
});
