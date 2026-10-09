# Connector security (OAuth state, token storage, revocation)

Status of each finding, what changed, and what is still a decision or unverified.
Evidence: `npm test` (79 tests, all 20 seeded faults caught), real-PostgreSQL probes below, and an independent review of the first version of this PR (findings and their fate in "Independent review").
**Nothing here was applied to any live database or deployment.**

## Findings

| ID | Finding | Status | What changed |
|----|---------|--------|--------------|
| F01 CRITICAL | OAuth `state` was unsigned Base64 JSON `{userId, provider}` | fixed in code | State is 32 random bytes, bound to the user **and to the browser that started the flow**, stored only as `sha256(state "." nonce)` in `oauth_states`, TTL 10 min, consumed by one atomic `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING`. User and provider come from that row, never from the URL (`api/lib/oauthState.js`, `api/lib/oauthFlow.js`). |
| F01b HIGH | *(found by the independent review)* Login-CSRF: a state bound only to the starting **user** lets an attacker start a flow with their own session and send the provider URL to a victim; the victim's tokens would be stored under the attacker's `user_id` | fixed in code | `google-start`/`microsoft-start` set an `HttpOnly; SameSite=Lax; Secure; Path=/api/connectors` cookie holding a random nonce; the callback needs it to find the row. A foreign browser does not even find the row, so it cannot burn the real flow. |
| F02 HIGH | Callback wrote tokens with the service role for a `userId` taken from the URL | fixed in code | Same change. A forged or legacy state is rejected before any provider call or write. |
| F03 HIGH | Tokens in plain `text` columns; the RLS policy also let a user read their own token columns through the Data API | fixed in code + SQL (not applied) | `supabase/connectors-hardening.sql` revokes all client access to `connectors` (also from `PUBLIC`) and re-grants `SELECT` on non-token columns plus `DELETE`. Optional AES-256-GCM at rest (`CONNECTOR_TOKEN_KEY`), row-bound AAD, plaintext still readable for gradual rollout. |
| F04 HIGH | Gmail scopes `send`, `compose`, `modify`; privacy page says "read-only" and "we do not request permission to send… or modify" | **decision needed, not changed** | See `docs/gmail-scopes.md`. A legal/product choice and a Google verification risk; no text was edited. |
| F05 HIGH | Existing refresh token kept when reconnecting, without checking it is the same Google account | fixed in code | Kept only if the new account e-mail equals the stored one (case-insensitive). |
| F06 MEDIUM | Microsoft callback ignored the upsert error | fixed in code | One shared flow for both providers; write errors end in `connector_error=save_failed`. |
| F07 MEDIUM | Disconnect did not revoke at the provider | fixed for Google, limited for Microsoft | Row deleted first, then the Google token is revoked (skipped when another connector of the same Google account still shares the grant, compared case-insensitively). Microsoft v2 has no refresh-token revocation endpoint; the response says `unsupported_provider`. |
| P6 | Refresh path | fixed in code | Rotated refresh tokens are stored (Microsoft rotates every time); `invalid_grant` marks the connector `revoked` instead of failing every call. |

Not changed on purpose: CORS `*` on `google-start` and `disconnect` (calls need a Bearer token; tighten to `APP_URL` if wanted); the `grant delete` for `authenticated` (the UI could delete a row directly and skip provider revocation; the alternative is to route every disconnect through `/api/connectors/disconnect`); raw `err.message` in a few 500 responses (pre-existing).

## Configuration (all optional; defaults keep today's behaviour)

| Variable | Meaning |
|----------|---------|
| `CONNECTOR_TOKEN_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Enables sealing of new tokens. Never in chat or git; keep a copy outside Vercel (losing it after sealing means every user must reconnect). A malformed key makes the connect flow answer 503 **before** the user consents; it never affects reading plaintext rows. |
| `CONNECTOR_TOKEN_SEAL=off` | Stop writing sealed values (existing sealed values stay readable). First step of any rollback after sealing. |
| `CONNECTOR_TOKEN_REQUIRE_KEY=1` | Refuse to start a connect flow or store a token without a valid key, so a variable missing in one environment cannot silently produce plaintext rows. Recommended once sealing is on. |
| `APP_URL` | Already required. `https://` makes the nonce cookie `Secure`. |

