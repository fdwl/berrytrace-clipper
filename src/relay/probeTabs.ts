/**
 * 录制探针对每个标签页的探测：并行 + 单页超时。
 *
 * 1021 李博 Mac 实测：Edge 里有一页让 `chrome.scripting.executeScript` 迟迟不回（具体哪页没查），
 * 原来的串行 for 循环被它拖住，整条 `berrytrace.recordingProbe` 超过宿主的 15 秒预算，
 * 宿主拿到的是「整个探针超时」，于是桌面条永远不会和网页条交接。
 * ⇒ 单页超时一律当「问不出来」（null，不是 false），其他页照常回。
 *
 * 失效条件：宿主不再用探针结果判桌面条交接（recording-bar-handoff 被删）之后，可删本文件。
 */

export const PROBE_TAB_TIMEOUT_MS = 2000;

export async function probeTabsAttached<T extends { id?: number; url?: string }>(
  tabs: readonly T[],
  check: (tab: T) => Promise<boolean | null>,
  timeoutMs: number = PROBE_TAB_TIMEOUT_MS,
): Promise<Array<{ tab: T; 挂上了: boolean | null }>> {
  const withTimeout = (p: Promise<boolean | null>): Promise<boolean | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        () => { clearTimeout(timer); resolve(null); },
      );
    });
  const eligible = tabs.filter((t) => typeof t.id === 'number' && /^https?:/i.test(t.url ?? ''));
  return Promise.all(eligible.map(async (tab) => ({ tab, 挂上了: await withTimeout(check(tab)) })));
}
