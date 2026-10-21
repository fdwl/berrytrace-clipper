// @vitest-environment jsdom
/**
 * 守卫：拾取态下点页面元素，除了标注之外，还要报一条真实的点击（页面没被拦，所以动作是真的）。
 * 宿主读时把两条并成一步（host: src/views/recording/web-annotate-fold.ts）。
 *
 * 失效条件：宿主不再按「点击+标注」合并、拾取回到只报标注之后重写。
 */
/* @负向验证
{ "说明": "拾取态不报点击（回到老行为）—— 用例必红",
  "文件": "src/relay/recordContentScript.ts",
  "找": "    if (isOurs(e)) return;\n    const el = e.target as Element | null;\n    report({\n      kind: 'click',",
  "换成": "    if (toolbar.isPicking || isOurs(e)) return;\n    const el = e.target as Element | null;\n    report({\n      kind: 'click'," }
*/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ type: string; payload: any }> = [];
const state = { show: true, capture: true, phase: 'recording', sessionId: 's1', steps: 0, screenshotOnly: 0, annotations: 0, elapsedMs: 0 };
const realAttach = Element.prototype.attachShadow;
let shadow: ShadowRoot | null = null;

beforeEach(() => {
  sent.length = 0;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    shadow = realAttach.call(this, { ...init, mode: 'open' });
    return shadow;
  };
  document.body.innerHTML = '<a id="link" href="#x">去签到</a>';
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'x',
      lastError: undefined,
      onMessage: { addListener: () => {} },
      sendMessage: (m: { type: string; payload: unknown }, cb: (r: unknown) => void) => {
        sent.push({ type: m.type, payload: m.payload });
        cb(m.type === 'berrytrace-recording-hello' ? state : undefined);
      },
    },
  });
});
afterEach(() => {
  Element.prototype.attachShadow = realAttach;
  vi.unstubAllGlobals();
  delete (window as any).__berrytraceRecordingInstalled;
  document.body.innerHTML = '';
  vi.resetModules();
});

describe('拾取态点击', () => {
  it('点「标注」进拾取 → 点页面链接：既报标注也报点击，且页面的点击没被拦', async () => {
    await import('./recordContentScript');
    const pick = shadow!.querySelector('[data-act="pick"]') as HTMLElement;
    expect(pick, '对照组：工具条里有标注钮').toBeTruthy();
    pick.click();
    sent.length = 0;
    const link = document.getElementById('link') as HTMLElement;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    const types = sent.map((s) => s.type);
    expect(types).toContain('berrytrace-recording-annotate');
    expect(types).toContain('berrytrace-recording-event');
    const click = sent.find((s) => s.type === 'berrytrace-recording-event')!.payload;
    expect(click.kind).toBe('click');
  });
});