## SQL evidence (real PostgreSQL, Supabase-like roles)

Throwaway cluster, roles `anon` / `authenticated` / `service_role`, non-superuser owner, `auth.uid()`, default Supabase `grant all` privileges, `supabase/connectors.sql` applied first. Re-run on PostgreSQL 16.15 for this revision (earlier revision: 18.4; production is 17, the same `GRANT`/`REVOKE` semantics).

| Probe | Before | After |
|-------|--------|-------|
| `authenticated`: `select access_token` (own row) | allowed | permission denied |
| `authenticated`: `select *` (also what `select('*', {count, head})` expands to) | allowed, tokens included | permission denied |
| `authenticated`: `count(id) … where status = 'connected'` (admin Overview, now `select('id')`) | allowed | allowed |
| `authenticated`: `select id, provider, account_email, status, scopes …` (what the UI uses) | allowed | allowed |
| `authenticated`: update | RLS blocks other rows | permission denied |
| `authenticated`: delete own row | allowed | allowed |
| `anon` / `authenticated`: `oauth_states` | n/a | permission denied |
| `service_role`: write `connectors`, insert/read `oauth_states` | allowed | allowed (explicit grants) |
| 8 connections consuming one state at once, 25 rounds | n/a | exactly one winner every round |
| migration applied twice / rollback / re-apply | n/a | no error / verdict FAIL / verdict PASS |

`supabase/verify-connectors-hardening.sql` is one result set: 30 checks plus a `== VERDICT ==` row. Before the migration it reports `18 failing of 28`, after it `0 failing of 30`. It uses `has_column_privilege`/ACL catalogs, so the answer does not depend on the role running it. Negative tests: `GRANT SELECT … TO PUBLIC`, a view over `connectors` and a column grant of `refresh_token` to `authenticated` each turn the verdict to FAIL.
`supabase/verify-token-encryption.sql` shows sealing progress (counts only).

## Compatibility of the order of deployment

| Situation | Result |
|-----------|--------|
| New code deployed **before** the SQL | `google-start` / `microsoft-start` answer 503 `OAuth state store unavailable` (fail closed). Existing connections and chat tools keep working. A callback carrying an old unsigned state ends in `connector_error=invalid_state`. |
| SQL applied **before** the new code | The code that is live today keeps working (it reads explicit columns; the service role is unaffected). Only the admin Overview "Active connectors" card shows "—" until this code is deployed. |
| Key set while an environment that shares the database runs code without the key | That environment cannot read sealed rows (`token_key_missing`). Set the key in **every** environment that shares the database (Production, Preview, Development) or none. |
| Rolled back to the old code after sealing | The old code sends `enc:v1:…` as a bearer token; every Google/Microsoft call fails until tokens are unsealed. See rollback. |

## Rollout (nothing is applied by this PR)

1. Confirm which Supabase project the production site really uses (see "Unverified"). Read the policies of `connectors` there; the SQL assumes the repo's `supabase/connectors.sql`.
2. Backup / point-in-time marker.
3. Run `supabase/connectors-hardening.sql` (3 s `lock_timeout`: if it aborts on a lock, run it again). Run `supabase/verify-connectors-hardening.sql`: the last row must read `PASS`.
4. Deploy this branch with `CONNECTOR_TOKEN_KEY` **unset**.
5. Smoke test: connect Google, connect Microsoft, ask for a Gmail search, wait for a token refresh if possible, disconnect, reconnect.
6. Optional encryption: back up a new key outside Vercel, set `CONNECTOR_TOKEN_KEY` and `CONNECTOR_TOKEN_REQUIRE_KEY=1` in all environments, redeploy, run `node scripts/rewrite-connector-tokens.mjs --mode seal` (dry run), then `--apply`, repeat until `conflicts=0`; check `verify-token-encryption.sql`.

