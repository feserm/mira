import path from 'node:path';
import { defineConfig } from 'vite';

// Bundles scripts/worker.ts into build-worker/worker.js. Unlike the migration runner, the worker
// imports app code ($lib) that reads SvelteKit's `$env/dynamic/private` and `$app/environment`; those
// two are aliased to plain-Node shims, so no SvelteKit runtime is needed. Everything is inlined except
// @nfdi4plants/arctrl, which (as for the app, see docs/docker.md) is installed in the image.
const root = import.meta.dirname;

export default defineConfig({
	resolve: {
		alias: {
			$lib: path.resolve(root, 'src/lib'),
			'$env/dynamic/private': path.resolve(root, 'scripts/shims/env-private.ts'),
			'$app/environment': path.resolve(root, 'scripts/shims/app-environment.ts')
		}
	},
	ssr: { noExternal: true },
	build: {
		ssr: 'scripts/worker.ts',
		outDir: 'build-worker',
		emptyOutDir: true,
		target: 'node22',
		rollupOptions: {
			external: ['@nfdi4plants/arctrl'],
			output: { entryFileNames: 'worker.js', format: 'esm', inlineDynamicImports: true }
		}
	}
});
