import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchTimeoutError, fetchWithTimeout } from './fetch-timeout';

let server: Server;
let base: string;
const open = new Set<import('node:net').Socket>();

beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.url === '/hang') return; // never answers
		if (req.url === '/stall') {
			// sends headers and a first chunk, then goes silent
			res.writeHead(200, { 'content-type': 'application/json' });
			res.write('{"a":');
			return;
		}
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end('{"ok":true}');
	});
	server.on('connection', (s) => {
		open.add(s);
		s.on('close', () => open.delete(s));
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	for (const s of open) s.destroy();
	await new Promise((r) => server.close(r));
});

describe('fetchWithTimeout', () => {
	it('returns a normal response', async () => {
		const res = await fetchWithTimeout(`${base}/ok`, {}, { headersMs: 1000, totalMs: 2000 });
		expect(await res.json()).toEqual({ ok: true });
	});

	it('aborts a server that never answers, with a headers timeout', async () => {
		const started = Date.now();
		const err = await fetchWithTimeout(`${base}/hang`, {}, { headersMs: 150, totalMs: 5000 }).catch(
			(e) => e
		);
		expect(err).toBeInstanceOf(FetchTimeoutError);
		expect(err.phase).toBe('headers');
		expect(err.message).toMatch(/did not respond within/);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it('aborts a body that stalls after the headers, with the total timeout', async () => {
		const res = await fetchWithTimeout(`${base}/stall`, {}, { headersMs: 1000, totalMs: 300 });
		const err = await res.json().catch((e) => e);
		expect(err).toBeInstanceOf(FetchTimeoutError);
		expect(err.phase).toBe('total');
	});

	it('honours a caller-supplied signal as well', async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(new Error('caller gave up')), 50);
		const err = await fetchWithTimeout(
			`${base}/hang`,
			{ signal: ac.signal },
			{ headersMs: 5000, totalMs: 5000 }
		).catch((e) => e);
		expect(err.message).toBe('caller gave up');
	});
});
