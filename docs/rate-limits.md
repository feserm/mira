# Rate limits and the client address (S2.7)

Written for: whoever tunes limits and debugs a 429 or 503 that a person reports.

Status: the app side (the limiter, the client address, the 429 and its `Retry-After`) **ran against a real Postgres and the built server**. The ingress side is
**annotations rendered by the chart and never seen by an ingress controller.** Decision record: [adr/0004-edge-hardening.md](adr/0004-edge-hardening.md).

There are three limiters, each protecting something else:

| Limiter                     | Key                              | Where it counts            | Limit                                                         | Protects                                           |
| --------------------------- | -------------------------------- | -------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| Ingress-nginx (chart value) | the address nginx sees, any path | the controller             | 20 requests/s, burst 5x (off by default)                      | everything, before the app is reached              |
| better-auth (`/api/auth/*`) | client address and path          | **Postgres**, `rate_limit` | 100 per 10 s; sign-in 30 per 60 s; `get-session` 300 per 10 s | sign-in endpoints, the database writes behind them |
| API token (BrAPI)           | token id                         | process memory, per pod    | 60 per minute (S2.4, unchanged)                               | one runaway client of the BrAPI                    |

## 1. The client address (the trap)

The chart leaves `ADDRESS_HEADER` unset on purpose (a request with no such header, like a kubelet probe, would make `getClientAddress()` throw), so
the socket peer of a request is the **ingress pod**. A limiter keyed by that would count every person as one client: three sign-ins in ten seconds and
nobody could sign in.

`X-Forwarded-For` has the real address, but only its right end can be trusted: each proxy **appends** the address it saw, and a client can write anything to the left.
better-auth (1.6.29, `getIp`) takes the header only when it has **exactly one** entry. Behind ingress-nginx's default (it overwrites the header) that happens to be right; with a second proxy that appends
(a load balancer in front, or `use-forwarded-headers` on) there are several entries, it finds no address, and **everybody shares one bucket per path** ("no-trusted-ip"). It can walk a chain given `trustedProxies`, the proxies' own addresses, which this chart does not know.
So the app works the address out itself, from the depth, and gives better-auth the result:

1. `XFF_DEPTH` (already set by the chart, `config.proxy.xffDepth`, default 1) is the number of proxies in front of the app that append to `X-Forwarded-For`. The client is the entry that many places **from the right**. This is the
   same variable adapter-node reads, with the same meaning. **Unset: `X-Forwarded-For` is ignored** (local development, no proxy) and the client is the socket peer.
2. The hook (`pinAuthClient`, `client-address.ts`), for requests to `/api/auth/*` only, deletes any `X-Mira-Client-Address` the client sent and writes the address it worked out into that header on the request.
   If the chain is shorter than the depth (a proxy was skipped, a call from inside the cluster) or has no header, the peer address is used; if there is none, no header, and better-auth keys the
   request under one shared bucket per path, which is strict rather than open.
3. better-auth reads only that header (`advanced.ipAddress.ipAddressHeaders`), and rate-limits, and stores in `session.ip_address`, that address.

Consequences, stated plainly:

- **Set `XFF_DEPTH` to the real number of appending proxies.** One (the ingress controller alone) is the chart default. A cloud load balancer in front that also appends makes it 2. Too low: the limiter counts the
  load balancer's address (one bucket for everyone) or a client-controlled entry. Too high: the chain is "too short", and the socket peer (the ingress pod) is used.
- ingress-nginx **overwrites** `X-Forwarded-For` with the address it saw unless `use-forwarded-headers` is on in its ConfigMap; with it on it appends. Both work with depth 1 when the controller is the only proxy.
  With a load balancer in front that also appends, depth is 2. Whether the controller sees the browser's address or a node's (`externalTrafficPolicy`, proxy protocol) is a cluster property: not checked.
- Anything that can reach the pod port directly (another pod, when no NetworkPolicy is on) can write `X-Forwarded-For` itself and so choose its own bucket. That is why `networkPolicy.enabled` limits who may reach the web pods.
- The address is now stored in `session.ip_address` for new sessions (personal data, kept as long as the session row). Before, better-auth stored the header's value when it had one entry, and nothing otherwise.
- `getClientAddress()` is called only as the peer fallback, in a `try`; `ADDRESS_HEADER` stays unset.

Ran: unit tests for the depth arithmetic (spoofed left end, depth 2, short chain, IPv6, injected header), the real hook with the real better-auth on Postgres (a spoofed left end does not evade the limit, a client-sent pin header is ignored, the stored key is the right-hand
address), and `curl` with `X-Forwarded-For` against the built server (101st request 429, another address 200, `Retry-After`).

