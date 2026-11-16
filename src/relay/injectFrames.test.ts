import { describe, expect, it } from 'vitest';
import { listPageFrames, scriptTarget } from './injectFrames';

describe('scriptTarget', () => {
  it('不给 frameId ⇒ 顶层页面，目标里不带 frameIds（原行为）', () => {
    expect(scriptTarget(7)).toEqual({ tabId: 7 });
  });
  it('给了 frameId ⇒ 带 frameIds', () => {
    expect(scriptTarget(7, 12)).toEqual({ tabId: 7, frameIds: [12] });
  });
});

describe('listPageFrames', () => {
  const fake = (rows: Array<{ frameId?: number; result?: unknown }>) => ({
    seen: [] as unknown[],
    async executeScript(inj: unknown) { this.seen.push(inj); return rows; },
  });

  it('跳过顶层（frameId 0）与没结果的 frame，按 frameId 升序', async () => {
    const s = fake([
      { frameId: 9, result: { url: 'https://b.test/x', name: 'second', depth: 2 } },
      { frameId: 0, result: { url: 'https://top.test/', name: '', depth: 0 } },
      { frameId: 3, result: { url: 'https://a.test/', name: '', depth: 1 } },
      { frameId: 5 },
    ]);
    const r = await listPageFrames(s, 7);
    expect(r).toEqual([
      { frameId: 3, url: 'https://a.test/', name: '', depth: 1 },
      { frameId: 9, url: 'https://b.test/x', name: 'second', depth: 2 },
    ]);
  });

  it('对所有 frame 各跑一次（allFrames）', async () => {
    const s = fake([]);
    await listPageFrames(s, 7);
    expect(s.seen[0]).toMatchObject({ target: { tabId: 7, allFrames: true } });
  });
});
