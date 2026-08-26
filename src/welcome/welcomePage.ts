/**
 * 欢迎页自己的脚本（webpack entry `welcome` → 包里的 `welcome.js`）。
 *
 * ── 为什么按钮是 <a> 而不是 <button> ────────────────────────────────────────
 * 拉起桌面端靠的是**自定义协议**（`berrytrace://`）。浏览器只在「用户手势直接
 * 触发的顶层导航」上才会弹「是否打开莓莓印记」那个系统对话框：
 *   · `location.href = 'berrytrace://…'`（脚本导航）会被当成非用户手势拦掉；
 *   · `chrome.tabs.update({url})` 直接抛 `Cannot navigate to invalid URL`
 *     —— 扩展 API 只认它认识的 scheme。
 * ⇒ 唯一稳的形态是页面上放一个真的 `<a href="berrytrace://…">`，让用户自己点它。
 *   本文件只在旁边挂监听器**记一笔**，绝不 `preventDefault` —— 拦了就没原生导航了。
 *
 * ── 那条 scheme 是怎么核实的，不是猜的 ──────────────────────────────────────
 * 桌面端 `berrytrace_app/electron/services/protocol-handler.ts:138-148`
 * `registerProtocolClient()` 里：
 *     const scheme = !app.isPackaged ? 'berrytrace-dev' : 'berrytrace'
 *     app.setAsDefaultProtocolClient(scheme)
 * 由 `electron/main.ts:254` 在启动时无条件调用。⇒ 正式包注册的就是 `berrytrace://`。
 * 收到之后 `handleProtocolUrl()`（同文件 :167）第一件事是 :175-177
 * `if (!isSilent) ElectronMainWindow.getInstance().showWindow()` ——
 * **在按 host 分发之前**。所以 `berrytrace://open` 这种它不认识的 host 的净效果，
 * 正好就是我们要的「把 App 拉到前台，别的什么都不做」。
 * （html 里那条 href 就是它，改的时候两边一起改。）
 *
 * ── 三个可查的时间戳，见 onInstall.ts 的说明 ────────────────────────────────
 * 本文件负责其中两个：`btWelcomeLoadedAt`（页面真跑起来了）、
 * `btWelcomeLaunchedAt`（用户真点了）。
 */

/** 点完多久还留在本页，就把「没反应？」那一段亮出来。 */
const FALLBACK_DELAY_MS = 2500;

function remember(patch: Record<string, unknown>): void {
	try {
		chrome?.storage?.local?.set(patch);
	} catch {
		// 页面是从 chrome-extension:// 开的，正常情况下一定有 storage；
		// 万一没有（比如被人另存成本地文件打开），页面本身照样要能用。
	}
}

function init(): void {
	remember({ btWelcomeLoadedAt: Date.now() });

	const versionEl = document.getElementById('welcome-version');
	if (versionEl) {
		try {
			versionEl.textContent = `Berrytrace Clipper ${chrome.runtime.getManifest().version}`;
		} catch {
			versionEl.textContent = '';
		}
	}

	const launch = document.getElementById('launch-app') as HTMLAnchorElement | null;
	const fallback = document.getElementById('launch-fallback');
	if (!launch) return;

	launch.addEventListener('click', () => {
		// 🔴 不 preventDefault：原生导航才是真正把 App 拉起来的那一跳。
		remember({ btWelcomeLaunchedAt: Date.now(), btWelcomeLaunchUrl: launch.getAttribute('href') });
		// 拉不起来是没有事件可听的（协议没注册时浏览器要么静默、要么弹一个我们看不到的框），
		// ⇒ 只能按时间兜底：还在这页上就说明多半没成，把手动指引亮出来。
		window.setTimeout(() => fallback?.classList.remove('is-hidden'), FALLBACK_DELAY_MS);
	});
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
	init();
}
