/**
 * 把内嵌进 JS 的 `_locales/<语言>/messages.json` 也按 custom/config.json 换品牌文案。
 * 为什么需要它见 webpack.config.js 里挂它的那条规则。
 */
const { processLocales } = require('./brand-text');

module.exports = function brandLocaleLoader(source) {
  this.cacheable && this.cacheable();
  return processLocales(source, this.resourcePath);
};
