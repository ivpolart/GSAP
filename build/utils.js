import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';

export const LOG_PREFIX = pc.cyan('[landing-build]');

export function logWarn(message) {
	console.warn(`${LOG_PREFIX} ${pc.yellow('warning')}: ${message}`);
}

export function logError(message) {
	console.error(`${LOG_PREFIX} ${pc.red('error')}: ${message}`);
}

export function logInfo(message) {
	console.log(`${LOG_PREFIX} ${message}`);
}

/** Recursively lists absolute file paths under `dir` (empty array if it doesn't exist). */
export function walkFiles(dir) {
	const results = [];
	if (!fs.existsSync(dir)) return results;

	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...walkFiles(fullPath));
		} else if (entry.isFile()) {
			results.push(fullPath);
		}
	}
	return results;
}

export function toPosix(p) {
	return p.split(path.sep).join('/');
}
