import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, createLogger } from 'vite';
import postcssCustomMedia from 'postcss-custom-media';

import { assetLinksPlugin } from './build/plugins/asset-links.js';
import { assetPipelinePlugin } from './build/plugins/asset-pipeline.js';
import { devReloadPlugin } from './build/plugins/dev-reload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, 'src');
const outDir = path.resolve(__dirname, 'dist');
const cacheDir = path.resolve(__dirname, 'node_modules/.cache/landing-build');

// Off by default so dist stays portable — opened directly via file://, predictable names.
const HASH_FILENAMES = false;
const hash = HASH_FILENAMES ? '.[hash]' : '';

// silences noise from two intentional choices, both handled correctly (see asset-links.js)
function isExpectedWarning(msg) {
	return msg.includes('can\'t be bundled without type="module" attribute') || msg.includes('__CSS_');
}

const logger = createLogger();
const rawWarn = logger.warn;
const rawWarnOnce = logger.warnOnce;
logger.warn = (msg, options) => {
	if (isExpectedWarning(msg)) return;
	rawWarn(msg, options);
};
logger.warnOnce = (msg, options) => {
	if (isExpectedWarning(msg)) return;
	rawWarnOnce(msg, options);
};

// comments never ship to dist, independent of the --minify flag
const stripCssComments = () => ({
	postcssPlugin: 'strip-css-comments',
	Comment(comment) {
		comment.remove();
	},
});
stripCssComments.postcss = true;

export default defineConfig(({ command }) => ({
	root: srcDir,
	base: './',
	publicDir: false,
	customLogger: logger,

	plugins: [
		assetLinksPlugin({ srcDir, hashFilenames: HASH_FILENAMES }),
		assetPipelinePlugin({ srcDir, outDir, cacheDir }),
		devReloadPlugin({ srcDir }),
	],

	css: {
		postcss: {
			plugins: [postcssCustomMedia(), ...(command === 'build' ? [stripCssComments()] : [])],
		},
	},

	build: {
		outDir,
		emptyOutDir: true,
		assetsInlineLimit: 0, // never inline as base64
		rollupOptions: {
			output: {
				// named from the source file itself, not rollup's [name] token (unreliable for css)
				assetFileNames: (asset) => {
					const originalSrc = asset.originalFileNames?.[0];
					const baseName = originalSrc ? path.basename(originalSrc) : (asset.names?.[0] ?? asset.name ?? '');
					const ext = path.extname(baseName).toLowerCase();
					const stem = path.basename(baseName, ext);
					if (['.woff2', '.woff', '.ttf', '.otf'].includes(ext)) return `fonts/${stem}${hash}${ext}`;
					if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico', '.bmp', '.tiff'].includes(ext)) {
						return `images/${stem}${hash}${ext}`;
					}
					if (ext === '.css') return `css/${stem}${hash}${ext}`;
					return `assets/${stem}${hash}${ext}`;
				},
			},
		},
	},

	server: {
		open: true,
		host: true,
	},
}));
