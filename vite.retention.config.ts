import path from 'node:path';
import { defineConfig } from 'vite';

// Bundles scripts/retention.ts (with drizzle-orm and postgres inlined) into build-retention/retention.js,
// so the retention CronJob runs from the same image without a database client of its own. It imports
// `$lib/server/db/retention` and `$lib/server/log` only: no SvelteKit module and no env module.
const root = import.meta.dirname;

export default defineConfig({
	resolve: { alias: { $lib: path.resolve(root, 'src/lib') } },
	ssr: { noExternal: true },
	build: {
		ssr: 'scripts/retention.ts',
		outDir: 'build-retention',
		emptyOutDir: true,
		target: 'node22',
		rollupOptions: { output: { entryFileNames: 'retention.js', format: 'esm' } }
	}
});
