/** `fetch` with two limits, so no outbound call can hang a request or a worker slot:
 *  - `headersMs`: time until the response headers arrive (covers connect, TLS and a silent server),
 *  - `totalMs`: time until the whole body is read (the signal stays attached to the body, so a server
 *    that sends headers and then stalls is cut off too).
 *  Both reject with a `FetchTimeoutError`, which the ETL treats as a transient failure. Kept free of
 *  env and SvelteKit imports so it can be unit tested and bundled into the worker. */

export class FetchTimeoutError extends Error {
	constructor(
		readonly phase: 'headers' | 'total',
		readonly limitMs: number,
		readonly target: string
	) {
		super(
			phase === 'headers'
				? `${target} did not respond within ${limitMs / 1000}s`
				: `${target} did not finish sending its response within ${limitMs / 1000}s`
		);
		this.name = 'FetchTimeoutError';
	}
}

export interface FetchLimits {
	headersMs: number;
	totalMs: number;
}

export async function fetchWithTimeout(
	url: string | URL,
	init: RequestInit = {},
	limits: FetchLimits
): Promise<Response> {
	const target = new URL(url).host;
	const controller = new AbortController();
	const headersTimer = setTimeout(
		() => controller.abort(new FetchTimeoutError('headers', limits.headersMs, target)),
		limits.headersMs
	);
	const totalTimer = setTimeout(
		() => controller.abort(new FetchTimeoutError('total', limits.totalMs, target)),
		limits.totalMs
	);
	// Do not keep the process alive for a pending limit.
	totalTimer.unref();
	headersTimer.unref();

	const signal = init.signal
		? AbortSignal.any([init.signal, controller.signal])
		: controller.signal;
	try {
		const res = await fetch(url, { ...init, signal });
		clearTimeout(headersTimer);
		// The total timer keeps running while the caller reads the body; it is harmless afterwards.
		return res;
	} catch (e) {
		clearTimeout(totalTimer);
		throw controller.signal.reason instanceof FetchTimeoutError ? controller.signal.reason : e;
	} finally {
		clearTimeout(headersTimer);
	}
}
