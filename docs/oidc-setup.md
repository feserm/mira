# OIDC setup on PLANTdataHUB (S1.8)

Written for: an operator who has not seen this repository and has to get login and import working on staging.

**Status: nothing in this runbook has been run against a real PLANTdataHUB.** It was written from the code,
GitLab's documentation and a local stub of the GitLab endpoints. Every step that needs a human has a checkbox and
an expected result; if reality differs, write down what you saw and update this page. The decisions behind it
(confidential client, scopes) are in [infrastructure.md](infrastructure.md).

Names used below: `ORIGIN` is the public address of MIRA (`https://mira.example.org`), `GL` is the PLANTdataHUB base URL
(`https://git.example.org`, the same value as `config.oidc.issuerUrl`), the Helm release is `mira` in namespace `mira` (so the Deployments are `mira` and `mira-worker`).

## What the app does with the token

Login uses OpenID Connect against GitLab. The access token GitLab issues is **reused as a GitLab API token**, by the web
app and by the ETL worker, for exactly three calls (`src/lib/server/plantdatahub.ts`, `etl/extract.ts`):

| Call                                                                                          | Used for                  |
| --------------------------------------------------------------------------------------------- | ------------------------- |
| `GET $GL/api/v4/projects?archived=false&order_by=last_activity_at&sort=desc&simple=true&...`  | the ARC list (`/arcs`)    |
| `GET $GL/api/v4/projects/<id>?statistics=true&license=true`                                   | the ARC page, and Extract |
| `GET $GL/api/v4/projects/<id>/packages/generic/isa_arc_json/0.0.1/arc-ro-crate-metadata.json` | Extract (the download)    |

GitLab access tokens last 2 hours; the worker refreshes them through the stored refresh token (better-auth).

## 1. Register the application in GitLab

- [ ] **Decide who owns it.** An application owned by a person stops working when that person's account is blocked.
      Prefer an **instance-wide** application (Admin area, Applications) or a **group-owned** one (group Settings,
      Applications). A user-owned one (Edit profile, Access, Applications) is fine for a first staging test.
- [ ] **Add a new application** with:

  | Field        | Value                                                                                                          |
  | ------------ | -------------------------------------------------------------------------------------------------------------- |
  | Name         | `MIRA (staging)`                                                                                               |
  | Redirect URI | `ORIGIN/api/auth/oauth2/callback/oidc`, exactly, e.g. `https://mira.example.org/api/auth/oauth2/callback/oidc` |
  | Confidential | **checked** (see [infrastructure.md](infrastructure.md) section 1)                                             |
  | Scopes       | `openid`, `profile`, `email`, `read_api`. Nothing else.                                                        |
  | Trusted      | optional, admin only: skips the consent screen                                                                 |

  The redirect URI has no trailing slash and must match the scheme, host and port the browser uses.
  Expected: after **Save application** GitLab shows an **Application ID** and a **Secret**. Copy both now.

- [ ] **Store the secret** as a Kubernetes Secret (never in a values file):
      `kubectl -n mira create secret generic mira-oidc --from-literal=OIDC_CLIENT_SECRET='<secret>'`.
      Expected: `secret/mira-oidc created`.

## 2. Helm values

The values that matter (the full install is in [deploy/helm/mira/README.md](../deploy/helm/mira/README.md)):

```yaml
ingress:
  host: mira.example.org # becomes ORIGIN=https://mira.example.org
config:
  oidc:
    issuerUrl: https://git.example.org # no trailing slash, no /.well-known
    clientId: <Application ID>
    scopes: openid profile email read_api # must match what the GitLab application allows
secrets:
  oidcClientSecret:
    name: mira-oidc # key OIDC_CLIENT_SECRET; leave the name empty only for a public client
```

- [ ] After `helm upgrade --install`, `helm get notes mira -n mira` prints the redirect URI. Expected: it is the string you
      registered, character for character.
- [ ] `kubectl -n mira logs deploy/mira | head`. Expected: `Listening on http://0.0.0.0:3000` and no
      `Invalid server configuration`. The worker: `kubectl -n mira logs deploy/mira-worker`, expected
      `etl: worker ... started`.

