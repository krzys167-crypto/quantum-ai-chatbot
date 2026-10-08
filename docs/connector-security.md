# Connector security (OAuth state, token storage, revocation)

Status of each finding, what changed, and what is still a decision or unverified.
Evidence: `npm test` (53 tests) and the SQL probes below. Nothing here was applied to any live database or deployment.

## Findings

| ID | Finding | Status | What changed |
|----|---------|--------|--------------|
| F01 CRITICAL | OAuth `state` was unsigned Base64 JSON `{userId, provider}` | fixed in code | State is now 32 random bytes, stored only as a SHA-256 hash in `oauth_states`, TTL 10 min, consumed by one atomic `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING`. User and provider come from that row, never from the URL (`api/lib/oauthState.js`, `api/lib/oauthFlow.js`). |
| F02 HIGH | Callback wrote tokens with the service role for a `userId` taken from the URL | fixed in code | Same change. A forged or legacy state is rejected before any provider call or write. |
| F03 HIGH | Tokens in plain `text` columns; the RLS policy also let a user read their own token columns through the Data API | fixed in code + SQL (not applied) | `supabase/connectors-hardening.sql` revokes all client access to `connectors` and re-grants SELECT on non-token columns plus DELETE. Optional AES-256-GCM at rest (`CONNECTOR_TOKEN_KEY`), row-bound AAD, plaintext still readable for gradual rollout. |
| F04 HIGH | Gmail scopes `send`, `compose`, `modify`; privacy page says "read-only" and "we do not request permission to send… or modify" | **decision needed, not changed** | The product really uses send, labels and batchModify (`api/lib/gmailDeep.js`). Either the consent text and `public/privacy.html` are corrected, or those features and scopes are removed. This is a legal/product choice and a Google verification risk; no text was edited. |
| F05 HIGH | Existing refresh token kept when reconnecting, without checking it is the same Google account | fixed in code | Kept only if the new account e-mail equals the stored one (case-insensitive). |
| F06 MEDIUM | Microsoft callback ignored the upsert error | fixed in code | One shared flow for both providers; write errors end in `connector_error=save_failed`. |
| F07 MEDIUM | Disconnect did not revoke at the provider | fixed for Google, limited for Microsoft | Row deleted first, then the Google token is revoked (skipped when another connector of the same Google account still shares the grant). Microsoft v2 has no refresh-token revocation endpoint; the response says `unsupported_provider`. |
| P6 | Refresh path | fixed in code | Rotated refresh tokens are stored (Microsoft rotates every time); `invalid_grant` marks the connector `revoked` instead of failing every call. |

Not changed on purpose: CORS `*` on `google-start` and `disconnect` (calls need a Bearer token; tighten to `APP_URL` if wanted).

## SQL evidence (real Postgres, Supabase-like roles)

Run against a throwaway PostgreSQL 18.4 with `anon`/`authenticated`/`service_role`, `auth.uid()` and the default Supabase `grant all` privileges, applying `supabase/connectors.sql` and then `supabase/connectors-hardening.sql`. Production is PostgreSQL 17; these privilege semantics are the same.

| Probe | Before | After |
|-------|--------|-------|
| `authenticated`: `select access_token, refresh_token` (own row) | allowed | permission denied |
| `authenticated`: `select *` | allowed, tokens included | permission denied |
| `authenticated`: `select id, provider, account_email, status, …` (what the UI uses) | allowed | allowed |
| `authenticated`: update / insert | RLS blocks other rows | permission denied |
| `authenticated`: delete own row | allowed | allowed |
| `anon`: select | 0 rows (RLS) | permission denied |
| `authenticated` / `anon`: `oauth_states` | n/a | permission denied |
| `service_role`: read tokens, insert state | allowed | allowed |
| table privileges left for client roles | all | `DELETE` (authenticated) only |
| 2 connections consuming one state concurrently, 50 rounds | n/a | exactly one winner every round |

To reproduce on the real database run `supabase/verify-connectors-hardening.sql` (metadata and counts only, never token values).

## Rollout (nothing is applied by this PR)

1. Confirm which Supabase project the production site really uses (see "Unverified").
2. Take a backup / point-in-time marker. Run `supabase/connectors-hardening.sql`. Run `supabase/verify-connectors-hardening.sql` and check: no `access_token`, `refresh_token`, `token_expires_at` for `anon`/`authenticated`.
3. Deploy this branch. The connect flow returns 503 "OAuth state store unavailable" until step 2 is done (fail closed, never the old unsigned state).
4. Optional encryption: set `CONNECTOR_TOKEN_KEY` (`openssl rand -base64 32`, kept in the Vercel env, never in chat or git), redeploy, then
   `node scripts/rewrite-connector-tokens.mjs --mode seal` (dry run), then with `--apply`. Re-run until `conflicts` is 0.
5. Smoke test: connect Google, connect Microsoft, ask for a Gmail search, disconnect, reconnect.

Rollback: `--mode unseal --apply` (needs the same key), then `supabase/connectors-hardening-rollback.sql` if the app breaks. A rollback re-opens the owner-readable-tokens exposure, so treat it as temporary. Losing `CONNECTOR_TOKEN_KEY` after sealing makes tokens unreadable and users must reconnect.

## Unverified / blocked

- Production mapping (domain → Vercel project → deployment SHA → Supabase project) was not established: the connected Vercel account has no project or domain for this repo, and the repo's `VITE_SUPABASE_URL` points to a Supabase project that is not visible to the connected Supabase account.
- Live RLS, grants, advisors and `SECURITY DEFINER` functions: not read (no access to the production project).
- Whether the Vercel plan limits the number of functions: this branch adds four helper files under `api/lib/`, the same place as the existing helpers.
