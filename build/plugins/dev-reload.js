import path from 'node:path';

/**
 * main.js and images/fonts/partials aren't part of Vite's module graph, so its
 * default HMR never sees them. CSS is left alone (Vite hot-updates it natively);
 * everything else triggers a full reload so every save is reflected.
 */
export function devReloadPlugin({ srcDir }) {
	const watchDirs = ['partials', 'js', 'images', 'fonts'].map((d) => path.join(srcDir, d) + path.sep);

	return {
		name: 'landing:dev-reload',
		apply: 'serve',

		configureServer(server) {
			server.watcher.add([
				path.join(srcDir, 'partials'),
				path.join(srcDir, 'js'),
				path.join(srcDir, 'images'),
				path.join(srcDir, 'fonts'),
			]);
		},

		handleHotUpdate(ctx) {
			if (ctx.file.endsWith('.css')) return;

			const isHtml = ctx.file.endsWith('.html');
			const inWatchedDir = watchDirs.some((dir) => ctx.file.startsWith(dir));

			if (isHtml || inWatchedDir) {
				ctx.server.ws.send({ type: 'full-reload', path: '*' });
				return [];
			}
		},
	};
}
