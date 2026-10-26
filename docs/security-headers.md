# Security headers and the Content-Security-Policy (S2.7)

Written for: whoever rolls the app out and has to switch the CSP from report-only to enforcing.

Status: **checked in a real Chromium against the built app (enforce mode), not in any other browser, not through a real ingress, not with a
real PLANTdataHUB sign-in.** Code: [security-headers.ts](../src/lib/server/security-headers.ts),
[csp-directives.ts](../src/lib/server/csp-directives.ts), the `csp` option in [vite.config.ts](../vite.config.ts), [routes/csp-report](../src/routes/csp-report/+server.ts).
Decision record: [adr/0004-edge-hardening.md](adr/0004-edge-hardening.md).

## 1. What every response carries

Added by the `handle` hook last, after the request id (`addSecurityHeaders` in `hooks.server.ts`), on pages, BrAPI, errors, redirects
and also on `/healthz`, `/readyz`, `/metrics` and `/csp-report`, which otherwise skip the hook's work (six header writes cost nothing). A response whose
headers are immutable (`Response.redirect()`) is copied, as `X-Request-Id` already does.

| Header                                  | Value                                                                                                                | Why                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy[-Report-Only]` | section 2                                                                                                            | no inline script, nothing from another site                                                                                                                     |
| `Strict-Transport-Security`             | `max-age=15552000` (180 days), only when `ORIGIN` is https; `HSTS_MAX_AGE=0` turns it off                            | no `includeSubDomains` (nothing here to protect, and it reaches names this app does not own) and no `preload`                                                   |
| `X-Content-Type-Options`                | `nosniff`                                                                                                            | JSON and downloads are never sniffed into HTML                                                                                                                  |
| `X-Frame-Options`                       | `DENY`                                                                                                               | justified: the CSP's `frame-ancestors 'none'` is not enforced while the CSP is report-only or off, and old browsers ignore it; this does not depend on the mode |
| `Referrer-Policy`                       | `same-origin`                                                                                                        | PLANTdataHUB and anyone else are never told which page a person came from (a page URL can hold an ARC id)                                                       |
| `Permissions-Policy`                    | camera, microphone, geolocation, payment, usb, serial, bluetooth, sensors, midi, display-capture, autoplay: all `()` | features the app never uses. `clipboard-write` (the token copy button) is left at its default                                                                   |
| `X-Robots-Tag`                          | `noindex, nofollow`                                                                                                  | for a crawler that ignores [robots.txt](../static/robots.txt) (`Disallow: /`, a test keeps it so)                                                               |

## 2. The Content-Security-Policy

```
default-src 'none'; script-src 'self' 'nonce-<per request>'; style-src 'self'; style-src-attr 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self';
frame-ancestors 'none'; object-src 'none'; report-uri /csp-report
```

SvelteKit's `kit.csp` (`mode: 'nonce'`) builds it, because only SvelteKit can put a fresh nonce on the one inline script it generates (the
hydration bootstrap). The hook then keeps, renames or drops the header by `CSP_MODE`, so the mode is a run-time setting, not a rebuild.

- **No `unsafe-inline` and no `unsafe-eval` for scripts.** Two requests get two different nonces (checked in the browser run and with `curl`).
- **`style-src-attr 'unsafe-inline'`** is the one exception: `style="width: 40%"` attributes (the dashboard bars, the `display: contents` wrapper in
  `app.html`) cannot carry a nonce. An attribute cannot run script. `style-src` itself stays `'self'` (SvelteKit's inline `<style>`, if any, gets a nonce).
- **`img-src data:`** because daisyUI's CSS uses inline SVG data URIs.
- Everything else is `'self'` or `'none'`. The OIDC sign-in is a `fetch` to `/api/auth/sign-in/oauth2` followed by a top-level navigation
  to PLANTdataHUB, which no CSP directive governs, so `form-action 'self'` is enough (checked up to the redirect, with a stand-in identity provider).
- A response SvelteKit gave no policy (BrAPI JSON, `/api/auth/*`, redirects, the probes) gets `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; report-uri /csp-report`.

### Report-only first (decision)

`CSP_MODE` defaults to **`report-only`** (chart: `security.csp.mode`). Browsers send what they would have blocked to `/csp-report`, and nothing breaks.
Reason: the policy was verified in one browser engine and without a real sign-in; a wrong directive in enforce mode is a white page for everybody, a wrong
one in report-only mode is a counter. The cost: until it is switched, the CSP does not protect anyone.

**To enforce:** on staging, use the app through the real ingress and a real sign-in in Firefox, Chrome and Safari (the pages `/`, `/arcs`, `/arcs/<id>`, `/account/tokens`, creating and
revoking a token, the ETL buttons), then check `mira_csp_violations_total` (the counter is the only record: nothing is logged). If it stayed at 0
(browser extensions can add a few: look at the `directive` label), set `security.csp.mode=enforce`. `off` removes the header, for an emergency.

### `/csp-report`

Counts reports in `mira_csp_violations_total{directive,disposition}` (the label values come from a fixed list, never from the report; `disposition` is `report` or
`enforce`). It **logs nothing and stores nothing**: not the body, not the page URL or the blocked URL (both can hold a query string), not the policy (it holds the nonce).
It accepts `application/csp-report` and `application/reports+json`, refuses bodies over 16 KB (413) and non-reports (400), and answers 204. It is anonymous, bypasses the session lookup and the request log in the hook
(reports come in bursts, and need no login), and is covered by adapter-node's `BODY_SIZE_LIMIT`. An ingress rate limit applies to it like to any path.

## 3. What was run

- Unit and hook tests: [security-headers.test.ts](../src/lib/server/security-headers.test.ts) (every mode, immutable redirect, a policy without `unsafe-inline`), `hooks.server.test.ts` (page, BrAPI, 401/404/429/500, redirect, the four bypass paths, log line unchanged), `routes/csp-report/server.test.ts` (both formats, label vocabulary, nothing leaked), `env-schema.test.ts`.
- `scripts/csp-browser-check.mjs`: starts the **built** app (`pnpm build`) in `CSP_MODE=enforce` against a throwaway Postgres, seeds a user and a signed session cookie, stands in for PLANTdataHUB with a tiny HTTP
  server, and loads `/` (anonymous and signed in), `/arcs` and `/account/tokens` (creating a token) in headless Chromium. It asserts: an enforcing policy with a script nonce, no `unsafe-inline` for scripts, a different nonce per request, `X-Frame-Options`,
  no `securitypolicyviolation` event and no CSP error in the console, the pages rendered, the sign-in click reached the identity provider's address, and, as a control that the check can fail, that an injected inline script **is** blocked
  and reported and `/csp-report` counted exactly that one. It also prints how many requests a page load makes (14 to 16). Ran, all passed, against Chromium headless shell 1248 (set `CHROMIUM_PATH` if Playwright's own download does not match):

  ```sh
  pnpm build && DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres node scripts/csp-browser-check.mjs
  ```

- `curl -I` against the built server for a page, a 404, a 401 BrAPI call, a redirect and the probes; with `ORIGIN=https://...` for HSTS.

## 4. What was not verified (needs a real cluster and browsers, session L)

- Firefox and Safari (different handling of `style-src-attr`, of `report-uri` versus `report-to`, and of nonces on `modulepreload`).
- The real PLANTdataHUB sign-in under the policy (only the redirect to a stand-in address was seen), and the return to `/arcs`.
- That the ingress controller does not add, drop or duplicate any of these headers (a controller-level CSP or `X-Frame-Options` would conflict), and that `Strict-Transport-Security` is not set twice.
- `/arcs/[id]` and the ETL pages with real data (the browser run used the pages above; the ARC page was not loaded because it needs an imported ARC).
- Browser extensions and corporate proxies injecting scripts: they show up as violations in report-only mode, which is its purpose.
- That a browser really sends reports through the ingress (the browser run reaches the app directly).
