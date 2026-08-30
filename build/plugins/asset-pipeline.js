import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { compress as woff2Compress } from 'wawoff2';
import { optimize as svgoOptimize } from 'svgo';
import { walkFiles, logInfo } from '../utils.js';

const RASTER_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.avif', '.webp']);
const FONT_EXT = new Set(['.ttf', '.otf']);

// webp/avif sources under this size are already compressed and get passed through untouched
const ALREADY_COMPRESSED_EXT = new Set(['.webp', '.avif']);
const SKIP_RECOMPRESS_MAX_BYTES = 1024 * 1024;

const WEBP_QUALITY = 90;

// bump this if the conversion output changes shape, so stale cache entries don't linger
const CACHE_VERSION = `v3:sharp${sharp.versions.sharp}:q${WEBP_QUALITY}:skip${SKIP_RECOMPRESS_MAX_BYTES}`;

/**
 * Converts raster images -> webp, optimizes svg, converts ttf/otf -> woff2.
 * generateBundle handles referenced assets; closeBundle copies over anything still missing.
 */
export function assetPipelinePlugin({ srcDir, outDir, cacheDir }) {
	const imagesDir = path.join(srcDir, 'images');
	const fontsDir = path.join(srcDir, 'fonts');
	const imageCacheDir = path.join(cacheDir, 'images');
	const fontCacheDir = path.join(cacheDir, 'fonts');
	let handledImageSources = new Set();
	let handledFontSources = new Set();
	const stats = { hits: 0, misses: 0 };

	function predictImageExt(ext, size) {
		if (ext === '.svg') return '.svg';
		if (ALREADY_COMPRESSED_EXT.has(ext) && size <= SKIP_RECOMPRESS_MAX_BYTES) return ext;
		if (RASTER_EXT.has(ext)) return '.webp';
		return ext;
	}

	function predictFontExt(ext) {
		return FONT_EXT.has(ext) ? '.woff2' : ext;
	}

	async function convertImageBuffer(buffer, ext) {
		if (ext === '.svg') {
			const result = svgoOptimize(buffer.toString('utf-8'), { multipass: true });
			return { buffer: Buffer.from(result.data, 'utf-8'), ext: '.svg' };
		}
		if (ALREADY_COMPRESSED_EXT.has(ext) && buffer.length <= SKIP_RECOMPRESS_MAX_BYTES) {
			return { buffer, ext };
		}
		if (RASTER_EXT.has(ext)) {
			const webp = await sharp(buffer).webp({ quality: WEBP_QUALITY, effort: 6, smartSubsample: true }).toBuffer();
			return { buffer: webp, ext: '.webp' };
		}
		return { buffer, ext };
	}

	async function convertFontBuffer(buffer, ext) {
		if (!FONT_EXT.has(ext)) return { buffer, ext };
		const woff2 = await woff2Compress(buffer);
		return { buffer: Buffer.from(woff2), ext: '.woff2' };
	}

	async function cachedConvert(cache, absPath, ext, predictExt, converter) {
		const relPath = path.relative(srcDir, absPath);
		const stat = await fsp.stat(absPath);
		const outExt = predictExt(ext, stat.size);
		const key =
			crypto
				.createHash('sha1')
				.update(`${CACHE_VERSION}:${relPath}:${stat.size}:${stat.mtimeMs}`)
				.digest('hex') + outExt;
		const cachedPath = path.join(cache, key);

		try {
			const buffer = await fsp.readFile(cachedPath);
			stats.hits++;
			return { buffer, ext: outExt };
		} catch {}

		stats.misses++;
		const srcBuffer = await fsp.readFile(absPath);
		const result = await converter(srcBuffer, ext);
		await fsp.mkdir(cache, { recursive: true });
		await fsp.writeFile(cachedPath, result.buffer);
		return result;
	}

	async function copyRemaining(sourceDir, destDir, cache, predictExt, converter, handledSources) {
		for (const file of walkFiles(sourceDir)) {
			if (handledSources.has(path.resolve(file))) continue; // already emitted via the referenced-asset pass

			const rel = path.relative(sourceDir, file);
			const ext = path.extname(file).toLowerCase();
			const { buffer, ext: newExt } = await cachedConvert(cache, file, ext, predictExt, converter);
			const destPath = path.join(destDir, rel.slice(0, -ext.length) + newExt);

			await fsp.mkdir(path.dirname(destPath), { recursive: true });
			await fsp.writeFile(destPath, buffer);
		}
	}

	return {
		name: 'landing:asset-pipeline',
		apply: 'build',
		enforce: 'post',

		async generateBundle(_, bundle) {
			const renames = [];
			let fontRenamed = false;
			handledImageSources = new Set();
			handledFontSources = new Set();
			stats.hits = 0;
			stats.misses = 0;

			for (const fileName of Object.keys(bundle)) {
				const asset = bundle[fileName];
				if (asset.type !== 'asset') continue;
				const ext = path.extname(fileName).toLowerCase();
				const originalSources = (asset.originalFileNames ?? []).map((f) => path.resolve(srcDir, f));
				const srcAbsPath = originalSources[0];
				if (!srcAbsPath) continue;

				if (fileName.startsWith('images/') && (RASTER_EXT.has(ext) || ext === '.svg')) {
					const { buffer, ext: newExt } = await cachedConvert(imageCacheDir, srcAbsPath, ext, predictImageExt, convertImageBuffer);
					const newFileName = fileName.slice(0, -ext.length) + newExt;
					delete bundle[fileName];
					asset.fileName = newFileName;
					asset.source = buffer;
					bundle[newFileName] = asset;
					if (newFileName !== fileName) renames.push({ from: fileName, to: newFileName });
					originalSources.forEach((s) => handledImageSources.add(s));
				}

				if (fileName.startsWith('fonts/') && FONT_EXT.has(ext)) {
					const { buffer, ext: newExt } = await cachedConvert(fontCacheDir, srcAbsPath, ext, predictFontExt, convertFontBuffer);
					const newFileName = fileName.slice(0, -ext.length) + newExt;
					delete bundle[fileName];
					asset.fileName = newFileName;
					asset.source = buffer;
					bundle[newFileName] = asset;
					if (newFileName !== fileName) {
						renames.push({ from: fileName, to: newFileName });
						fontRenamed = true;
					}
					originalSources.forEach((s) => handledFontSources.add(s));
				}
			}

			if (!renames.length) return;

			for (const fileName of Object.keys(bundle)) {
				const item = bundle[fileName];
				const isChunk = item.type === 'chunk';
				const isTextAsset = item.type === 'asset' && typeof item.source === 'string';
				if (!isChunk && !isTextAsset) continue;

				let content = isChunk ? item.code : item.source;
				let changed = false;
				for (const { from, to } of renames) {
					if (content.includes(from)) {
						content = content.split(from).join(to);
						changed = true;
					}
				}
				if (isTextAsset && fontRenamed && fileName.endsWith('.css')) {
					content = content
						.replace(/format\((['"])truetype\1\)/g, "format('woff2')")
						.replace(/format\((['"])opentype\1\)/g, "format('woff2')");
					changed = true;
				}

				if (changed) {
					if (isChunk) item.code = content;
					else item.source = content;
				}
			}
		},

		async closeBundle() {
			await copyRemaining(imagesDir, path.join(outDir, 'images'), imageCacheDir, predictImageExt, convertImageBuffer, handledImageSources);
			await copyRemaining(fontsDir, path.join(outDir, 'fonts'), fontCacheDir, predictFontExt, convertFontBuffer, handledFontSources);

			if (stats.hits || stats.misses) {
				logInfo(`images/fonts: ${stats.hits} from cache, ${stats.misses} converted`);
			}
		},
	};
}
