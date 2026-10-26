/** The address of the client of a request, for the sign-in rate limit (S2.7, docs/rate-limits.md).
 *
 *  Behind the ingress the socket peer is the ingress pod, so a limiter keyed by it would count everybody
 *  as one client. `X-Forwarded-For` has the real address, but only its **right** end can be trusted:
 *  each proxy appends the address it saw, and the client can put anything it likes at the left. With
 *  `XFF_DEPTH` trusted proxies in front of the app the client is the entry that many places from the
 *  right (adapter-node reads the same variable the same way). better-auth's own reading takes the
 *  left-most entry, or none at all when there are several, so it is given the answer in a header of our
 *  own instead of the raw header. */
import { isIP } from 'node:net';

/** Set by the hook on every request it passes to better-auth, overwriting what a client may have sent. */
export const CLIENT_ADDRESS_HEADER = 'x-mira-client-address';

/** The client's address from an `X-Forwarded-For` value, or undefined if the chain is shorter than the
 *  trusted depth (a proxy was skipped) or the entry is not an IP address. */
export function clientFromForwardedFor(header: string | null, depth: number): string | undefined {
	if (!header) return undefined;
	const entries = header.split(',').map((entry) => entry.trim());
	if (depth < 1 || depth > entries.length) return undefined;
	const entry = entries[entries.length - depth];
	return isIP(entry) ? entry : undefined;
}

/** Writes the client address into `CLIENT_ADDRESS_HEADER` of `headers` (removing a value the client
 *  sent). With `xffDepth` unset no proxy is trusted: `X-Forwarded-For` is not read and the peer is the
 *  client. If neither gives an address the header is left out, and better-auth then keys the request
 *  under one shared bucket, which fails safe (strict) instead of open. Returns the address used. */
export function pinClientAddress(
	headers: Headers,
	options: { xffDepth?: number; peer: () => string | undefined }
): string | undefined {
	headers.delete(CLIENT_ADDRESS_HEADER);
	const forwarded =
		options.xffDepth === undefined
			? undefined
			: clientFromForwardedFor(headers.get('x-forwarded-for'), options.xffDepth);
	const address = forwarded ?? options.peer();
	if (address && isIP(address)) headers.set(CLIENT_ADDRESS_HEADER, address);
	return address;
}
