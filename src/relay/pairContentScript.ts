/**
 * 配对用的 content script。只在本机回环地址上跑（见 manifest 的 matches）。
 *
 * ── 三方是怎么对上的 ─────────────────────────────────────────────────────────
 *   App（宿主）  ──打开──▶  http://127.0.0.1:<port>/pair#<token>
 *                              │ 页面自己不碰任何扩展 API，只 postMessage
 *                              ▼
 *                        本文件（content script）
 *                              │ 先回连 /pair/verify 确认对面就是发这个 token 的服务
 *                              │ 再把 token 存进 storage，并叫醒 background 去连
 *                              ▼
 *                        background 的 BerrytraceRelay
 *
 * ── 为什么要有「用户点一次允许」这一步 ───────────────────────────────────────
 * 「打开页面就自动存 token」听着最省事，但**任何能在本机起 HTTP 服务的程序**
 * 都能仿一个一模一样的页面，把自己的 token 塞给我们，于是它就拿到了这台浏览器的 CDP。
 * **零点击的代价是零授权。** 所以页面上那个「允许」按钮不是装饰，别把它优化掉。
 *
 * ── 为什么页面不直接跟 background 说话 ──────────────────────────────────────
 * `externally_connectable` 要在 manifest 里写死可以连进来的站点，
 * 而我们的端口是可变的、站点是 `127.0.0.1` —— 那条路会把「任意本机服务」
 * 一次性放进来。走 content script + `window.postMessage`，
 * 每一步都在我们自己的代码里，能加验证。
 */

type PairMessage =
  | { type: 'berrytrace-pair-ping' }
  | { type: 'berrytrace-pair-approve'; token: string; port: string };

const RELAY_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 只在回环地址上工作。别的站点发同名消息一律不理。 */
function isLoopback(): boolean {
  return RELAY_HOSTS.has(location.hostname);
}

async function verifyAndStore(token: string, port: string): Promise<boolean> {
  // 🔴 先回连确认：光凭页面上写着的 token 就存，等于谁都能给我们塞一个。
  // 这一步证明的是「发这个 token 的服务，确实认这个 token」。
  try {
    const res = await fetch(`http://127.0.0.1:${port}/pair/verify?token=${encodeURIComponent(token)}`, {
      // 不带 cookie —— 这是本机 IPC，不是带身份的请求。
      credentials: 'omit',
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; app?: string };
    if (!body?.ok || body.app !== 'berrytrace') return false;
  } catch {
    return false;
  }

  await chrome.storage.local.set({
    btRelayToken: token,
    btRelayPort: Number(port),
    btRelayEnabled: true,
  });
  // 叫醒 background：不然它还在按退避节奏睡，用户点完「允许」要等几十秒才连上。
  await chrome.runtime.sendMessage({ type: 'berrytrace-relay-paired' }).catch(() => {});
  return true;
}

/**
 * 主动告诉页面「插件在」。
 *
 * 🔴 **不能只等页面发 ping**：页面里那段脚本是同步执行的，而 content script
 * 注入有自己的时机。`document_end` 的时候页面早就把 ping 发完了 ——
 * 我们错过它，页面等 1.5 秒之后就显示「没有检测到插件」，而插件其实装着。
 * ⇒ 两头都做：这里注入后主动播几次，页面那边也重试几次 ping。
 *   多播几次是廉价的，漏一次的代价是用户以为插件没装。
 */
function announcePresence(): void {
  const send = () => window.postMessage({ type: 'berrytrace-pair-present' }, location.origin);
  send();
  // document_start 时页面脚本还没跑、监听器还没挂上，所以隔一会儿再播两次。
  setTimeout(send, 50);
  setTimeout(send, 300);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', send, { once: true });
  }
}

if (isLoopback()) {
  announcePresence();
  window.addEventListener('message', (event: MessageEvent<PairMessage>) => {
    // 只认同一个 window 发出来的消息，挡掉 iframe 里的伪造。
    if (event.source !== window || !event.data) return;
    const msg = event.data;

    if (msg.type === 'berrytrace-pair-ping') {
      // 告诉页面「插件在」。页面靠它把「请先安装插件」那句提示换掉。
      window.postMessage({ type: 'berrytrace-pair-present' }, location.origin);
      return;
    }

    if (msg.type === 'berrytrace-pair-approve') {
      if (typeof msg.token !== 'string' || !msg.token) return;
      void verifyAndStore(msg.token, msg.port || location.port).then(ok => {
        window.postMessage(
          { type: ok ? 'berrytrace-pair-done' : 'berrytrace-pair-failed' },
          location.origin,
        );
      });
    }
  });
}