## Rollback

| What went wrong | Do |
|-----------------|----|
| New code misbehaves, nothing sealed yet | Vercel rollback to the previous deployment. The SQL can stay (old code is compatible). |
| New code misbehaves after sealing (**one-way door unless done in this order**) | 1. Set `CONNECTOR_TOKEN_SEAL=off` in every environment and redeploy (new writes become plaintext, sealed rows stay readable). 2. `node scripts/rewrite-connector-tokens.mjs --mode unseal --apply` until `conflicts=0` and `verify-token-encryption.sql` shows 0 sealed. 3. Only then roll the code back or remove the key. Keep the key until step 2 is finished. |
| Something client-side breaks after the SQL | Prefer fixing the query (use explicit columns). `supabase/connectors-hardening-rollback.sql` re-opens F03 (users can read their own tokens again) and takes ~no locks. |

Provider-side revocation of a Google grant cannot be undone: the user reconnects.

## Independent review of the first version of this PR

A reviewer who had not seen this analysis read the diff and ran it against PostgreSQL 16. Result: no blocker; items below. Labels: V = reproduced by the reviewer.

| # | Finding | Fate |
|---|---------|------|
| 1 high (V) | Login-CSRF, state not bound to the browser | fixed (F01b) |
| 2 high (V) | Sealing is a one-way door; documented rollback order omitted the code | fixed: `CONNECTOR_TOKEN_SEAL=off`, rollback order above |
| 3 medium (V) | Malformed key broke reading plaintext; unset key silently stored plaintext | fixed: lazy key, precheck before consent, warning log, `CONNECTOR_TOKEN_REQUIRE_KEY` |
| 4 medium (V/partial) | Admin Overview `select('*', {count, head})` is denied after the migration | fixed: counts `id` (PostgREST itself was not run) |
| 5 medium (V) | Verify script proved less than it claimed (PUBLIC grants, views, role dependence) | fixed: rewritten, negative tests above |
| 6 medium (V) | Handler wiring untested (5 mutants survived) | fixed: handlers are now factories with fake-`req/res` tests; 20 of 20 seeded faults are caught (the thin bindings in `api/connectors/` are checked statically) |
| 7 low | UI ignored `revoked`/`connector_error` | fixed in the UI: revoked connectors are listed under "Needs reconnecting" with a Reconnect button, `connector_error` codes show a readable message (unknown codes are shown only if they match `[A-Za-z0-9_.-]{1,64}`). Verified in Chromium against a stubbed REST call (22 checks, no real OAuth) |
| 7b low | Client-side `DELETE` on `connectors` skips provider revocation | open (decision: move disconnect behind the API, or accept) |
| 8 low (V) | No `lock_timeout` | fixed (3 s) |
| 9 low (V) | `service_role` on `oauth_states` relied on default privileges | fixed (explicit grants) |
| 10 low (V) | `provider=constructor` etc. passed the prototype lookup | fixed (`Object.hasOwn`), per-user rate limit on start |
| 11 low (V) | Shared-grant check was case-sensitive | fixed |
| 12 low | Rollback SQL grants ALL | kept, documented as temporary |
| 13 info | Docs said "four helper files"; compare-and-set puts tokens in the URL; no key rotation | docs corrected; key rotation not implemented (single `enc:v1`, no key id) |
| 14 info | Raw `err.message` in a few 500 responses | pre-existing, open |

## Unverified / blocked

- Production mapping (domain → Vercel project → deployment SHA → Supabase project): the connected Vercel account has no project or domain for this repo and the connected Supabase account does not contain `ypzrczwyfvqlydeocbmm`, the project named in the repo's committed `.env`.
- Live RLS, policies, default privileges, advisors and `SECURITY DEFINER` functions in production: not read (no access).
- Real PostgREST: status codes and the `head`-count query shape are inferred; Google's revoke endpoint was not called; the Supabase SQL editor with multi-statement scripts was not run.
- Vercel function-count limits: this change adds six files under `api/lib/` (the base already has 22 files under `api/`).
