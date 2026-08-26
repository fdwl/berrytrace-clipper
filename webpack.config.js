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

function processLocales(content) {
    if (!customConfig || !customConfig.replace) return content;
    const messages = JSON.parse(content);
    const processValue = (obj) => {
        if (typeof obj === 'string') {
            return replaceInString(obj, customConfig.replace);
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

function processHtml(content) {
    if (!customConfig || !customConfig.replace) return content;
    return replaceInString(content, customConfig.replace);
}

function processCode(content) {
    if (!customConfig || !customConfig.replace) return content;
    return replaceInString(content, customConfig.replace);
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
			background: './src/background.ts',
			style: './src/style.scss',
			highlighter: './src/highlighter.scss',
			reader: './src/reader.scss',
			'reader-script': './src/reader-script.ts',
			// 自动化配对页的 content script（只在 127.0.0.1 上跑，见 manifest）
			'relay-pair': './src/relay/pairContentScript.ts'
		},
		output: {
			path: path.resolve(__dirname, outputDir),
			filename: '[name].js',
			module: false,
		},
		devtool: isProduction ? false : 'source-map',
		optimization: {
			minimize: true,
			minimizer: [
				new TerserPlugin({
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
					use: [
						{
							loader: 'ts-loader',
							options: {
								compilerOptions: {
									module: 'ES2020'
								}
							}
						}
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
