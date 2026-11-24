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
  /**
   * 一行小字：最后一次失败的原因原文 + 第几次重试 + 扩展版本。
   * 为什么要有：「正在启动客户端…」会盖住所有非终局的失败原因，客户机器上没有日志时，
   * 卡住了谁也说不清是没连上中继、中继断了还是客户端回了别的错误。有这一行，客户一张截图就能定位。
   * 失效条件：侧栏不再无期限重试（卡住时有明确终局界面）之后可删。
   */
  detail: string;
}

export interface PanelWaitContext {
  /** 第几次问（从 1 起） */
  attempt: number;
  /** 扩展版本（manifest.version） */
  version: string;
}

/** 后台回了没连上客户端（或根本没回）时，页面显示的内容。 */
export function panelWaitView(r: PanelUrlReply | undefined, ctx: PanelWaitContext = { attempt: 0, version: '' }): PanelWaitView {
  const detail = panelWaitDetail(r, ctx);
  const notConnected = !r || (!r.ok && r.error === 'NOT_CONNECTED');
  if (notConnected) {
    return {
      text: '莓莓印记客户端没在运行。点下面的按钮启动；浏览器问「是否允许」时勾上「始终允许」，以后一点就启动。',
      showLaunch: true,
      detail,
    };
  }
  return { text: '正在启动莓莓印记客户端…', showLaunch: false, detail };
}

/** 纯函数：卡住时那行小字。回复里没有原因时写明「后台没回话」，不留空。 */
export function panelWaitDetail(r: PanelUrlReply | undefined, ctx: PanelWaitContext): string {
  const reason = !r ? '后台没回话' : r.ok ? '回复里没有地址' : (r.error || '(空)');
  const parts = [`最后一次失败：${reason}`];
  if (ctx.attempt > 0) parts.push(`第 ${ctx.attempt} 次`);
  if (ctx.version) parts.push(`扩展 v${ctx.version}`);
  return parts.join(' · ');
}
