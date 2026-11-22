/**
 * 「用户此刻正在看的那个标签」—— 宿主 `berrytrace.activeTab` 的取法。
 *
 * 用在浏览器右侧栏里的 Agent：它要读写的是用户眼前这一页，不是自动化通道自己开的标签。
 *
 * 为什么在扩展里、在**调用那一刻**取，而不是让侧栏页把 tabId 传给宿主：
 * - 侧栏发消息时记下的 tabId 会过期：用户发完消息切了标签，Agent 再读的应当是新的这一页；
 * - 宿主收到工具调用时不知道是哪个侧栏发的（工具调用只带会话，不带浏览器窗口），
 *   而浏览器自己知道「最后获得焦点的窗口里的活动标签」。
 * 只认普通窗口（windowType normal）：弹窗、开发者工具窗口不算「用户在看的页面」。
 *
 * 失效条件：宿主不再调用 `berrytrace.activeTab`（宿主仓 `git grep -n "berrytrace.activeTab" -- electron` 零命中）后可删本文件。
 */

export interface ActiveTabInfo {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  status: string;
}

interface TabLike {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
  status?: string;
}

export interface TabsQueryLike {
  query(q: { active: boolean; lastFocusedWindow: boolean; windowType: 'normal' }): Promise<TabLike[]>;
}

/** 找不到时抛的错误原话前缀，宿主照实转给模型。 */
export const NO_ACTIVE_TAB = 'NO_ACTIVE_TAB';

export async function findActiveTab(tabs: TabsQueryLike): Promise<ActiveTabInfo> {
  const found = await tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  const tab = found.find(t => typeof t.id === 'number');
  if (!tab || typeof tab.id !== 'number') {
    throw new Error(`${NO_ACTIVE_TAB}: 浏览器里没有可用的活动标签（最后获得焦点的窗口不是普通浏览器窗口，或窗口里没有标签）`);
  }
  return {
    tabId: tab.id,
    windowId: tab.windowId ?? -1,
    url: tab.url ?? '',
    title: tab.title ?? '',
    status: tab.status ?? '',
  };
}
