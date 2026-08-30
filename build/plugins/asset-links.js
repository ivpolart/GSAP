import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as esbuild from 'esbuild';
import Handlebars from 'handlebars';
import { walkFiles, toPosix, logWarn, logError } from '../utils.js';

/**
 * Renders pages as Handlebars templates (partials registered by filename),
 * handles the "_name.css" bundled vs "name.css" standalone convention,
 * builds+injects the main.js <script> tag, and prints a few diagnostics.
 */
export function assetLinksPlugin({ srcDir, hashFilenames }) {
	const cssDir = path.join(srcDir, 'css');
	const partialsDir = path.join(srcDir, 'partials');
	const mainCss = path.join(cssDir, 'main.css');
	const mainJs = path.join(srcDir, 'js/main.js');
	let minify = true;

	function registerPartials() {
		Handlebars.partials = {};
		for (const file of walkFiles(partialsDir)) {
			if (path.extname(file) !== '.html') continue;
			const name = toPosix(path.relative(partialsDir, file)).replace(/\.html$/, '');
			Handlebars.registerPartial(name, fs.readFileSync(file, 'utf-8'));
		}
	}

	function findHtmlPages() {
		return fs
			.readdirSync(srcDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
			.map((entry) => path.join(srcDir, entry.name));
	}

	function findStandaloneCssFiles() {
		return walkFiles(cssDir).filter((file) => {
			if (path.extname(file) !== '.css') return false;
			if (path.resolve(file) === path.resolve(mainCss)) return false;
			return !path.basename(file).startsWith('_');
		});
	}

	/** All standalone css files ship flat into dist/css, named after their own basename. */
	function cssOutputName(file) {
		return path.basename(file, '.css');
	}

	function findUnderscoreCssFiles() {
		return walkFiles(cssDir).filter(
			(file) => path.extname(file) === '.css' && path.basename(file).startsWith('_')
		);
	}

	/** Resolves the @import graph starting at main.css, returns a Set of absolute file paths reached. */
	function resolveImportGraph() {
		const reached = new Set();
		if (!fs.existsSync(mainCss)) return reached;

		const importRe = /@import\s+(?:url\()?["']([^"')]+)["']\)?/g;

		function visit(filePath) {
			const resolved = path.resolve(filePath);
			if (reached.has(resolved) || !fs.existsSync(resolved)) return;
			reached.add(resolved);

			const content = fs.readFileSync(resolved, 'utf-8');
			let match;
			while ((match = importRe.exec(content))) {
				const importPath = path.resolve(path.dirname(resolved), match[1]);
				visit(importPath);
			}
		}

		visit(mainCss);
		return reached;
	}

	/** Walks a Handlebars AST, collecting {{> name}}/{{#> name}} references and {{#*inline "name"}} declarations. */
	function collectPartialRefs(node, refs, inlineNames) {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			node.forEach((child) => collectPartialRefs(child, refs, inlineNames));
			return;
		}
		if ((node.type === 'PartialStatement' || node.type === 'PartialBlockStatement') && node.name?.type === 'PathExpression') {
			if (node.name.original !== '@partial-block') refs.add(node.name.original);
		}
		if (node.type === 'DecoratorBlock' && node.path?.original === 'inline' && node.params?.[0]?.type === 'StringLiteral') {
			inlineNames.add(node.params[0].value);
		}
		for (const key of ['body', 'program', 'inverse', 'params', 'hash', 'pairs', 'value']) {
			if (node[key]) collectPartialRefs(node[key], refs, inlineNames);
		}
	}

	/** Handlebars only throws for a missing {{> name}}; a missing block form ({{#> name}}) silently no-ops. */
	function findMissingPartialRefs() {
		const registered = new Set(
			walkFiles(partialsDir)
				.filter((f) => path.extname(f) === '.html')
				.map((f) => toPosix(path.relative(partialsDir, f)).replace(/\.html$/, ''))
		);

		const filesToScan = [...findHtmlPages(), ...walkFiles(partialsDir).filter((f) => path.extname(f) === '.html')];
		const perFileRefs = [];
		const inlineNames = new Set();

		for (const file of filesToScan) {
			const refs = new Set();
			try {
				collectPartialRefs(Handlebars.parse(fs.readFileSync(file, 'utf-8')), refs, inlineNames);
			} catch {
				continue; // syntax errors surface on their own when the page actually renders
			}
			perFileRefs.push({ file, refs });
		}

		const missing = [];
		for (const { file, refs } of perFileRefs) {
			for (const name of refs) {
				if (!registered.has(name) && !inlineNames.has(name)) {
					missing.push({ file, name });
				}
			}
		}
		return missing;
	}

	function runDiagnostics() {
		if (!fs.existsSync(mainCss)) {
			logError(`src/css/main.css not found — create it as the stylesheet entry point (@import your _files there).`);
			return;
		}

		const reached = resolveImportGraph();
		for (const file of findUnderscoreCssFiles()) {
			if (!reached.has(path.resolve(file))) {
				const rel = toPosix(path.relative(srcDir, file));
				logWarn(`${rel} exists but is never @imported in main.css — its styles won't be included in the build.`);
			}
		}

		if (!fs.existsSync(mainJs)) {
			logWarn(`src/js/main.js not found — no <script> tag will be added to any page.`);
		}

		for (const { file, name } of findMissingPartialRefs()) {
			const rel = toPosix(path.relative(srcDir, file));
			logWarn(`${rel} references {{> ${name}}}, but partials/${name}.html doesn't exist.`);
		}
	}

	return {
		name: 'landing:asset-links',

		config() {
			const input = {};
			const owners = {}; // output key -> source file, to catch filename clashes

			function claim(key, file) {
				if (owners[key]) {
					logError(
						`both ${toPosix(path.relative(srcDir, owners[key]))} and ${toPosix(path.relative(srcDir, file))} would build to "${key}" — rename one of them.`
					);
					return;
				}
				owners[key] = file;
				input[key] = file;
			}

			for (const file of findHtmlPages()) {
				claim(path.basename(file, '.html'), file);
			}
			for (const file of findStandaloneCssFiles()) {
				claim(cssOutputName(file), file);
			}
			if (fs.existsSync(mainCss)) {
				claim('main.css', mainCss); // key is arbitrary — output is named from the source path
			}
			// main.js is built separately via esbuild, see generateBundle below

			return {
				build: {
					rollupOptions: { input },
				},
			};
		},

		configResolved(config) {
			minify = config.build.minify !== false;
		},

		buildStart() {
			runDiagnostics();
		},

		configureServer() {
			runDiagnostics();
		},

		transformIndexHtml: {
			order: 'pre', // run before Vite's core html transform, so it sees expanded partials

			handler(html, ctx) {
				registerPartials();
				let rendered;
				try {
					rendered = Handlebars.compile(html)({});
				} catch (err) {
					logError(`failed to build ${toPosix(path.relative(srcDir, ctx.filename))}: ${err.message}`);
					throw err;
				}

				const tags = [];
				const isDev = Boolean(ctx.server);

				if (fs.existsSync(mainCss)) {
					tags.push({
						tag: 'link',
						attrs: { rel: 'stylesheet', href: isDev ? '/css/main.css' : './css/main.css' },
						injectTo: 'head',
					});
				}

				for (const file of findStandaloneCssFiles()) {
					const name = cssOutputName(file);
					// placeholder, swapped for the real filename in generateBundle below
					tags.push({
						tag: 'link',
						attrs: { rel: 'stylesheet', href: isDev ? `/css/${name}.css` : `./css/__CSS_${name}__.css` },
						injectTo: 'head',
					});
				}

				if (isDev && fs.existsSync(mainJs)) {
					// build handles this in generateBundle instead — see below
					tags.push({
						tag: 'script',
						attrs: { src: '/js/main.js', defer: true },
						injectTo: 'head',
					});
				}

				return { html: rendered, tags };
			},
		},

		enforce: 'post', // run after Vite's html/js output is final (chunk names, hashes)
		async generateBundle(_, bundle) {
			// built with esbuild directly, forced to iife — rollup's own 'es' output wraps a
			// `module.exports =` (common in pasted UMD plugins) in an `export`, which a plain
			// (non type=module) <script> tag can't parse
			let mainJsFileName = null;
			if (fs.existsSync(mainJs)) {
				const esbuildOptions = {
					entryPoints: [mainJs],
					bundle: true,
					platform: 'browser',
					write: false,
					logOverride: { 'commonjs-variable-in-esm': 'silent' }, // false positive from "type": "module" in package.json
				};

				// esm probe build: iife silently drops top-level exports instead of erroring,
				// so this is the only way to catch a plugin shipped as an ES module with no UMD fallback
				const probe = await esbuild
					.build({ ...esbuildOptions, format: 'esm', metafile: true, logLevel: 'silent' })
					.catch(() => null);
				const exported = probe ? (Object.values(probe.metafile.outputs)[0]?.exports ?? []) : [];
				if (exported.length) {
					logWarn(
						`src/js/main.js has top-level export(s) (${exported.join(', ')}) — a plain <script> tag can't see these, they're silently dropped. If this came from a pasted plugin, use its UMD/global build instead of the ES module one, or add "window.Name = Name;" yourself at the end.`
					);
				}

				let result;
				try {
					result = await esbuild.build({ ...esbuildOptions, format: 'iife', minify, legalComments: 'none' });
				} catch (err) {
					logError(`failed to build src/js/main.js: ${err.message}`);
					throw err;
				}

				const code = result.outputFiles[0].text;
				const hash = hashFilenames ? `.${crypto.createHash('sha256').update(code).digest('hex').slice(0, 8)}` : '';
				mainJsFileName = `js/main${hash}.js`;
				this.emitFile({ type: 'asset', fileName: mainJsFileName, source: code });
			}

			const cssReplacements = findStandaloneCssFiles()
				.map((file) => {
					const asset = Object.values(bundle).find(
						(item) =>
							item.type === 'asset' &&
							(item.originalFileNames ?? []).some((f) => path.resolve(srcDir, f) === path.resolve(file))
					);
					return asset ? { from: `css/__CSS_${cssOutputName(file)}__.css`, to: asset.fileName } : null;
				})
				.filter(Boolean);

			for (const item of Object.values(bundle)) {
				if (item.type !== 'asset' || typeof item.source !== 'string' || !item.fileName.endsWith('.html')) continue;

				for (const { from, to } of cssReplacements) {
					if (item.source.includes(from)) item.source = item.source.split(from).join(to);
				}

				// crossorigin="" breaks file://, since browsers refuse CORS-mode requests on it
				if (item.source.includes(' crossorigin')) {
					item.source = item.source.replace(/\s+crossorigin(="[^"]*")?/g, '');
				}

				// spliced in after the stylesheet links so it always lands right after them
				if (mainJsFileName && item.source.includes('</head>')) {
					item.source = item.source.replace('</head>', `  <script src="./${mainJsFileName}" defer></script>\n</head>`);
				}
			}
		},
	};
}