## 2. better-auth's limiter

- **Storage: the database** (`rateLimit.storage: 'database'`, table `rate_limit`: `id`, `key` unique, `count`, `last_request`; migration `0007_auth_rate_limit`, made with `pnpm auth:schema` and `pnpm db:generate`). Chosen over `secondaryStorage` because there is no Redis in the cluster and a table needs only the DML role
  (the default privileges cover it: `deploy/postgres/test-roles.sh` checks every table). The limit holds across replicas, restarts and rolling updates (a test restarts the module). better-auth's database storage updates the row atomically. Cost: one read and one write for each request to `/api/auth/*`, which a page
  load makes once or twice. better-auth deletes expired rows itself, but only when some other key's window rolls over; every window here is at most 60 s because it prunes by that age, so **do not set a window above 60** without changing how rows are pruned.
- **Limits** (`auth-rate-limit.ts`): per client address and path, 100 requests per 10 s by default. `/sign-in/oauth2` is 30 per 60 s instead of better-auth's 3 per 10 s (meant for password forms): all of an institute's users can sit behind one address and sign in at 09:00. `/get-session` is 300 per 10 s: it runs on every page load.
  Constants, not environment variables, like the token limit.
- **429:** body `{"message":"Too many requests. Please try again later."}`, `X-Retry-After` (better-auth's) and `Retry-After` (the standard one, added by the hook). Counted in `mira_auth_rate_limit_hits_total`; the request log line and `mira_http_requests_total` show the 4xx as usual.
- A request to any path under `/api/auth/` creates a row keyed `<address>|<path>`, even for a path that does not exist (better-auth limits before it routes). One address can therefore create rows by asking for made-up paths, bounded by the ingress limit and cleaned up by the pruning above. Not mitigated further.
- The database being down makes `/api/auth/*` answer 500, as sign-in could not work anyway.

## 3. The ingress limit

`ingress.rateLimit.*` renders ingress-nginx annotations (`limit-rps`, `limit-burst-multiplier`, optionally `limit-connections` and `limit-whitelist`). **Off by default.** nginx counts by the address it sees: if that is a load balancer or a node (the section 1 question), turning the
limit on throttles everybody together. Check on staging first. A different controller class ignores the annotations.

Numbers (when on): 20 requests per second per address, burst 5x (100). A page load is 14 to 16 requests (measured in the browser run, a few of them `/api/auth/get-session`), so one address can load six pages at once and then one per second on average. The per-token BrAPI limit is 1 request per second per token, so 20 busy
tokens behind one address fit; a script that hammers with many tokens from one address is what this stops. Raise `rps` for a large institute behind one address; use `whitelist` for a scanner or monitor that must not be limited.

**What the client sees:** the controller answers a request over the limit itself, with **503** unless `limit-req-status-code: "429"` is set in the controller's ConfigMap (a cluster-wide setting the chart cannot make). MIRA never sees those requests, so they do not appear in its metrics or alerts; look at the controller's.

## 4. Failed BrAPI token attempts: not limited (ADR 0001 stays)

With a trustworthy address available this is now possible, and **this session decided not to do it.** Guessing a 256-bit token is not feasible, an invalid token costs one indexed lookup, and a lock-out keyed by address would let one misconfigured script lock **colleagues' valid tokens** out of a shared institute address
(the check has to run before the lookup to save the lookup, so valid and invalid requests from that address would be refused alike). The volume of bad attempts is bounded by the ingress limit when it is on. Revisit if the logs show someone probing: the address is available in `locals`-adjacent code now (`pinClientAddress`), the only new piece would be a failure counter in
`authenticateBrapi`.

## 5. What was not verified (needs a cluster, session L)

- That nginx sees the browsers' real addresses through the real load balancer (`externalTrafficPolicy`, proxy protocol), and which `XFF_DEPTH` is right there. **Send a request from a known address, then read `select key from rate_limit`: the key must be that address.**
- The ingress annotations accepted by the real controller version, the 503 versus 429 answer, and a client over the limit seeing it.
- The better-auth limiter through the real ingress with more than one replica (a test restarts the module and shares the database; two real pods were not run), and the sign-in path under a burst from one address (30 per minute) with real users.
- The migration `0007` on the real cluster as `mira_migrator`, with `mira_app` writing the table (proven locally with `deploy/postgres/test-roles.sh`).
- The size of `rate_limit` after a few weeks (stale rows, section 2).
