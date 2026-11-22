import { describe, it, expect } from 'vitest';
import { isFromPanelFrame } from './panelFrameGuard';

describe('侧栏只认自己的 iframe', () => {
  const win = {};
  it('来源与窗口都对上才放行', () => {
    expect(isFromPanelFrame({ origin: 'http://127.0.0.1:5', source: win }, 'http://127.0.0.1:5', win)).toBe(true);
  });
  it('对照组：来源不对 / 窗口不对 / 还没加载（空来源）都拒绝', () => {
    expect(isFromPanelFrame({ origin: 'http://evil', source: win }, 'http://127.0.0.1:5', win)).toBe(false);
    expect(isFromPanelFrame({ origin: 'http://127.0.0.1:5', source: {} }, 'http://127.0.0.1:5', win)).toBe(false);
    expect(isFromPanelFrame({ origin: '', source: null }, '', null)).toBe(false);
  });
});
