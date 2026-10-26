import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit';

describe('createRateLimiter', () => {
	it('allows `max` hits per window, then refuses with a Retry-After of the time left', () => {
		const limiter = createRateLimiter({ max: 3, windowMs: 60_000 });
		for (let i = 0; i < 3; i++) expect(limiter.hit('a', 1_000).allowed).toBe(true);
		expect(limiter.hit('a', 11_000)).toEqual({ allowed: false, retryAfterSeconds: 50 });
	});

	it('counts keys separately and starts a new window after the old one ends', () => {
		const limiter = createRateLimiter({ max: 1, windowMs: 1_000 });
		expect(limiter.hit('a', 0).allowed).toBe(true);
		expect(limiter.hit('a', 10).allowed).toBe(false);
		expect(limiter.hit('b', 10).allowed).toBe(true);
		expect(limiter.hit('a', 1_000).allowed).toBe(true);
	});

	it('never suggests waiting less than one second', () => {
		const limiter = createRateLimiter({ max: 1, windowMs: 1_000 });
		limiter.hit('a', 0);
		expect(limiter.hit('a', 999).retryAfterSeconds).toBe(1);
	});
});
