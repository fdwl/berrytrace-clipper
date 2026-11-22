/**
 * 菜单页顶部「客户端连接状态」的显示。纯函数，便于测。
 * 后台 service worker 刚被点击唤醒时，到客户端的连接往往还在握手，那一刻问「连上了吗」会得到「没连上」；
 * 所以菜单页开着期间每秒再问一次，状态跟着变，不拿「过了多久」判失败。
 * 失效条件：菜单页不再显示连接状态。
 */
export interface StatusView { on: boolean; text: string; hint: string }

export const STATUS_POLL_MS = 1000;

/** connected：true 已连接；false 没连上（可能还在握手）；undefined 还没得到答复。 */
export function statusView(connected: boolean | undefined): StatusView {
  if (connected === undefined) return { on: false, text: '正在检测客户端…', hint: '' };
  if (connected) return { on: true, text: '客户端已连接', hint: '' };
  return { on: false, text: '客户端未连接', hint: '用 Agent 对话框会自动启动' };
}
