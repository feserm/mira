-- S2.3: OAuth tokens in "account" are encrypted from this release on (better-auth
-- account.encryptOAuthTokens). Rows written before hold plaintext tokens and nothing decrypts
-- plaintext, so they are cleared instead of migrated: every user signs in again, which stores fresh,
-- encrypted tokens. The id_token is cleared as well (it is not encrypted by better-auth, but there is
-- no reason to keep an old one). A job queued by a user who has not signed in again fails with
-- "sign in again and retry".
UPDATE "account" SET "access_token" = NULL, "refresh_token" = NULL, "id_token" = NULL;
