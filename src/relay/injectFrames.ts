/**
 * 「只注入、不挂调试器」通道里的 iframe 支持：列出标签页里的 iframe，并在指定 iframe 里执行脚本。
 *
 * 为什么不用调试器：个别站点在标签挂着 chrome.debugger 时页面起不来（宿主 inject:true 的起因），
 * 而 `chrome.scripting.executeScript` 本来就能用 `frameIds` 指向任意 iframe（含跨域），
 * 只要扩展有 scripting 权限和该站点的访问权限（manifest 的 host_permissions 是 <all_urls>）。
 * 列 iframe 不另加 webNavigation 权限：给每个 frame 各跑一次小函数，返回的 frameId 就是答案
 * （加权限会让用户的浏览器在升级时重新弹授权）。
 *
 * 失效条件：宿主不再有 inject 通道（宿主仓 `git grep -n "inject: true\|inject:true" -- electron` 零命中）后可删本文件。
 */

export interface PageFrame {
  /** chrome 的 frameId（0 = 顶层页面，不在列表里）。 */
  frameId: number;
  url: string;
  name: string;
  /** 1 = 页面里的 iframe，2 = iframe 里的 iframe。 */
  depth: number;
}

/** executeScript 的目标：不给 frameId = 顶层页面（原行为）。 */
export function scriptTarget(tabId: number, frameId?: number): { tabId: number; frameIds?: number[] } {
  return typeof frameId === 'number' ? { tabId, frameIds: [frameId] } : { tabId };
}

interface ScriptingLike {
  executeScript(inj: {
    target: { tabId: number; allFrames?: boolean };
    world?: 'MAIN' | 'ISOLATED';
    func: () => unknown;
  }): Promise<Array<{ frameId?: number; result?: unknown }>>;
}

/**
 * 页面里的 iframe，按 frameId 升序（同一个页面里这个顺序是稳定的，宿主按序号挑）。
 * 不可注入的 frame（chrome:// 之类、被浏览器拦的）不会出现在结果里，这是浏览器的行为，不是错误。
 */
export async function listPageFrames(scripting: ScriptingLike, tabId: number): Promise<PageFrame[]> {
  const results = await scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'ISOLATED',
    // 🔴 会被序列化后注入页面：不能引用外部变量，也不能写 async/await（见 berrytraceRelay.ts 的 pageEval 注释）。
    func: () => {
      let depth = 0;
      let w: Window = window;
      while (w !== w.top && depth < 32) { depth++; w = w.parent; }
      return { url: location.href, name: window.name || '', depth };
    },
  });
  const frames: PageFrame[] = [];
  for (const r of results) {
    const v = r.result as { url?: string; name?: string; depth?: number } | undefined;
    if (typeof r.frameId !== 'number' || r.frameId === 0 || !v) continue;
    frames.push({ frameId: r.frameId, url: v.url ?? '', name: v.name ?? '', depth: v.depth ?? 1 });
  }
  return frames.sort((a, b) => a.frameId - b.frameId);
}
