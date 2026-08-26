/**
 * 品牌替换 webpack loader。
 *
 * ── 它取代了什么，为什么 ─────────────────────────────────────────────────────
 * 原来这件事由 `scripts/patch-sources.js` 干：构建前**就地改写 4 个 .ts 源文件**，
 * 把 `obsidian://` 换成 `berrytrace://` 之类。
 *
 * 🔴 那个做法有个长期代价：**我们要一直合并 obsidian 上游**，而被改写过的源文件
 * 每次都可能跟上游打架 —— 而且它改完不还原的话，`git status` 是脏的，
 * 一不留神就把「替换后的源码」提交进去，从此每次合并都冲突。
 *
 * ⇒ 改成 loader：替换发生在**构建管线里**，磁盘上的源文件**一个字都不动**，
 *   跟上游保持逐字节一致。要改品牌就改 `custom/config.json`，那是我们自己的文件，
 *   上游没有，永远不会冲突。
 *
 * ── 跟 webpack.config.js 里那几个 process* 是一回事 ─────────────────────────
 * `processHtml` / `processLocales` / `processManifest` 对**静态资源**做同样的事。
 * 这个 loader 补的是 **TS/JS 源码**那一半。两边共用 `custom/config.json` 的映射表。
 *
 * ⚠️ 只替换 `codeReplace` 那一小张表（协议头、域名），**不用 `replace` 那张大表** ——
 * 大表里有 "Obsidian" → "Berrytrace" 这种，套到代码上会把变量名、message key
 * （`addToObsidian`）、CSS 类名（`.obsidian-reader-active`）一起改掉，
 * 而那些是**标识符不是文案**：改了就要求所有引用点同步改，改漏一处就是运行期静默失效。
 */

const path = require('path');
const fs = require('fs');

const customConfigPath = path.resolve(__dirname, '../custom/config.json');
const customConfig = fs.existsSync(customConfigPath) ? require(customConfigPath) : null;

module.exports = function brandReplaceLoader(source) {
  this.cacheable && this.cacheable();
  const map = customConfig && customConfig.codeReplace;
  if (!map) return source;
  let result = source;
  for (const [from, to] of Object.entries(map)) {
    // split/join 而不是正则：这些串里带 `://` 和 `.`，转义起来容易出错，
    // 而我们要的本来就是「字面量整体替换」。
    if (result.includes(from)) result = result.split(from).join(to);
  }
  return result;
};
