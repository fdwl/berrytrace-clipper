import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { panelWaitView, panelWaitDetail, WAKE_URL } from './agentPanelState';

const read = (p: string): string => readFileSync(resolve(__dirname, p), 'utf8');

describe('侧栏等客户端：显示什么', () => {
  it('没连上客户端 → 显示「启动」链接，并说明勾「始终允许」', () => {
    const v = panelWaitView({ ok: false, error: 'NOT_CONNECTED' });
    expect(v.showLaunch).toBe(true);
    expect(v.text).toContain('始终允许');
  });
  it('后台没回话（undefined）也按没连上处理', () => {
    expect(panelWaitView(undefined).showLaunch).toBe(true);
  });
  it('对照组：客户端已连上、正在拉起对话页服务 → 不显示启动链接', () => {
    const v = panelWaitView({ ok: false, error: '客户端还在准备网页服务' });
    expect(v.showLaunch).toBe(false);
  });
});

describe('卡住时那行小字：能说清最后一次失败是什么', () => {
  it('非终局的其它错误：原文原样出现，带次数和版本', () => {
    const v = panelWaitView({ ok: false, error: 'DISCONNECTED' }, { attempt: 7, version: '1.7.3.9731' });
    expect(v.showLaunch).toBe(false);
    expect(v.detail).toBe('最后一次失败：DISCONNECTED · 第 7 次 · 扩展 v1.7.3.9731');
  });
  it('没连上中继：也写明原因，不是空白', () => {
    expect(panelWaitView({ ok: false, error: 'NOT_CONNECTED' }, { attempt: 2, version: '1' }).detail).toContain('NOT_CONNECTED');
  });
  it('对照组：后台没回话时写「后台没回话」，不吞成空', () => {
    expect(panelWaitDetail(undefined, { attempt: 1, version: '' })).toBe('最后一次失败：后台没回话 · 第 1 次');
  });
  it('页面真的把它画出来、并把版本传进去（接线）', () => {
    const page = read('./agentPanelPage.ts');
    expect(page).toContain('detailEl.textContent = view.detail');
    expect(page).toContain('panelWaitView(r, { attempt, version: chrome.runtime.getManifest().version })');
  });
});

describe('唤醒必须由用户点的真链接完成（后台标签的确认框用户看不到）', () => {
  it('后台脚本里不许再 tabs.create 一个 berrytrace:// 标签', () => {
    const sw = read('./annotate/annotateSwBridge.ts');
    expect(sw).not.toMatch(/tabs\.create\([^)]*berrytrace:\/\//);
    expect(sw).not.toContain('wakeClientSilently');
  });
  it('侧栏页里是 <a href=WAKE_URL>，不是脚本导航', () => {
    const page = read('./agentPanelPage.ts');
    expect(page).toContain('link.href = WAKE_URL');
    expect(page).not.toMatch(/location\.href\s*=\s*WAKE_URL/);
    expect(WAKE_URL).toBe('berrytrace://wake?silent=true');
  });
});
