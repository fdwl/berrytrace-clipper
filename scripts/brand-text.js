/**
 * 品牌文案替换：webpack.config.js 的 CopyPlugin（产物里的 _locales/html）和
 * brand-locale-loader.js（内嵌进 JS 的那份 _locales）共用这一份，两处不会各算各的。
 */
const path = require('path');
const fs = require('fs');

const customConfigPath = path.resolve(__dirname, '../custom/config.json');
const customConfig = fs.existsSync(customConfigPath) ? require(customConfigPath) : null;

function replaceInString(str, replacements) {
    if (typeof str !== 'string') return str;
    if (!replacements) return str;

    const urlPatterns = [];
    const textPatterns = [];

    for (const [from, to] of Object.entries(replacements)) {
        if (from.includes('.') || from.includes('/') || from.includes(':')) {
            urlPatterns.push([from, to]);
        } else {
            textPatterns.push([from, to]);
        }
    }

    let result = str;

    for (const [from, to] of urlPatterns) {
        if (result.includes(from)) {
            const regex = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
            result = result.replace(regex, to);
        }
    }

    for (const [from, to] of textPatterns) {
        if (from === 'Obsidian Web Clipper' || from === 'obsidian-clipper') {
            result = result.split(from).join(to);
        } else {
            const regex = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
            result = result.replace(regex, to);
        }
    }

    return result;
}

/**
 * @param absoluteFrom CopyPlugin 传进来的源文件绝对路径。**语言就是从它推出来的** ——
 *        `src/_locales/zh_CN/messages.json` ⇒ `zh_CN`。
 *
 * 为什么要按语言分：品牌名在中文里是「莓莓印记」，其它语言用 "Berrytrace"。
 * 一张通用表做不到这件事，而把译名手工写进 36 个 messages.json 又会**每次合并上游都冲突**
 * （上游一改翻译就撞车）。所以译名放我们自己的 `custom/config.json` 里，
 * 源文件保持跟上游逐字节一致。
 */
function processLocales(content, absoluteFrom) {
    if (!customConfig || !customConfig.replace) return content;
    const locale = absoluteFrom ? path.basename(path.dirname(String(absoluteFrom))) : '';
    const byLocale = (customConfig.replaceByLocale || {})[locale] || {};
    // 🔴 语言专属的必须放**后面**：对象展开时同名 key 后者覆盖前者。
    // 写反过一次（把 byLocale 放前面），结果通用表的 "Obsidian"→"Berrytrace"
    // 把中文的 "Obsidian"→"莓莓印记" 盖掉了，产物里中文界面全是 Berrytrace。
    const table = { ...customConfig.replace, ...byLocale };
    const messages = JSON.parse(content);
    const processValue = (obj) => {
        if (typeof obj === 'string') {
            return replaceInString(obj, table);
        }
        if (typeof obj === 'object' && obj !== null) {
            for (const key in obj) {
                obj[key] = processValue(obj[key]);
            }
        }
        return obj;
    };
    return JSON.stringify(processValue(messages), null, '\t');
}

module.exports = { replaceInString, processLocales };
