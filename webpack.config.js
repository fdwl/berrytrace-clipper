const path = require('path');
const fs = require('fs');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const ZipPlugin = require('zip-webpack-plugin');
const package = require('./package.json');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');

const customConfigPath = path.resolve(__dirname, 'custom/config.json');
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

function processManifest(content) {
    if (!customConfig) return content;
    const manifest = JSON.parse(content);
    if (customConfig.name) manifest.name = customConfig.name;
    if (customConfig.description) manifest.description = customConfig.description;
    if (customConfig.homepage) manifest.homepage_url = customConfig.homepage;
    return JSON.stringify(manifest, null, '\t');
}

function getCustomIconsPatterns() {
    if (!fs.existsSync(path.resolve(__dirname, 'custom'))) return [];
    const customIconsDir = path.resolve(__dirname, 'custom');
    const files = fs.readdirSync(customIconsDir).filter(f => f.startsWith('logo-') && f.endsWith('.png'));
    const sizeMap = {
        'logo-16.png': 'icon16.png',
        'logo-32.png': 'icon32.png',
        'logo-48.png': 'icon48.png',
        'logo-64.png': 'icon64.png',
        'logo-128.png': 'icon128.png',
        'logo-150.png': 'icon150.png',
        'logo-180.png': 'icon180.png',
        'logo-192.png': 'icon192.png',
        'logo-256.png': 'icon256.png',
        'logo-512.png': 'icon512.png',
        'logo-1024.png': 'icon1024.png'
    };
    return files.map(file => ({
        from: path.join('custom', file),
        to: path.join('icons', sizeMap[file] || file.replace('logo-', 'icon')),
        noErrorOnMissing: false
    }));
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

/**
 * 🔴 **CopyPlugin 的 transform 拿到的 `content` 是 Buffer，不是 string。**
 *
 * 踩过（0826 实测）：这里原本直接把 content 丢给 replaceInString，而那个函数
 * 第一行就是 `if (typeof str !== 'string') return str` ⇒ **原样返回、一个字都没替换、
 * 还不报错**。表现是产物里 popup.html / settings.html 满是 "Obsidian Web Clipper"，
 * 而 manifest 和 _locales 却是对的 —— 因为那两个走 JSON.parse，会先隐式 toString。
 *
 * 这是个「静默失效」：构建绿、产物在、就是没替换。改这两个函数时别把 toString 去掉。
 */
function processHtml(content) {
    if (!customConfig || !customConfig.replace) return content;
    return replaceInString(content.toString('utf8'), customConfig.replace);
}

function processCode(content) {
    if (!customConfig || !customConfig.replace) return content;
    return replaceInString(content.toString('utf8'), customConfig.replace);
}

// Remove .DS_Store files
function removeDSStore(dir) {
	const files = fs.readdirSync(dir);
	files.forEach(file => {
		const filePath = path.join(dir, file);
		if (fs.statSync(filePath).isDirectory()) {
			removeDSStore(filePath);
		} else if (file === '.DS_Store') {
			fs.unlinkSync(filePath);
		}
	});
}

module.exports = (env, argv) => {
	const isFirefox = env.BROWSER === 'firefox';
	const isSafari = env.BROWSER === 'safari';
	const isProduction = argv.mode === 'production';

	const getOutputDir = () => {
		if (isProduction) {
			return isFirefox ? 'dist_firefox' : (isSafari ? 'dist_safari' : 'dist');
		} else {
			return isFirefox ? 'dev_firefox' : (isSafari ? 'dev_safari' : 'dev');
		}
	};

	const outputDir = getOutputDir();
	const browserName = isFirefox ? 'firefox' : (isSafari ? 'safari' : 'chrome');

	const mainConfig = {
		mode: argv.mode,
		entry: {
			popup: './src/core/popup.ts',
			settings: './src/core/settings.ts',
			highlights: './src/core/highlights.ts',
			'reader-page': './src/core/reader-view.ts',
			content: './src/content.ts',
			// 🔴 指向**我们自己的入口**，不是上游那个 src/background.ts。
			// 那个文件保持跟上游一字不差，接线放在 relay/background-entry.ts 里 ——
			// 否则每次合并 obsidian 上游都在一个 1100 行的高频文件上打架，
			// 而且 0826 已经踩过一次：源文件被还原时把接线一起还原掉了，零报错。
			background: './src/relay/background-entry.ts',
			style: './src/style.scss',
			highlighter: './src/highlighter.scss',
			reader: './src/reader.scss',
			'reader-script': './src/reader-script.ts',
			// 自动化配对页的 content script（只在 127.0.0.1 上跑，见 manifest）
			'relay-pair': './src/relay/pairContentScript.ts',
			// 看不见的转换页：HTML → Markdown。**service worker 里没有 DOM**，
			// turndown 在那儿会静默降级成「原样返回 HTML」——详见该文件的文件头。
			offscreen: './src/relay/offscreenMarkdown.ts',
			// 首次安装弹的欢迎页。脚本和样式各一个 entry：
			// 样式不 @import 进上游的 src/style.scss，免得每次合并上游都在那个文件上打架。
			// （`welcome-style` 会顺带产出一个空的 welcome-style.js，跟 style.js /
			//   highlighter.js / reader.js 一样，是这个仓一直以来的形态，不是漏了什么。）
			welcome: './src/welcome/welcomePage.ts',
			'welcome-style': './src/welcome/welcome.scss'
		},
		output: {
			path: path.resolve(__dirname, outputDir),
			filename: '[name].js',
			module: false,
		},
		// BT_LOWMEM=1 时连 source-map 一起关掉：它和下面的 terser 并行是内存大头，
		// 在小内存机器上构建会被 OOM kill（exit 137，看着像构建失败，其实是被杀了）。
		devtool: isProduction || process.env.BT_LOWMEM ? false : 'source-map',
		optimization: {
			minimize: true,
			minimizer: [
				new TerserPlugin({
					/**
					 * 🔴 默认并行度是「CPU 核数」，每个 worker 吃几百 MB。
					 * 8 核机器上就是 7 个 worker 同时跑 ⇒ 11G 内存的机器上
					 * `npm run build:chrome` 会被 OOM kill，**development 模式也一样**
					 * （minimize 在上面是无条件 true 的，不分 dev/prod）。
					 * 小内存机器上：`BT_LOWMEM=1 npm run build:chrome`
					 */
					parallel: process.env.BT_LOWMEM ? 1 : true,
					terserOptions: {
						mangle: false,
						compress: {
							defaults: true,
							global_defs: {
								DEBUG_MODE: !isProduction
							},
							unused: true,
							dead_code: true,
							passes: 2,
							ecma: 2020,
							module: false
						},
						format: {
							ascii_only: true,
							comments: false,
							ecma: 2020
						},
						module: false,
						toplevel: true,
						keep_classnames: true,
						keep_fnames: true
					},
					extractComments: false
				})
			],
			moduleIds: 'named',
			chunkIds: 'named'
		},
		experiments: {
			outputModule: false,
		},
		resolve: {
			extensions: ['.ts', '.js'],
			alias: {
				'./utils/browser-polyfill': path.resolve(__dirname, 'node_modules/webextension-polyfill/dist/browser-polyfill.min.js'),
				'../utils/browser-polyfill': path.resolve(__dirname, 'node_modules/webextension-polyfill/dist/browser-polyfill.min.js')
			}
		},
		module: {
			rules: [
				{
					test: /\.tsx?$/,
					// loader 从**右往左**执行：先 brand-replace 改字面量，再交给 ts-loader 编译。
					// 这样源文件在磁盘上一个字都不动 —— 合并 obsidian 上游时不会冲突。
					use: [
						{
							loader: 'ts-loader',
							options: {
								compilerOptions: {
									module: 'ES2020'
								}
							}
						},
						path.resolve(__dirname, 'scripts/brand-replace-loader.js')
					],
					exclude: /node_modules/,
				},
				{
					test: /\.scss$/,
					use: [
						MiniCssExtractPlugin.loader,
						{
							loader: 'css-loader',
							options: {
								sourceMap: !isProduction
							}
						},
						{
							loader: 'sass-loader',
							options: {
								sourceMap: !isProduction
							}
						}
					]
				}
			]
		},
		plugins: [
			new CopyPlugin({
				patterns: [
					{ 
						from: isFirefox ? "src/manifest.firefox.json" : 
							  (isSafari ? "src/manifest.safari.json" : "src/manifest.chrome.json"), 
						to: "manifest.json",
						transform: processManifest
					},
					{ from: "src/popup.html", to: "popup.html", transform: processHtml },
					{ from: "src/side-panel.html", to: "side-panel.html", transform: processHtml },
					{ from: "src/settings.html", to: "settings.html", transform: processHtml },
					{ from: "src/highlights.html", to: "highlights.html", transform: processHtml },
					{ from: "src/reader.html", to: "reader.html", transform: processHtml },
					{ from: "src/welcome.html", to: "welcome.html", transform: processHtml },
					{ from: "src/relay/offscreen.html", to: "offscreen.html", transform: processHtml },
					{ from: "src/icons", to: "icons", noErrorOnMissing: true },
					...getCustomIconsPatterns(),
					{ from: "node_modules/webextension-polyfill/dist/browser-polyfill.min.js", to: "browser-polyfill.min.js" },
					{ from: "src/flatten-shadow-dom.js", to: "flatten-shadow-dom.js", transform: processCode },
					{
						from: 'src/_locales',
						to: '_locales',
						transform: processLocales
					}
				],
			}),
			new MiniCssExtractPlugin({
				filename: '[name].css'
			}),
			{
				apply: (compiler) => {
					compiler.hooks.afterEmit.tap('RemoveDSStore', (compilation) => {
						removeDSStore(path.resolve(__dirname, outputDir));
					});
				}
			},
			new webpack.DefinePlugin({
				'process.env.NODE_ENV': JSON.stringify(argv.mode),
				'DEBUG_MODE': JSON.stringify(!isProduction)
			}),
			...(isProduction ? [
				new ZipPlugin({
					path: path.resolve(__dirname, 'builds'),
					filename: `obsidian-web-clipper-${package.version}-${browserName}.zip`,
				})
			] : [])
		]
	};

	return [mainConfig];
};
