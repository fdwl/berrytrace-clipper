/**
 * 侧栏页收到 window 消息时，只认「来自我们嵌的那个对话页 iframe」的：来源地址与窗口对象都要对上。
 * 否则同一扩展页里别的来源也能触发标记。失效条件：侧栏不再嵌 iframe。
 */
export function isFromPanelFrame(ev: { origin: string; source: unknown }, expectOrigin: string, frameWindow: unknown): boolean {
  return !!expectOrigin && !!frameWindow && ev.origin === expectOrigin && ev.source === frameWindow;
}
