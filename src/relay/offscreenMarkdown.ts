/**
 * @module OffscreenMarkdown
 * ─────────────────────────────────────────────────────────────────────────────
 * 一张**看不见的网页**，专门用来把 HTML 转成 Markdown。
 *
 * ── 为什么非要多这么一张页面 ────────────────────────────────────────────────
 * 🔴 **MV3 的 service worker 里没有 DOM**，而 `createMarkdownContent()` 底下是
 * turndown，它要 `document` / `DOMParser`。在 worker 里直接调它**不报错**，
 * 只会吐出一句
 *   `Partial conversion completed with errors. Original HTML: …`
 * —— 一段看着像 Markdown 的东西，其实是原样的 HTML。**这是静默降级，不是异常**，
 * 0828 实测就是这么被骗了一轮：判据「markdown.length > 50」照样绿。
 *
 * ⇒ `chrome.offscreen` 是 MV3 官方给的解法：开一张不显示的页面，它有完整 DOM。
 *   开一次一直用，比每次往目标页里注一个几百 KB 的转换器轻，
 *   而且**不碰目标页面** —— 这一点对档 3（不让第三方发现）尤其要紧。
 *
 * ── 为什么不改 `src/content.ts` ─────────────────────────────────────────────
 * 那是上游 obsidian 的文件，里面已经有 `copyMarkdownToClipboard` /
 * `saveMarkdownToFile` 两处在页面里算 markdown —— 但它们都**不把结果回给调用方**。
 * 加一个 action 是两行的事，代价是每次合并上游都多一个冲突点
 * （李博 0826 明确要求品牌化/接线一律做成不碰上游文件的形态）。
 *
 * ⚠️ `chrome.runtime.sendMessage` 是**广播**：service worker 自己的监听器也会收到。
 *    所以消息必须带 `target: 'bt-offscreen'`，两边各自按它过滤。这是官方文档的做法，
 *    不是我们的偏好 —— 少了它，两边会互相吃掉对方的消息，表现是「偶尔没有回音」。
 */

import { createMarkdownContent } from 'defuddle/full';

type Req = { target?: string; action?: string; html?: string; url?: string };

chrome.runtime.onMessage.addListener((req: Req, _sender, sendResponse) => {
  if (req?.target !== 'bt-offscreen') return;
  if (req.action !== 'html2md') return;
  try {
    const md = createMarkdownContent(req.html ?? '', req.url ?? '');
    sendResponse({ ok: true, markdown: md });
  } catch (e) {
    sendResponse({ ok: false, error: String((e as Error)?.message ?? e) });
  }
  return true;
});
