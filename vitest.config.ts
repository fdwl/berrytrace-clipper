import { defineConfig } from 'vitest/config';

export default defineConfig({
	define: {
		DEBUG_MODE: false,
		// 构建标记由 webpack 的 DefinePlugin 算出来（见 webpack.config.js 的
		// relayBuildStamp）。测试里给一个固定值：源码里**不许写兜底表达式** ——
		// 兜底那个字面量会先出现在压缩产物里，宿主 indexOf 会切到它。
		BT_RELAY_MARK: JSON.stringify('BT-RELAY-CAPABLE:test'),
	},
	test: {
		include: ['src/**/*.test.ts'],
		globals: true,
		alias: {
			'webextension-polyfill': new URL('./src/utils/__mocks__/webextension-polyfill.ts', import.meta.url).pathname,
		},
	},
});
