/** A fixed-window request counter, in process memory, no database. Per pod: with N replicas a key can
 *  make N times the limit. Ingress rate limiting and better-auth's own limiter are S2.7. */
export interface RateLimiter {
	/** Counts one request for `key`. `retryAfterSeconds` is set when the request is over the limit. */
	hit(key: string, now?: number): { allowed: boolean; retryAfterSeconds: number };
}

const SWEEP_ABOVE = 10_000;

export function createRateLimiter(options: { max: number; windowMs: number }): RateLimiter {
	const windows = new Map<string, { count: number; resetAt: number }>();

	return {
		hit(key, now = Date.now()) {
			// Keep the map bounded: dropping expired windows is lossless.
			if (windows.size > SWEEP_ABOVE) {
				for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
			}

			let w = windows.get(key);
			if (!w || w.resetAt <= now) {
				w = { count: 0, resetAt: now + options.windowMs };
				windows.set(key, w);
			}
			w.count++;
			if (w.count <= options.max) return { allowed: true, retryAfterSeconds: 0 };
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - now) / 1000))
			};
		}
	};
}
