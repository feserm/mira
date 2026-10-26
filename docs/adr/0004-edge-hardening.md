# 0004: Network and edge hardening

Status: accepted (session K, sprint stories S2.6 and S2.7). Date: 2026-10-26.

## Context

The app and its pods were reachable from every pod in the cluster, could call any address, sent no security headers, had no rate limit in front of the sign-in endpoints that held across
replicas, and told crawlers they could read everything. Facts that shaped the decisions:

- No cluster was available for this session; `docs/infrastructure.md` does not say which network plugin the cluster runs, and nothing else in the repo does.
- A NetworkPolicy cannot name a host, and PLANTdataHUB and NCBI are hosts.
- The chart leaves `ADDRESS_HEADER` unset (ADR 0001): the socket peer is the ingress pod. better-auth reads `X-Forwarded-For` only when it has one entry.
- `/metrics` shares the app's port, so a policy cannot tell it from a page (ADR 0003 left a NetworkPolicy for it to this session).
- The app is built with Tailwind and daisyUI, uses `style="..."` attributes, and SvelteKit generates one inline script per page.

## Decisions

1. **NetworkPolicies are rendered by the chart and off by default** (`networkPolicy.enabled`). Default deny for the release's pods; web, worker, migration Job and retention CronJob each get only what they need
   (`docs/network-policy.md`). Off, because ingress namespace, enforcement and PLANTdataHUB's addresses are cluster facts the chart cannot know, and a wrong guess takes the site or the login down. CI renders and asserts the on state.
2. **Egress to hosts: three modes, `cidr` the default.** `cidr` takes addresses as values and refuses to render without them (no guessed IPs); `cilium` renders `toFQDNs`; `https` allows public TCP 443. No egress proxy (the app's `fetch` does not use one).
3. **Pod Security `restricted` was already met** by the shared security contexts; a CI script asserts it on the rendered pods of all four kinds, and the namespace labels are documented (the chart does not create the namespace).
4. **Postgres: an optional ingress-only policy**, no egress policy for the database pods (the API server, the object store and the replicas make a wrong rule dangerous: a stuck WAL archiver fills the volume).
5. **Headers by the `handle` hook**, from one module: CSP (SvelteKit's `kit.csp` with nonces for the page policy; a policy that allows nothing for responses without one), HSTS (180 days, https only, no `includeSubDomains`/`preload`), `nosniff`, `X-Frame-Options: DENY` next to `frame-ancestors`,
   `Referrer-Policy: same-origin`, a `Permissions-Policy` that turns off what the app never uses, `X-Robots-Tag`.
6. **CSP is report-only by default** (`CSP_MODE`, chart `security.csp.mode`), switched to enforce after staging shows `mira_csp_violations_total` at 0 in real browsers. A `/csp-report` endpoint counts reports by a fixed label set and logs nothing.
7. **better-auth's rate limiter stores its counters in Postgres** (`rate_limit`, migration 0007), keyed by a client address the hook works out as the `XFF_DEPTH`-th entry of `X-Forwarded-For` from the right and hands over in a header of its own. Sign-in is 30 per minute (default 3 per 10 s), `get-session` 300 per 10 s, the rest 100 per 10 s.
8. **Ingress rate limit: optional ingress-nginx annotations**, off by default, 20 requests/s per address with a burst of 100 when on.
9. **Failed BrAPI token attempts stay unlimited** (ADR 0001 stands).
10. **`robots.txt` disallows everything.**

## Alternatives considered

- **NetworkPolicies on by default.** Safer on paper, but the chart would have to guess namespaces and either fail every install without addresses or default to a mode that allows all of HTTPS. Revisit once staging shows the right values, then flip the default in the same change as the production values.
- **Egress by `https` as the only mode.** Works everywhere, but allows exfiltration over 443. Kept as a mode, not the default.
- **Egress by DNS-aware proxy or Cilium only.** Excludes clusters on other plugins, and the plugin is unknown.
- **Writing the CSP in the hook with our own nonce.** Would need the nonce on SvelteKit's inline script without SvelteKit's help (a string rewrite of the HTML that also nonces anything injected). `kit.csp` does this properly; the hook only changes the header's name, which makes the mode a run-time setting.
- **CSP enforcing from the start.** The policy was checked in one browser engine and without a real sign-in. A wrong directive in enforce mode is a white page for everyone.
- **`secondaryStorage` for the limiter** needs a Redis or similar, which the cluster does not have. **In-memory storage** (better-auth's default) is per pod and forgets on restart.
- **better-auth's `trustedProxies`** would need the proxies' addresses, which are cluster facts, and still reads only the header's right end after skipping trusted hops; the depth rule needs no addresses and matches adapter-node's `XFF_DEPTH`.
- **Setting `ADDRESS_HEADER`** would make `getClientAddress()` throw for every request without the header (probes, the scrape, calls from inside the cluster) and change nothing for better-auth.
- **A failure limiter for bad API tokens**: see ADR 0001; a lock-out by address hurts colleagues behind the same address, and the token cannot be guessed.

## Consequences

- With the policies on, a pod of the release can reach only what the table in `docs/network-policy.md` lists; a new outbound call (another host) needs a value, and the migration Job's rules change one upgrade late.
- `/metrics` is still reachable from the ingress controller: the token is its only lock (ADR 0003).
- Until `CSP_MODE=enforce`, the CSP reports and does not block. `X-Frame-Options` covers clickjacking meanwhile.
- The rate limit is only as good as `XFF_DEPTH`. A wrong value either shares one bucket among everybody (strict) or lets a client choose its bucket (open); `docs/rate-limits.md` has the check to run on staging.
- Every request to `/api/auth/*` costs a read and a write on `rate_limit`. New sessions store the real client address in `session.ip_address`.
- Nothing here was applied to a cluster, run in Firefox or Safari, or sent through a real ingress: the lists in `docs/network-policy.md`, `docs/security-headers.md` and `docs/rate-limits.md` (and the sprint plan) are session L's.
