import { describe, expect, it } from 'vitest';
import { probeTabsAttached } from './probeTabs';

const tab = (id: number, url = 'https://a.test/') => ({ id, url });

describe('probeTabsAttached', () => {
  it('一页永远不回 ⇒ 那页是 null，其余页照常，整体不被拖住', async () => {
    const r = await probeTabsAttached(
      [tab(1), tab(2), tab(3)],
      (t) => (t.id === 2 ? new Promise<boolean | null>(() => {}) : Promise.resolve(t.id === 1)),
      30,
    );
    expect(r.map((x) => [x.tab.id, x.挂上了])).toEqual([[1, true], [2, null], [3, false]]);
  });
  it('检查抛错 ⇒ null（不是 false）', async () => {
    const r = await probeTabsAttached([tab(1)], () => Promise.reject(new Error('x')), 30);
    expect(r[0].挂上了).toBeNull();
  });
  it('跳过非 http 页', async () => {
    const r = await probeTabsAttached([tab(1, 'chrome://x'), tab(2)], async () => true, 30);
    expect(r.map((x) => x.tab.id)).toEqual([2]);
  });
});
