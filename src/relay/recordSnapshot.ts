/**
 * 录制 · 页面这一侧的**探测**
 *
 * ── 这个文件只做一件事：把一个 DOM 元素的**结构事实**抄下来 ────────────────
 * 它**不排候选、不挑哪条更稳、不判该不该脱敏**。那些全在宿主仓
 * （berrytrace_app 的 `src/views/recording/web-capture.ts`），理由写在那个文件头：
 * 判定放在这边的话，它跟着插件走 —— 宿主仓测不到、两边早晚分叉，
 * 而且改一条判据就要重新发一次插件。
 *
 * 所以这里出现的每一行都应该能归到这两类里的一类：
 *   · 走 DOM 拿一个属性；
 *   · **数一数**这条事实在这一页里匹配几个元素。
 * 数数只有页面干得了 —— 宿主没有这棵 DOM。
 *
 * ── 唯一的例外，而且是有意的 ──────────────────────────────────────────────
 * 🔴 密码框**的值根本不读**。这一条不能推到宿主去判：
 * "读进来再决定不记"和"根本没读"在出事时是两件事，而"读"发生在这里。
 * 宿主那边还会用完整规则再判一次（autocomplete、name 里带 password/验证码 等等）。
 * 两份不一致时的降级方向是**单向安全**的：
 *   · 这边漏读 ⇒ 宿主拿不到值，最多少记一个值；
 *   · 这边多读 ⇒ 宿主照样会脱敏，值不会进产物。
 * 所以这份复制品是**安全下限**，不是判据的第二个权威。
 */

/** 与宿主 `web-capture.ts` 的同名接口逐字段对应。**加字段安全，改含义不安全。** */
export interface ElementSnapshot {
  tag: string;
  id?: string;
  classes?: string[];
  testId?: { attr: string; value: string };
  ariaLabel?: string;
  role?: string;
  text?: string;
  inputType?: string;
  inputName?: string;
  autocomplete?: string;
  placeholder?: string;
  cssPath?: string;
  xpath?: string;
  counts?: { id?: number; testId?: number; ariaLabel?: number; text?: number };
  framePath?: string[];
}

/** 与宿主 `web-capture.ts` 的 WebInteraction 逐字段对应。 */
export interface WebInteraction {
  kind: 'click' | 'input' | 'scroll' | 'navigate';
  at: number;
  url?: string;
  title?: string;
  target?: ElementSnapshot;
  value?: string;
  double?: boolean;
  dx?: number;
  dy?: number;
  navKind?: 'load' | 'push_state' | 'back' | 'forward' | 'reload';
}

/** 站点作者故意留的测试锚点，按这个顺序找第一个有值的 */
const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

/** 可见文字裁到这个长度。再长的对定位没用，只会把上报撑大 */
const MAX_TEXT = 80;

/**
 * 数一条选择器在这一页里匹配几个。
 *
 * 🔴 数不出来（选择器语法非法、被站点的 CSP 挡住）时回 **0**，不回 1 ——
 * 宿主那边只有恰好 1 才当唯一。回 1 等于替它撒了个谎。
 */
function countMatches(sel: string): number {
  try {
    return document.querySelectorAll(sel).length;
  } catch {
    return 0;
  }
}

