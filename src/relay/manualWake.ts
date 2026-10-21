/**
 * 手动唤醒：自动唤醒没成功时，用户在插件弹窗里点一下的补救。
 *
 * ── 它存在的理由（客户 Windows 电脑，李博 1012 演示）──────────────────────
 * 录制已经开着，再启动 Chrome 打开网页，页面上没有录制工具条。自动路径
 * （浏览器启动 / 打开网页 / 30 秒闹钟）失败时，用户看不到任何原因，
 * 现场只能干等。这里把「现在卡在哪一步」翻成一句人话，并且强制走一遍
 * 连接 → 问宿主在不在录 → 给已开着的页面补注入。
 *
 * ⚠️ 这是临时手段，不替代自动唤醒。自动唤醒的缺口要另外查
 * （看 welcome.html?diag=1 里的诊断，或下面这句话里说的那一步）。
 * 失效条件：自动唤醒在客户机上被证实稳定、且弹窗里这颗按钮一个月没人点之后可删。
 *
 * 判定抠成纯函数：探测取决于浏览器和宿主，判定不该取决于它们。
 */

export type WakeCode = 'unsupported' | 'disabled' | 'unpaired' | 'unreachable' | 'no-answer' | 'idle' | 'ok';

export interface WakeFacts {
  /** 本浏览器有没有 chrome.debugger（没有就整个中继不启用） */
  supported: boolean;
  /** storage 里的开关；默认开 */
  enabled: boolean;
  /** 有没有口令（pairing.json 或配对页存下的） */
  paired: boolean;
  /** 强制重连之后，握手是否真的成了（只认 OPEN） */
  connected: boolean;
  /** 宿主说现在是否在录；问不到为 null */
  hostRecording: boolean | null;
  /** 补注入打到了几个页面 */
  injected: number;
}

export interface WakeReport {
  code: WakeCode;
  message: string;
  /** 未配对 / 连不上时让弹窗打开的配对页（宿主在录制时才会起中继，所以要先在 App 里开始录制） */
  pairUrl?: string;
}

export function wakeVerdict(f: WakeFacts, port: number): WakeReport {
  if (!f.supported) return { code: 'unsupported', message: '这个浏览器不支持录制联动' };
  if (!f.enabled) return { code: 'disabled', message: '浏览器联动被关掉了，请在插件设置里打开' };
  if (!f.paired) {
    return {
      code: 'unpaired',
      message: '还没和莓莓印记配对。先在 App 里开始录制，再点这里，会打开配对页',
      pairUrl: `http://127.0.0.1:${port}/pair`,
    };
  }
  if (!f.connected) {
    return {
      code: 'unreachable',
      message: '连不上莓莓印记：App 没在运行、还没开始录制，或配对口令过期（重装过插件需要重新配对）',
      pairUrl: `http://127.0.0.1:${port}/pair`,
    };
  }
  if (f.hostRecording === null) {
    return { code: 'no-answer', message: '已连上莓莓印记，但它没回答“是否在录制”，请稍后再点一次' };
  }
  if (f.hostRecording !== true) return { code: 'idle', message: '已连上莓莓印记，但现在没有在录制' };
  return { code: 'ok', message: `已唤醒，${f.injected} 个页面已补上工具条` };
}