## 3. Does `read_api` suffice? Test it before relying on it

GitLab documents `read_api` as read access to the API "including all groups and projects, the container registry, and the
package registry". Its page on the generic package registry, however, lists only personal and project tokens with `api`, CI
job tokens and deploy tokens as ways to authenticate, and an OAuth token is not on the list. So whether an **OAuth** token
with only `read_api` can download the RO-Crate package is **not established**. Find out on staging, with the user who will
import.

- [ ] **Log in once** (section 4) so a token exists. Then take it out of the database without printing it:

  ```sh
  PRIMARY=$(kubectl -n mira get cluster mira-pg -o jsonpath='{.status.currentPrimary}')
  read -rs TOKEN < <(kubectl -n mira exec "$PRIMARY" -c postgres -- psql -d mira -At -c \
    "select a.access_token from account a join \"user\" u on u.id = a.user_id
      where u.email = 'you@example.org' and a.provider_id = 'oidc' order by a.updated_at desc limit 1")
  GL=https://git.example.org
  ```

  The token is a live credential for about two hours: do not paste it anywhere, do not put it in a shell history file
  (`read -s` keeps it out of the terminal), and `unset TOKEN` when done. (It is stored in plaintext until S2.3.)

- [ ] **Which scopes does it carry?** `curl -s -H "Authorization: Bearer $TOKEN" "$GL/oauth/token/info"`.
      Expected: JSON with `"scope":["openid","profile","email","read_api"]` and your application id under `application`.
      If `read_api` is missing, the application's scopes were changed after the login: sign out and in again.
- [ ] **List projects.** `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$GL/api/v4/projects?archived=false&simple=true&per_page=1"`.
      Expected: `200`.
- [ ] **Read one ARC** (use a project id you can see): `curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$GL/api/v4/projects/<ID>?statistics=true&license=true" | tail -c 200`.
      Expected: JSON ending in `200`, with a `path` field. (`statistics` is only returned to Reporter or higher; for a lower role the call still succeeds without it.)
- [ ] **Download the RO-Crate.** `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$GL/api/v4/projects/<ID>/packages/generic/isa_arc_json/0.0.1/arc-ro-crate-metadata.json"`.
      Expected: `200`. This is the call in doubt.
- [ ] `unset TOKEN`.

Record the result in the table at the end of this page. If the last call is **not** `200`:

| Observed                          | Meaning                                                           | What to do                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `404`                             | The ARC has no package at that name/version (not a scope problem) | Pick an ARC that has been published with the ISA RO-Crate package, or check the package name in the project's Packages page.                                                                                                                                                                                    |
| `401` or `403`                    | `read_api` does not cover the package download for OAuth tokens   | Change the application's scope to `api` and `config.oidc.scopes` to `openid profile email api`, then **every user must sign in again** (old tokens keep their old scopes). `api` is write access to everything the user can write: it makes the confidential client and S2.3 (token encryption) more important. |
| `401` or `403` with `api` as well | GitLab does not accept OAuth tokens for the package registry      | The design needs a change (a different credential for Extract), which also breaks the "only users with GitLab access" rule (S2.4b). Stop and decide; do not work around it with one shared service token without that decision.                                                                                 |

## 4. Login test

- [ ] Open `ORIGIN` in a browser, click **Log in**. Expected: a redirect to GitLab's sign-in, then the consent page
      for `MIRA (staging)` listing the four scopes (skipped if the application is trusted).
- [ ] Authorize. Expected: back on `ORIGIN`, signed in, your name and avatar in the header.
- [ ] A row exists: `kubectl -n mira exec "$PRIMARY" -c postgres -- psql -d mira -c "select provider_id, scope, access_token_expires_at, refresh_token is not null as has_refresh from account order by updated_at desc limit 1"`.
      Expected: `oidc`, a scope string containing `read_api`, an expiry about 2 hours ahead, `t`.

