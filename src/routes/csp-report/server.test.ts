import { beforeEach, describe, expect, it } from 'vitest';
import { cspViolations, registry } from '$lib/server/metrics';
import { setLogSink } from '$lib/server/log';
import { POST } from './+server';

const lines: string[] = [];
beforeEach(() => {
	lines.length = 0;
	setLogSink((l) => lines.push(l));
});

const post = (body: string, headers: Record<string, string> = {}) =>
	POST({
		request: new Request('http://localhost/csp-report', { method: 'POST', body, headers })
	} as never);
const count = (directive: string, disposition: string) =>
	cspViolations.value({ directive, disposition });

describe('POST /csp-report', () => {
	it('counts a legacy application/csp-report body by directive and disposition', async () => {
		const before = count('script-src-elem', 'report');
		const res = await post(
			JSON.stringify({
				'csp-report': {
					'document-uri': 'https://mira.test/arcs?token=secretquery',
					'blocked-uri': 'inline',
					'effective-directive': 'script-src-elem',
					disposition: 'report'
				}
			}),
			{ 'content-type': 'application/csp-report' }
		);
		expect(res.status).toBe(204);
		expect(count('script-src-elem', 'report')).toBe(before + 1);
	});

	it('counts a Reporting API body (application/reports+json)', async () => {
		const before = count('img-src', 'enforce');
		const res = await post(
			JSON.stringify([
				{
					type: 'csp-violation',
					url: 'https://mira.test/arcs?x=1',
					body: {
						effectiveDirective: 'img-src',
						disposition: 'enforce',
						blockedURL: 'https://evil.test'
					}
				}
			]),
			{ 'content-type': 'application/reports+json' }
		);
		expect(res.status).toBe(204);
		expect(count('img-src', 'enforce')).toBe(before + 1);
	});

	it('keeps only the directive name when the browser sends the whole violated directive', async () => {
		const before = count('style-src', 'unknown');
		await post(JSON.stringify({ 'csp-report': { 'violated-directive': "style-src 'self'" } }));
		expect(count('style-src', 'unknown')).toBe(before + 1);
	});

	it('never lets a reporter invent a label value', async () => {
		await post(
			JSON.stringify({
				'csp-report': { 'effective-directive': 'evil"directive{x}', disposition: 'whatever' }
			})
		);
		const output = await registry.render();
		expect(output).not.toContain('evil');
		expect(output).not.toContain('whatever');
		expect(count('other', 'unknown')).toBeGreaterThan(0);
	});

	it('logs nothing and the metrics hold nothing from the report (url, query, blocked uri)', async () => {
		await post(
			JSON.stringify({
				'csp-report': {
					'document-uri': 'https://mira.test/arcs/42?token=secretquery',
					'blocked-uri': 'https://tracker.test/pixel?id=secretblocked',
					'effective-directive': 'img-src',
					'original-policy': "default-src 'none'; script-src 'nonce-secretnonce'"
				}
			})
		);
		const output = lines.join('\n') + (await registry.render());
		expect(lines).toHaveLength(0);
		for (const secret of [
			'secretquery',
			'secretblocked',
			'secretnonce',
			'tracker.test',
			'/arcs/42'
		])
			expect(output, secret).not.toContain(secret);
	});

	it('refuses a body that is not a report, and one that is too large', async () => {
		expect((await post('not json')).status).toBe(400);
		expect((await post('"a string"')).status).toBe(400);
		expect((await post('null')).status).toBe(400);
		expect((await post(JSON.stringify({ pad: 'x'.repeat(20_000) }))).status).toBe(413);
		expect((await post('{}', { 'content-length': String(1_000_000) })).status).toBe(413);
	});
});