function cssEscape(v: string): string {
  const fn = (window as unknown as { CSS?: { escape?: (s: string) => string } }).CSS?.escape;
  if (typeof fn === 'function') return fn(v);
  // 老浏览器没有 CSS.escape。只转义我们会拼进去的那几个字符，够用
  return v.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

function quoteAttr(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 压掉连续空白并裁短。原样带换行的文字当选择器一定匹配不上 */
function tidyText(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.slice(0, MAX_TEXT);
}

/**
 * 可访问名。按浏览器算可访问名的大致次序取，**取到第一个就停**。
 *
 * ⚠️ 这不是完整的 accname 算法（那套很长）。取不到就没有这一格，
 * 宿主那边会退到下一档候选 —— 比给一个半对的名字好。
 */
function accessibleName(el: Element): string | undefined {
  const direct = el.getAttribute('aria-label');
  if (direct && direct.trim()) return direct.trim();

  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const parts = by.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const t = tidyText(parts);
    if (t) return t;
  }

  if (el.id) {
    const lab = document.querySelector(`label[for=${quoteAttr(el.id)}]`);
    const t = tidyText(lab?.textContent);
    if (t) return t;
  }

  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();

  if (el.tagName === 'IMG') {
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
  }
  return undefined;
}

/**
 * 从根拼下来的 CSS 路径。每层用 `tag:nth-of-type(n)`，**按构造唯一**。
 *
 * 🔴 中途撞到一个唯一的 id 就**在那儿收尾**：路径越短越经得起改版，
 * 而且 id 那一段本身就是个锚。
 */
function cssPathOf(el: Element): string | undefined {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 20) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') {
      parts.unshift(tag);
      break;
    }
    if (node.id && countMatches(`#${cssEscape(node.id)}`) === 1) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    let n = 1;
    for (const sib of Array.from(parent.children)) {
      if (sib === node) break;
      if (sib.tagName === node.tagName) n += 1;
    }
    parts.unshift(`${tag}:nth-of-type(${n})`);
    node = parent;
    depth += 1;
  }
  const path = parts.join(' > ');
  // 拼出来的路径自己验一次：不唯一就不给。给一条指到三个元素的"精确路径"
  // 比不给危险得多 —— 它看起来是最后一档兜底，下游会信它
  return path && countMatches(path) === 1 ? path : undefined;
}

/** 最后一档。形状与 cssPath 同理，只是换成 XPath 的写法 */
function xpathOf(el: Element): string | undefined {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 20) {
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(`/${tag}`);
      break;
    }
    let n = 1;
    for (const sib of Array.from(parent.children)) {
      if (sib === node) break;
      if (sib.tagName === node.tagName) n += 1;
    }
    parts.unshift(`/${tag}[${n}]`);
    node = parent;
    depth += 1;
  }
  const p = parts.join('');
  return p || undefined;
}

/** 同一个标签里，正文与它一字不差的有几个。数它是为了判"这段文字能不能当定位" */
function countSameText(el: Element, text: string): number {
  let n = 0;
  const all = document.getElementsByTagName(el.tagName);
  for (let i = 0; i < all.length && n < 3; i += 1) {
    if (tidyText(all[i].textContent) === text) n += 1;
  }
  return n;
}

/**
 * 抄下一个元素的结构事实。
 *
 * ⚠️ 这个函数会跑 `querySelectorAll` 几次。它只在**用户真的点了/输入完**
 * 的那一刻跑，不在 mousemove 上跑 —— 挂在移动上会让别人的网站变卡，
 * 而"录制让我的电脑变慢"是这条功能被关掉的最快理由。
 */
export function snapshotElement(el: Element): ElementSnapshot {
  const tag = el.tagName.toLowerCase();
  const snap: ElementSnapshot = { tag };
  const counts: NonNullable<ElementSnapshot['counts']> = {};

  if (el.id) {
    snap.id = el.id;
    counts.id = countMatches(`#${cssEscape(el.id)}`);
  }

  const cls = Array.from(el.classList).slice(0, 8);
  if (cls.length) snap.classes = cls;

  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v && v.trim()) {
      snap.testId = { attr, value: v };
      counts.testId = countMatches(`[${attr}=${quoteAttr(v)}]`);
      break;
    }
  }

  const name = accessibleName(el);
  if (name) {
    snap.ariaLabel = name;
    counts.ariaLabel = countMatches(`[aria-label=${quoteAttr(name)}]`);
  }

  const role = el.getAttribute('role');
  if (role) snap.role = role;

  const text = tidyText(el.textContent);
  if (text) {
    snap.text = text;
    counts.text = countSameText(el, text);
  }

  const input = el as HTMLInputElement;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (input.type) snap.inputType = input.type;
    if (input.name) snap.inputName = input.name;
    if (input.autocomplete) snap.autocomplete = input.autocomplete;
    if (input.placeholder) snap.placeholder = input.placeholder;
  }

  const css = cssPathOf(el);
  if (css) snap.cssPath = css;
  const xp = xpathOf(el);
  if (xp) snap.xpath = xp;

  snap.counts = counts;
  return snap;
}

/**
 * 这个控件的值**能不能读**。
 *
 * 🔴 见文件头那条：这是安全下限的复制品，不是判据的第二个权威。
 * 密码框一律不读；宿主那边还会按 autocomplete / name / placeholder
 * 再判一次，判到就脱敏。
 */
export function mayReadValue(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;
  const type = ((el as HTMLInputElement).type || '').toLowerCase();
  if (type === 'password') return false;
  return true;
}