If it fails, go to the troubleshooting table below.

## 5. End-to-end checklist (the S1.8 acceptance criteria)

- [ ] **Login** works (section 4).
- [ ] **List ARCs.** Open `ORIGIN/arcs`. Expected: your PLANTdataHUB projects, paginated. A 401/403 banner instead means the token or its scope.
- [ ] **Import.** Open an ARC, click **Import RO-Crate**. Expected: the status shows queued, then running, then the steps turn green. In
      another terminal `kubectl -n mira logs -f deploy/mira-worker`. Expected lines:
      `etl: job=<id> arc=<id> kind=full attempt=1/3 running`, then `step=extract`, `step=transform`, `step=load`, then `succeeded in <n>s`.
- [ ] **BrAPI GET.** Still signed in, open `ORIGIN/<project path>/brapi/v2/trials` (the project path of the ARC, e.g. `mygroup/myarc`, as
      shown in GitLab; case does not matter). Expected: JSON with `metadata` and `result.data`, the data containing the trial from the ARC.
      Without a session the same URL answers `401` (BrAPI is cookie-only until S2.4).

## 6. Token lifetime: does background refresh work? (risk 1)

**This has never been run against a real GitLab.** The worker was tested only against a stub that accepts any
request shaped like a refresh grant. Run this on staging with a test user who can import an ARC. `PG` below is
`kubectl -n mira exec "$PRIMARY" -c postgres -- psql -d mira -At -c`.

1. [ ] **Baseline.** Log in. Record a fingerprint of the refresh token (never print the token):
       `$PG "select md5(refresh_token), access_token_expires_at from account where provider_id='oidc' order by updated_at desc limit 1"`.
       Write down the `md5` (A) and the expiry.
2. [ ] **Expire the access token.** `$PG "update account set access_token_expires_at = now() - interval '1 minute' where provider_id='oidc' and user_id = (select id from \"user\" where email='test@example.org')"`.
       Expected: `UPDATE 1`. (better-auth refreshes when the expiry is less than 5 seconds away.)
3. [ ] **Import from the UI** and watch `kubectl -n mira logs -f deploy/mira-worker` and, if you can, the GitLab side
       (an admin: `production_json.log` or the webservice logs, filtered on `POST /oauth/token`).
       Expected in the worker log: no `etl: token refresh failed`, and `succeeded`. Expected at GitLab: one `POST /oauth/token` answered
       `200` from the MIRA host.
4. [ ] **The row changed.** Repeat the query of step 1. Expected: a **different** `md5` (B, GitLab rotated the refresh token) and an expiry about 2 hours ahead.
5. [ ] **Rotation race.** Expire the token again (step 2), then, within a second, import from the UI **and** reload `ORIGIN/arcs` in another tab (both refresh).
       Expected: both succeed. If one fails with a sign-in error, GitLab's single-use refresh token lost a race
       (documented in [infrastructure.md](infrastructure.md)): record it, it decides whether refresh needs a lock.
6. [ ] **Refresh without `redirect_uri`.** Step 3 is also this test: better-auth does not send `redirect_uri` on refresh and GitLab's
       documentation shows it. If step 3 fails at GitLab with `invalid_grant` or `invalid_request` while the refresh token is valid, this is the cause.
