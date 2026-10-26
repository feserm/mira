import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('static/robots.txt', () => {
	const lines = readFileSync('static/robots.txt', 'utf8')
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith('#'));

	it('keeps every crawler out of the whole site: pages, /arcs and the BrAPI endpoints alike', () => {
		expect(lines).toEqual(['User-agent: *', 'Disallow: /']);
	});
});
