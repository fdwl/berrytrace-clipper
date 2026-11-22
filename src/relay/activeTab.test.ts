import { describe, expect, it } from 'vitest';
import { findActiveTab, NO_ACTIVE_TAB, type TabsQueryLike } from './activeTab';

const fakeTabs = (rows: Array<{ id?: number; windowId?: number; url?: string; title?: string; status?: string }>) => {
  const seen: unknown[] = [];
  const api: TabsQueryLike & { seen: unknown[] } = {
    seen,
    async query(q) { seen.push(q); return rows; },
  };
  return api;
};

describe('findActiveTab', () => {
  it('问的是「最后获得焦点的普通窗口里的活动标签」', async () => {
    const t = fakeTabs([{ id: 5, windowId: 2, url: 'https://www.doubao.com/chat', title: '豆包', status: 'complete' }]);
    await findActiveTab(t);
    expect(t.seen).toEqual([{ active: true, lastFocusedWindow: true, windowType: 'normal' }]);
  });

  it('返回标签号、窗口号、网址、标题', async () => {
    const t = fakeTabs([{ id: 5, windowId: 2, url: 'https://www.doubao.com/chat', title: '豆包', status: 'complete' }]);
    expect(await findActiveTab(t)).toEqual({
      tabId: 5, windowId: 2, url: 'https://www.doubao.com/chat', title: '豆包', status: 'complete',
    });
  });

  it('跳过没有 id 的标签', async () => {
    const t = fakeTabs([{ url: 'devtools://x' }, { id: 9, windowId: 1 }]);
    expect((await findActiveTab(t)).tabId).toBe(9);
  });

  it('一个都没有 ⇒ 抛 NO_ACTIVE_TAB，不猜别的窗口', async () => {
    await expect(findActiveTab(fakeTabs([]))).rejects.toThrow(NO_ACTIVE_TAB);
  });
});
