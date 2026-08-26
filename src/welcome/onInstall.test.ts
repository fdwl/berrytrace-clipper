/**
 * 欢迎页那条接线的守卫测试。
 *
 * 为什么值得写：这条链路**出问题的时候是没有声音的** —— 装完不弹页面，
 * 构建绿、产物齐、控制台干净，跟「功能正常但用户没注意」长得一模一样。
 * 0826 已经在同一个 background 里踩过一次同形态的事故（接线被还原掉，零报错）。
 *
 * 三条用例里有两条是**负向**的（不该弹的时候不弹、弹失败时不许写成功戳）——
 * 只验正向的守卫测试等于没验：它在「无论如何都写 shownAt」的实现上照样是绿的。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initWelcomeOnInstall, WELCOME_PAGE } from './onInstall';

type InstalledListener = (details: { reason: string }) => void;

function fakeChrome(opts: { createFails?: boolean } = {}) {
	const listeners: InstalledListener[] = [];
	const stored: Record<string, unknown> = {};
	let lastError: { message: string } | undefined;

	const api = {
		runtime: {
			onInstalled: { addListener: (fn: InstalledListener) => listeners.push(fn) },
			getURL: (p: string) => `chrome-extension://fake-id/${p}`,
			getManifest: () => ({ version: '9.9.9' }),
			get lastError() {
				return lastError;
			},
		},
		tabs: {
			create: vi.fn((_info: unknown, cb: (tab?: { id: number }) => void) => {
				if (opts.createFails) {
					lastError = { message: 'No window to create tab in' };
					cb(undefined);
				} else {
					lastError = undefined;
					cb({ id: 42 });
				}
			}),
		},
		storage: { local: { set: (patch: Record<string, unknown>) => Object.assign(stored, patch) } },
	};
	return { api, listeners, stored };
}

describe('首次安装弹欢迎页', () => {
	beforeEach(() => {
		delete (globalThis as Record<string, unknown>).chrome;
	});

	it('reason=install：开欢迎页，并写下可外部核查的 btWelcomeShownAt', () => {
		const { api, listeners, stored } = fakeChrome();
		(globalThis as Record<string, unknown>).chrome = api;

		initWelcomeOnInstall();
		expect(listeners).toHaveLength(1);

		listeners[0]({ reason: 'install' });

		expect(api.tabs.create).toHaveBeenCalledTimes(1);
		expect(api.tabs.create.mock.calls[0][0]).toMatchObject({
			url: `chrome-extension://fake-id/${WELCOME_PAGE}`,
			active: true,
		});
		expect(typeof stored.btWelcomeShownAt).toBe('number');
		expect(stored.btWelcomeVersion).toBe('9.9.9');
		expect(stored.btWelcomeTabId).toBe(42);
		expect(stored.btWelcomeError).toBeUndefined();
	});

	it('reason=update：什么都不做 —— 每次自动更新塞一个标签页是骚扰不是欢迎', () => {
		const { api, listeners, stored } = fakeChrome();
		(globalThis as Record<string, unknown>).chrome = api;

		initWelcomeOnInstall();
		listeners[0]({ reason: 'update' });

		expect(api.tabs.create).not.toHaveBeenCalled();
		expect(stored.btWelcomeShownAt).toBeUndefined();
	});

	it('标签页没建出来：写 btWelcomeError，**不许**照样写 shownAt', () => {
		const { api, listeners, stored } = fakeChrome({ createFails: true });
		(globalThis as Record<string, unknown>).chrome = api;

		initWelcomeOnInstall();
		listeners[0]({ reason: 'install' });

		expect(stored.btWelcomeShownAt).toBeUndefined();
		expect(stored.btWelcomeError).toBe('No window to create tab in');
		expect(typeof stored.btWelcomeErrorAt).toBe('number');
	});

	it('没有 chrome.tabs 的宿主（Safari 那种形状）：整个不启用，不抛异常', () => {
		(globalThis as Record<string, unknown>).chrome = {
			runtime: { onInstalled: { addListener: vi.fn() } },
		};
		expect(() => initWelcomeOnInstall()).not.toThrow();
	});
});
