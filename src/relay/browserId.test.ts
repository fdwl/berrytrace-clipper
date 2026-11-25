import { describe, expect, it } from 'vitest';
import { browserIdFromUserAgent } from './browserId';

const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  // 2026-11-25 在 Windows 真机上从华为浏览器里读到的 UA 尾部。
  huawei: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.84 Safari/537.36 HBPC/12.1.4.300',
};

describe('browserIdFromUserAgent', () => {
  it('Chrome 报 chrome', () => {
    expect(browserIdFromUserAgent(UA.chrome)).toBe('chrome');
  });
  it('Edge 报 edge（UA 里同时有 Chrome/，不能落到 chrome）', () => {
    expect(browserIdFromUserAgent(UA.edge)).toBe('edge');
  });
  it('华为浏览器报 hwbrowser，不能当成 chrome', () => {
    expect(browserIdFromUserAgent(UA.huawei)).toBe('hwbrowser');
  });
  it('认不出的报 other', () => {
    expect(browserIdFromUserAgent('curl/8')).toBe('other');
  });
});