7. [ ] **Revoked refresh token fails the job with the right message.** In GitLab (as the test user): profile, Access, Applications,
       **Authorized applications**, **Revoke** for `MIRA (staging)`. Expire the access token (step 2) so a refresh is needed, then click **Import RO-Crate**. Expected: - the job fails at once, not after retries: `$PG "select state, attempts, error from etl_job order by created_at desc limit 1"` shows `failed | 1 | PLANTdataHUB access could not be refreshed for the user who started this import (...). Sign in again and retry.` - the ARC page shows **Import failed** with that text; - the worker log has `etl: token refresh failed: <reason>` (better-auth's message only; tokens are never logged); - `ro_crate_staging` for that ARC is unchanged: `$PG "select extract_status, extracted_at from ro_crate_staging where arc_id = <ID>"`.
8. [ ] **Recovery.** Sign out, sign in again (new consent, new refresh token), import again. Expected: success.

If step 7 shows `attempts` above 1, or the job stays `queued`, the failure is being treated as transient: that is a bug, note the log lines.

## 7. Troubleshooting

| Symptom                                                                                                                   | Likely cause (from the code)                                                                                                                                                | Check and fix                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GitLab: "The redirect URI included is not valid."                                                                         | The registered URI differs from `ORIGIN/api/auth/oauth2/callback/oidc` (scheme, host, port, trailing slash, a second ingress host).                                         | `helm get notes mira -n mira` and compare with the application's Redirect URI. Fix in GitLab.                                |
| Pod crash-loops with `ORIGIN must ...` / `Invalid server configuration`                                                   | `ORIGIN` not https, has a path or trailing slash (S1.2 validation).                                                                                                         | `kubectl logs` shows every problem at once. Fix `ingress.host` or `config.origin`.                                           |
| Login loops back to the sign-in, or every form returns `403 Cross-site POST form submissions are forbidden`               | `ORIGIN` differs from the address in the browser (different host, `http` vs `https`, an alias).                                                                             | Open exactly the `ORIGIN` host. Set `config.origin` if the public name is not `ingress.host`.                                |
| After consent: error page, log has `invalid_client`                                                                       | Wrong or missing `OIDC_CLIENT_SECRET`, or the application is not confidential but a secret is sent (or the reverse).                                                        | Compare the Secret with GitLab's Secret (renew if lost), `rollout restart` web and worker.                                   |
| Login cannot start; log shows a discovery error                                                                           | `OIDC_ISSUER_URL` wrong, or the pod cannot reach `GL` (egress policy; a private CA for GitLab would need `NODE_EXTRA_CA_CERTS`, not covered here).                          | `kubectl exec ... -- node -e "fetch('<GL>/.well-known/openid-configuration').then(r=>console.log(r.status))"` expects `200`. |
| `/arcs` shows "PLANTdataHUB rejected the access token. Please log in again (read_api scope required)" (401)               | Token expired and not refreshable, or the token lacks the scope.                                                                                                            | Check the `scope` column of the `account` row. Sign in again; if it recurs, section 3.                                       |
| `/arcs` or the ARC page shows "PLANTdataHUB denied access to this resource" (403)                                         | The token's scope does not allow the call, or the user cannot see that project.                                                                                             | Section 3. Try a project the user is a member of.                                                                            |
| Import fails at once with "...could not be refreshed ... Sign in again and retry", and signing in again does **not** help | The worker maps a 401/403 from GitLab, as well as an unusable refresh token, to this one message. Persisting after a fresh login means the **scope** (403 on the download). | Section 3 with the same user's token: the package call is the usual culprit.                                                 |
| Import fails with "...could not be refreshed" the first time after a long idle period                                     | The refresh token expired or was revoked (the user removed the application, or GitLab invalidated it).                                                                      | Sign out and in, retry (section 6 step 8).                                                                                   |
| Import fails with "No linked PLANTdataHUB account"                                                                        | The signed-in user has no `oidc` account row (email sign-up is disabled since S2.1, so this means a row from before that change).                                           | Sign in through **Log in** (PLANTdataHUB).                                                                                   |
| Job stays `queued`                                                                                                        | No worker is running, or it cannot reach the database.                                                                                                                      | `kubectl -n mira get pods -l app.kubernetes.io/component=worker` and its log.                                                |

## Result record (fill in on staging)

| Item                                                        | Result | Date | By  |
| ----------------------------------------------------------- | ------ | ---- | --- |
| Application registered, confidential                        |        |      |     |
| `read_api` sufficient for list / project / download         |        |      |     |
| Scope finally used                                          |        |      |     |
| Login, list, import, BrAPI GET                              |        |      |     |
| Token refresh with an expired access token                  |        |      |     |
| Revoked refresh token gives the "sign in again" job failure |        |      |     |
| Rotation race observed                                      |        |      |     |
