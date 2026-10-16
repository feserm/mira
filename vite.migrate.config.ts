import { defineConfig } from 'vite';

// Bundles scripts/migrate.ts (with drizzle-orm and postgres inlined) into one file, so the
// runtime image needs neither drizzle-kit nor those packages installed.
export default defineConfig({
	ssr: { noExternal: true },
	build: {
		ssr: 'scripts/migrate.ts',
		outDir: 'build-migrate',
		emptyOutDir: true,
		target: 'node22',
		rollupOptions: { output: { entryFileNames: 'migrate.js', format: 'esm' } }
	}
});
