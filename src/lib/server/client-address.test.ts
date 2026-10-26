import { describe, expect, it } from 'vitest';
import { CLIENT_ADDRESS_HEADER, clientFromForwardedFor, pinClientAddress } from './client-address';

describe('clientFromForwardedFor', () => {
	it('with one trusted proxy the client is the last entry (what the ingress appended)', () => {
		expect(clientFromForwardedFor('203.0.113.7', 1)).toBe('203.0.113.7');
		expect(clientFromForwardedFor('198.51.100.1, 203.0.113.7', 1)).toBe('203.0.113.7');
	});

	it('ignores what the client put to the left, however much', () => {
		expect(clientFromForwardedFor('1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7', 1)).toBe('203.0.113.7');
	});

	it('with two trusted proxies the client is the second from the right', () => {
		expect(clientFromForwardedFor('203.0.113.7, 10.0.0.9', 2)).toBe('203.0.113.7');
		expect(clientFromForwardedFor('9.9.9.9, 203.0.113.7, 10.0.0.9', 2)).toBe('203.0.113.7');
	});

	it('gives nothing when the chain is shorter than the trusted depth (a proxy was skipped)', () => {
		expect(clientFromForwardedFor('203.0.113.7', 2)).toBeUndefined();
	});

	it('gives nothing for no header, a bad depth or an entry that is not an address', () => {
		expect(clientFromForwardedFor(null, 1)).toBeUndefined();
		expect(clientFromForwardedFor('', 1)).toBeUndefined();
		expect(clientFromForwardedFor('203.0.113.7', 0)).toBeUndefined();
		expect(clientFromForwardedFor('1.2.3.4, not-an-ip', 1)).toBeUndefined();
		expect(clientFromForwardedFor('1.2.3.4, 203.0.113.7:5555', 1)).toBeUndefined();
		expect(clientFromForwardedFor('1.2.3.4, 1.2.3.4\r\nx: y', 1)).toBeUndefined();
	});

	it('accepts IPv6', () => {
		expect(clientFromForwardedFor('2001:db8::1', 1)).toBe('2001:db8::1');
	});
});

describe('pinClientAddress', () => {
	const peer = () => '10.1.2.3';

	it('writes the client from X-Forwarded-For', () => {
		const headers = new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' });
		expect(pinClientAddress(headers, { xffDepth: 1, peer })).toBe('203.0.113.7');
		expect(headers.get(CLIENT_ADDRESS_HEADER)).toBe('203.0.113.7');
	});

	it('overwrites a value the client sent in the header itself', () => {
		const headers = new Headers({
			[CLIENT_ADDRESS_HEADER]: '5.5.5.5',
			'x-forwarded-for': '203.0.113.7'
		});
		pinClientAddress(headers, { xffDepth: 1, peer });
		expect(headers.get(CLIENT_ADDRESS_HEADER)).toBe('203.0.113.7');
	});

	it('removes a value the client sent when there is no address to put in its place', () => {
		const headers = new Headers({ [CLIENT_ADDRESS_HEADER]: '5.5.5.5' });
		pinClientAddress(headers, { xffDepth: 1, peer: () => undefined });
		expect(headers.has(CLIENT_ADDRESS_HEADER)).toBe(false);
	});

	it('falls back to the socket peer without X-Forwarded-For, or when the chain is too short', () => {
		for (const xff of [undefined, '203.0.113.7']) {
			const headers = new Headers(xff ? { 'x-forwarded-for': xff } : {});
			expect(pinClientAddress(headers, { xffDepth: 2, peer })).toBe('10.1.2.3');
			expect(headers.get(CLIENT_ADDRESS_HEADER)).toBe('10.1.2.3');
		}
	});

	it('trusts no proxy when XFF_DEPTH is unset: X-Forwarded-For is ignored', () => {
		const headers = new Headers({ 'x-forwarded-for': '6.6.6.6' });
		expect(pinClientAddress(headers, { peer })).toBe('10.1.2.3');
		expect(headers.get(CLIENT_ADDRESS_HEADER)).toBe('10.1.2.3');
	});

	it('never writes something that is not an address', () => {
		const headers = new Headers();
		pinClientAddress(headers, { xffDepth: 1, peer: () => 'unix:/run/app.sock' });
		expect(headers.has(CLIENT_ADDRESS_HEADER)).toBe(false);
	});
});
