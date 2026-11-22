import { describe, it, expect } from 'vitest';
import { statusView } from './menuStatus';

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
