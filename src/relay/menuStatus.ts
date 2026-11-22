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

/** 客户端回的扩展包更新状态；和客户端自动升级是同一个判定（electron/services/extension-auto-upgrade.ts）。 */
export type UpdateStatus = 'up-to-date' | 'update-available' | 'unknown' | 'busy' | 'not-installed';
export interface UpdateView { text: string; canUpdate: boolean; ok: boolean }

/**
 * 菜单里「扩展是不是最新」那一行。纯函数。
 * 🔴 没连上客户端、或客户端答不出时，绝不显示「已是最新」——拿不到标记就是不知道。
 * connected：客户端连着没有（undefined=还没答复）；status：客户端回的状态（undefined=没答出，如老版本客户端不认这个请求）。
 * 失效条件：菜单页不再显示更新状态。
 */
export function updateView(connected: boolean | undefined, status: UpdateStatus | undefined): UpdateView {
  if (connected === undefined) return { text: '正在检查更新…', canUpdate: false, ok: false };
  if (!connected) return { text: '未连接客户端，无法检查更新', canUpdate: false, ok: false };
  switch (status) {
    case 'up-to-date': return { text: '扩展已是最新', canUpdate: false, ok: true };
    case 'update-available': return { text: '发现新版，客户端会自动更新', canUpdate: true, ok: false };
    case 'busy': return { text: '正在录制或安装中，稍后自动更新', canUpdate: false, ok: false };
    case 'not-installed': return { text: '', canUpdate: false, ok: false };
    case 'unknown': return { text: '暂时查不到最新版（可能没联网）', canUpdate: false, ok: false };
    default: return { text: '客户端版本较旧，无法检查更新', canUpdate: false, ok: false };
  }
}
