/**
 * 标记模式 · 纯函数（不碰 DOM、不碰 chrome.*，单测直接喂合成输入）
 *
 * 一次标记 = 一个元素 + 一段备注（可选）+ 一张截图（可选），整份送进客户端输入框，只填不发。
 * 元素事实复用录制的 `snapshotElement`（密码框不读值等脱敏规矩在那边），这里只负责把它排成人和模型都能读的文字。
 */
import type { ElementSnapshot } from '../recordSnapshot';

/** 与宿主 `electron/services/chat-handoff-bridge.ts` 的方法名逐字一致 */
export const CHAT_HANDOFF_METHOD = 'berrytrace.chat.handoff';

export interface AnnotateInput {
  url: string;
  title: string;
  snap: ElementSnapshot;
  note: string;
  /** 元素外层 HTML，已由调用方裁短。进「片段」胶囊，不进正文 */
  html?: string;
}

export interface HandoffPayload {
  body?: string;
  snippet?: string;
  files?: Array<{ filename: string; base64: string; label?: string }>;
}

function describeElement(s: ElementSnapshot): string {
  let d = s.tag;
  if (s.id) d += `#${s.id}`;
  if (s.classes?.length) d += `.${s.classes.slice(0, 3).join('.')}`;
  return d;
}

/** 输入框里留下的正文：几行事实 + 备注。备注为空就不出现「备注」行 */
export function buildAnnotationBody(i: AnnotateInput): string {
  const lines = [`【网页标记】${i.title || i.url}`, `页面：${i.url}`];
  lines.push(`元素：${describeElement(i.snap)}${i.snap.cssPath ? `　选择器：${i.snap.cssPath}` : ''}`);
  if (i.snap.text) lines.push(`文字：${i.snap.text}`);
  const note = i.note.trim();
  if (note) lines.push(`备注：${note}`);
  return lines.join('\n');
}

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * 把元素在视口里的矩形换成截图（物理像素）上的裁剪框，并夹在图内。
 * 夹完面积为 0（元素在视口外）回 null —— 调用方改用整张截图，不是报错。
 */
export function cropBox(rect: Rect, dpr: number, imgW: number, imgH: number): { sx: number; sy: number; sw: number; sh: number } | null {
  const sx = Math.max(0, Math.floor(rect.x * dpr));
  const sy = Math.max(0, Math.floor(rect.y * dpr));
  const ex = Math.min(imgW, Math.ceil((rect.x + rect.width) * dpr));
  const ey = Math.min(imgH, Math.ceil((rect.y + rect.height) * dpr));
  const sw = ex - sx;
  const sh = ey - sy;
  return sw > 0 && sh > 0 ? { sx, sy, sw, sh } : null;
}

export function buildHandoffPayload(i: AnnotateInput, screenshotBase64?: string): HandoffPayload {
  // 标记说明 + 元素 HTML 合成一份「长文本」放进对话框的长文本卡片，输入框保持为空等用户补充
  // （李博 2026-11-22：以前 body 与 snippet 各放一份，输入框里和卡片里重复，侧栏又窄）。
  const p: HandoffPayload = { snippet: i.html ? `${buildAnnotationBody(i)}\n\n${i.html}` : buildAnnotationBody(i) };
  if (screenshotBase64) {
    p.files = [{ filename: `mark-${Date.now()}.png`, base64: screenshotBase64, label: '标记截图' }];
  }
  return p;
}
