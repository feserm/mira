// Runs svelte-check and fails only on diagnostics in our own files.
//
// @nfdi4plants/arctrl's type declarations pull in the .ts *sources* of @fable-org/fable-library-ts,
// which svelte-check type-checks under our `verbatimModuleSyntax` and rejects (128 errors, none in
// this repo). Neither skipLibCheck nor tsconfig `exclude` applies to files reached through imports,
// and svelte-check's `--ignore` only works with `--no-tsconfig`. Remove this wrapper once the
// dependency stops shipping .ts sources.
import { spawnSync } from 'node:child_process';

const sync = spawnSync('pnpm', ['exec', 'svelte-kit', 'sync'], { stdio: 'inherit' });
if (sync.status !== 0) process.exit(sync.status ?? 1);

const result = spawnSync(
	'pnpm',
	['exec', 'svelte-check', '--tsconfig', './tsconfig.json', '--output', 'machine'],
	{ encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
);
if (result.error) throw result.error;

const lines = result.stdout.split('\n');
const own = lines.filter((line) => /^\d+ (ERROR|WARNING) /.test(line));
const thirdParty = own.filter((line) => line.includes('"node_modules/'));
const ours = own.filter((line) => !line.includes('"node_modules/'));

for (const line of ours) console.error(line);
const errors = ours.filter((line) => / ERROR /.test(line)).length;
console.log(
	`svelte-check: ${errors} error(s) in project files, ${thirdParty.length} ignored in node_modules`
);
if (result.status !== 0 && own.length === 0) {
	// svelte-check itself failed (crash, bad args): do not report that as a pass
	console.error(result.stdout, result.stderr);
	process.exit(result.status ?? 1);
}
process.exit(errors > 0 ? 1 : 0);
