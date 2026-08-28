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

/**
 * 显示「这个浏览器的自动化能力就绪了没有」。
 *
 * 🔴 **这里为什么没有「授权」按钮**（0828 实测，订正了上一版设计）：
 * `debugger` 是 Chrome 的**不可选权限** —— 即使写进 `optional_permissions`，
 * `chrome.permissions.request()` 也会当场拒绝：
 *   `Only permissions specified in the manifest may be requested.`
 * （同一份 optional 里的 `tabs` 就能正常弹确认框，所以不是我们写错了，是这条权限的规则。
 *   浏览器自己 `getManifest().optional_permissions` 里**还看得到它**，
 *   ⇒ 这是一处「配置看着生效、运行时静默失效」的形状，不实测发现不了。）
 *
 * ⇒ `debugger` 已经改回**必需权限**。解压安装（我们的自动安装那条路）不弹任何确认框；
 *   将来上商店的话，安装时的权限清单里会多一条，那是这条能力的固有成本。
 * ⇒ 这一段只负责**如实显示状态**，不假装能补救。
 */
function wireAutomationGrant(): void {
	const state = document.getElementById('grant-state');
	if (!state) return;
	try {
		chrome.permissions.contains({ permissions: ['debugger'] })
			.then(ok => {
				state.textContent = ok
					? '✅ 自动化能力已就绪。在 App 里发起一次配对就能用。'
					: '⚠️ 这个浏览器没有授予调试权限，自动化用不了（重新安装一次插件通常就好了）。';
			})
			.catch(() => { state.textContent = ''; });
	} catch {
		state.textContent = '';
	}
}

/**
 * `welcome.html?diag=1`：把中继写在 storage 里的自诊断日志显示出来。
 *
 * 🔴 这是**用户机器上唯一能看到扩展内部状态的窗口**：日常浏览器没有调试端口
 * （Chrome 136 起对默认 profile 忽略 `--remote-debugging-port`），
 * service worker 控制台进不去。把状态渲染成网页文字之后，
 * 桌面自动化读一张网页就能拿到它 —— 0828 排查「连上了却一句话不说」时全靠这条。
 */
function wireDiag(): void {
	const box = document.getElementById('relay-diag');
	if (!box) return;
	if (!new URLSearchParams(location.search).has('diag')) return;
	box.style.display = 'block';
	const paint = () => {
		chrome.storage.local.get(['btRelayDiag', 'btRelayToken', 'btRelayPort', 'btRelayEnabled'])
			.then(raw => {
				const d = raw.btRelayDiag as { swStartedAt?: number; updatedAt?: number; build?: string; counts?: Record<string, number>; log?: { t: number; e: string; d?: string }[] } | undefined;
				const head = `token=${raw.btRelayToken ? '有' : '无'} port=${raw.btRelayPort ?? '默认'} enabled=${raw.btRelayEnabled !== false}\n`
					+ `build=${d?.build ?? '-'} swStartedAt=${d?.swStartedAt ?? '-'} updatedAt=${d?.updatedAt ?? '-'} 现在=${Date.now()}\n`
					// 🔴 计数放在流水前面：流水只有最近 40 条，会被重连刷掉；计数不会。
					+ `计数=${JSON.stringify(d?.counts ?? {})}\n`;
				const lines = (d?.log ?? []).map(x => `+${x.t - (d?.swStartedAt ?? x.t)}ms ${x.e}${x.d ? ' ' + x.d : ''}`);
				box.textContent = 'BT-DIAG-BEGIN\n' + head + lines.join('\n') + '\nBT-DIAG-END';
			})
			.catch(e => { box.textContent = 'BT-DIAG-BEGIN\n读不到：' + (e as Error)?.message + '\nBT-DIAG-END'; });
	};
	paint();
	window.setInterval(paint, 2000);
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

	wireAutomationGrant();
	wireDiag();

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
