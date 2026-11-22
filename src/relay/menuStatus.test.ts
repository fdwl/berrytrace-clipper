import { describe, it, expect } from 'vitest';
import { statusView, updateView } from './menuStatus';

describe('菜单页连接状态', () => {
  it('已连接 / 没连上 / 还没答复 三种显示不同', () => {
    expect(statusView(true)).toMatchObject({ on: true, text: '客户端已连接' });
    expect(statusView(false)).toMatchObject({ on: false, text: '客户端未连接' });
    expect(statusView(undefined)).toMatchObject({ on: false, text: '正在检测客户端…' });
  });
  it('对照组：没连上时给出下一步提示，已连接时不给', () => {
    expect(statusView(false).hint).not.toBe('');
    expect(statusView(true).hint).toBe('');
  });
});

describe('菜单页扩展更新状态', () => {
  it('🔴 没连上客户端 → 不能显示「已是最新」（对照组：连上且客户端答最新才是最新）', () => {
    expect(updateView(false, 'up-to-date').text).toBe('未连接客户端，无法检查更新');
    expect(updateView(false, 'up-to-date').ok).toBe(false);
    expect(updateView(true, 'up-to-date')).toMatchObject({ text: '扩展已是最新', ok: true });
  });
  it('有新版 → 给「立即更新」；其它状态不给', () => {
    expect(updateView(true, 'update-available')).toMatchObject({ canUpdate: true });
    for (const s of ['up-to-date', 'busy', 'unknown', 'not-installed'] as const) expect(updateView(true, s).canUpdate).toBe(false);
  });
  it('查不到线上 / 老客户端不认 → 说清楚，不装作最新', () => {
    expect(updateView(true, 'unknown').text).toContain('查不到');
    expect(updateView(true, undefined).text).toContain('较旧');
    expect(updateView(undefined, undefined).text).toContain('正在检查');
  });
});
