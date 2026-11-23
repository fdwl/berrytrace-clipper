/**
 * 侧栏对话页在「客户端还没连上」时该显示什么。判定抠成纯函数，页面脚本只管把结果画出来。
 *
 * 为什么要有「启动」按钮（2026-11-23 Mac Chrome 157 真机实测）：
 *  · 后台脚本 `chrome.tabs.create({url:'berrytrace://…', active:false})` 开的是后台标签，
 *    浏览器的「要打开莓莓印记吗？」确认框挂在那个标签上，标签不被切到就一直不出现，客户端也就起不来；
 *  · 就算把标签切到前台，确认框因为没有发起来源，也没有「始终允许」选项，每次都要问；
 *  · 在扩展自己的页面里由用户点一个真 `<a href="berrytrace://…">`：确认框直接出现在用户眼前，
 *    还带「始终允许 chrome-extension://… 打开此类链接」，勾上之后以后一点就起，不再问。
 *  · 无手势的脚本导航（location.href）被浏览器直接拦掉，没有任何弹窗。
 *
 * 失效条件：浏览器允许扩展无手势静默拉起已记住的协议之后，可改回自动唤醒；
 * 核实方法见 台账 / 本文件对应的真机测试（`git log -S"agentPanelState"`）。
 */

export const WAKE_URL = 'berrytrace://wake?silent=true';

export interface PanelUrlReply {
  ok: boolean;
  error?: string;
  terminal?: boolean;
}

export interface PanelWaitView {
  text: string;
  /** 要不要显示「启动莓莓印记」链接（用户点它才是带手势的启动） */
  showLaunch: boolean;
}

/** 后台回了没连上客户端（或根本没回）时，页面显示的内容。 */
export function panelWaitView(r: PanelUrlReply | undefined): PanelWaitView {
  const notConnected = !r || (!r.ok && r.error === 'NOT_CONNECTED');
  if (notConnected) {
    return {
      text: '莓莓印记客户端没在运行。点下面的按钮启动；浏览器问「是否允许」时勾上「始终允许」，以后一点就启动。',
      showLaunch: true,
    };
  }
  return { text: '正在启动莓莓印记客户端…', showLaunch: false };
}
