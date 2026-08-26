/**
 * 首次安装后弹「安装成功」欢迎页。
 *
 * ── 为什么是扩展内置页面，不是远程页面 ──────────────────────────────────────
 * 远程页面（比如 getdear.cn/welcome）在**没网、站点在维护**的时候就是一张白纸，
 * 而「刚装完插件」恰恰是最不能出白纸的一刻。内置页面跟扩展一起发货，离线照样弹。
 *
 * ── 为什么接线在这儿，不在 src/background.ts 里 ─────────────────────────────
 * `src/background.ts` 是**上游 obsidian 的文件**（它自己在 :888 已经有一个
 * `onInstalled` 监听器）。往里加东西就是在每次合并上游时给自己埋冲突点，
 * 而且 0826 踩过一次：源文件被 `git checkout` 还原时把我们加的接线一起还原掉了，
 * 构建全绿、产物齐全、功能没了。⇒ 我们自己的东西放自己的文件里，
 * 由 `src/relay/background-entry.ts` 统一挂。
 * `onInstalled` 允许多个监听器，跟上游那个不冲突。
 *
 * ── 判据坐在结果上 ──────────────────────────────────────────────────────────
 * 「弹出来了」不能靠猜。三个时间戳写在 `chrome.storage.local` 里，外部可查：
 *   · `btWelcomeShownAt`    —— 标签页**真的建出来了**（tabs.create 回调拿到了 tab.id）
 *   · `btWelcomeLoadedAt`   —— 页面**真的跑起来了**（由 welcomePage.ts 自己写）
 *   · `btWelcomeLaunchedAt` —— 用户**真的点了**「启动莓莓印记」
 * 建标签失败时写 `btWelcomeError` 而不是照样写 shownAt —— 写了就等于说了谎。
 * 查法（扩展管理页 → 该扩展的 service worker 控制台）：
 *   chrome.storage.local.get(
 *     ['btWelcomeShownAt','btWelcomeLoadedAt','btWelcomeLaunchedAt','btWelcomeError'],
 *     console.log)
 *
 * ⚠️ `chrome.tabs.create` **不需要 `tabs` 权限**（那条权限管的是读 url/title 这类
 *    跨标签隐私数据）。所以这里没有、也不该有 `permissions.request`。
 */

/** 欢迎页在包里的文件名。改这里要同步改 webpack 的 CopyPlugin 和 verify-published.py。 */
export const WELCOME_PAGE = 'welcome.html';

function markShown(tabId: number | undefined): void {
	try {
		chrome.storage.local.set({
			btWelcomeShownAt: Date.now(),
			btWelcomeVersion: chrome.runtime.getManifest().version,
			btWelcomeTabId: typeof tabId === 'number' ? tabId : null,
		});
	} catch {
		// storage 写不进去不该连累安装本身 —— 页面已经弹了才是用户看得见的那件事。
	}
}

function markError(reason: string): void {
	try {
		chrome.storage.local.set({ btWelcomeError: reason, btWelcomeErrorAt: Date.now() });
	} catch {
		/* 同上 */
	}
}

function openWelcomeTab(): void {
	const url = chrome.runtime.getURL(WELCOME_PAGE);
	try {
		// 回调式而不是 await：Firefox 的 `chrome.*` 命名空间是回调风格的，
		// 两边都吃得下的只有这一种写法。
		chrome.tabs.create({ url, active: true }, tab => {
			const err = chrome.runtime.lastError;
			if (err || !tab) {
				markError(err?.message || 'tabs.create returned no tab');
				return;
			}
			markShown(tab.id);
		});
	} catch (e) {
		markError(String(e));
	}
}

export function initWelcomeOnInstall(): void {
	// Safari 上这些 API 的形状不一样，缺了就整个不启用 —— 跟中继那一层同一条判据：
	// 按**运行时**有没有这个 API 判，不靠构建期开关（三套构建共用一份源码）。
	if (typeof chrome === 'undefined' || !chrome.runtime?.onInstalled || !chrome.tabs?.create) return;

	chrome.runtime.onInstalled.addListener(details => {
		// 只认首次安装。`update` 也弹的话，用户每次自动更新都会被塞一个标签页 ——
		// 那是骚扰，不是欢迎。
		if (details.reason !== 'install') return;
		openWelcomeTab();
	});
}
