/** Waits for a condition instead of sleeping a fixed time; fails with `what` after `timeoutMs`. */
export async function waitFor(
	check: () => boolean | Promise<boolean>,
	what: string,
	timeoutMs = 5000
): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
}
