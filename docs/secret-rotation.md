# Rotating `BETTER_AUTH_SECRET` (S2.3)

Written for: an operator who has to replace the better-auth secret (suspected leak, a person with access leaving, or a
planned rotation) and has not read the code.

**Status: written from the code and better-auth's source; never run on staging or anywhere else.** Do the dry run on
staging first and correct this page with what you see. The behaviour claims below that are covered by automated tests
are marked (tested); the rest is reasoning.

## What the secret does, and so what breaks

`BETTER_AUTH_SECRET` (Secret `mira-auth`, key `BETTER_AUTH_SECRET`, read by the web app **and** the worker) is used for:

1. **Encrypting the OAuth tokens** in the `account` table (`access_token`, `refresh_token`): the key is derived from it.
   After a rotation the stored tokens cannot be decrypted. (tested: `token-encryption.test.ts`, "cannot read tokens stored
   under another BETTER_AUTH_SECRET".) The `id_token` column is not encrypted.
2. **Signing the session cookie.** After a rotation every existing session is invalid: everybody is signed out.
3. Signing short-lived OAuth state during login (only matters for a login in flight).

Consequences, all temporary and fixed by signing in again:

- **Every user is signed out** and must log in through PLANTdataHUB again. Logging in stores fresh tokens, encrypted with
  the new secret, over the old unreadable ones.
- **BrAPI clients lose access** (BrAPI is cookie-only until S2.4): they must sign in again too.
- **ETL jobs** queued or retried by a user who has not signed in again fail, once and without retries, with
  "PLANTdataHUB access could not be refreshed ... Sign in again and retry." The user signs in and clicks import again.
  A job that is running at the moment of the switch can fail the same way.
- Nothing else is lost: ARC data, jobs and users are untouched. The OIDC client secret (`OIDC_CLIENT_SECRET`) is a
  separate credential and does not change; rotating that is described in [infrastructure.md](infrastructure.md).

Web and worker **must hold the same secret**: a worker with the old secret cannot read tokens the new web app stored, and the
reverse. That is why the steps below stop the worker first.

## Steps

`ORIGIN` and namespace `mira` as in [oidc-setup.md](oidc-setup.md). `PG` is
`kubectl -n mira exec "$PRIMARY" -c postgres -- psql -d mira -At -c`.

1. [ ] **Announce** a short window in which everybody must sign in again. Pick a quiet time.
2. [ ] **Check for running imports:** `$PG "select state, count(*) from etl_job where state in ('queued','running') group by 1"`.
       Expected: nothing, or wait until it is. (A queued job will fail and be retried by hand.)
3. [ ] **Stop the worker:** `kubectl -n mira scale deploy/mira-worker --replicas=0`. Note its normal replica count
       (`worker.replicas` in your values) for step 7.
4. [ ] **Generate and store the new secret** (at least 32 characters, high entropy; it is never printed):
       `kubectl -n mira create secret generic mira-auth --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 48)" --dry-run=client -o yaml | kubectl -n mira apply -f -`.
       Expected: `secret/mira-auth configured`. Keep the old value somewhere safe until step 8 (a rollback needs it).
5. [ ] **Restart the web app:** `kubectl -n mira rollout restart deploy/mira && kubectl -n mira rollout status deploy/mira`.
       Expected: rolled out; `kubectl -n mira logs deploy/mira | head` shows `Listening on` and no
       `Invalid server configuration`. (A Secret change alone does not restart pods: `envFrom` and `secretKeyRef` are read at start.)
6. [ ] **Clear the unreadable tokens** (optional but tidy; it makes the old state explicit instead of "undecryptable"):
       `$PG "update account set access_token = null, refresh_token = null, id_token = null"`. Expected: `UPDATE <n>`.
       Sessions need no cleanup: their cookies no longer verify; `$PG "delete from session"` removes the dead rows.
7. [ ] **Start the worker again:** `kubectl -n mira scale deploy/mira-worker --replicas=<normal count>`, then
       `kubectl -n mira logs deploy/mira-worker`. Expected: `etl: worker ... started`.
8. [ ] **Verify** with a test user: you are signed out; log in; open `ORIGIN/arcs` (list loads); import an ARC
       (succeeds); `$PG "select left(access_token, 4), length(access_token) > 60 from account order by updated_at desc limit 1"`
       shows a ciphertext, not a token starting `glpat-` or similar. Then tell everyone the window is over.
9. [ ] **Destroy the old secret** wherever you kept it.

**Rollback** (the new secret turned out wrong): put the old value back in `mira-auth`, restart web and worker. Tokens
that nobody has replaced since are readable again; users who already signed in under the new secret must sign in once more.

## Not tested

This procedure has not been run on staging. In particular: that `kubectl rollout restart` of the web app and the worker
scale-down behave as described with your Helm release (a later `helm upgrade` resets `replicas` to the values file), that
the OIDC login after a rotation works against a real PLANTdataHUB, and how long users see errors in the window. better-auth
also has a versioned `BETTER_AUTH_SECRETS` option that would let old and new secrets coexist and avoid signing everyone out;
MIRA does not use it (it passes one secret explicitly), and wiring it would need its own change and test.
