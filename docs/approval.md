# Server-side approval for irreversible actions (audit finding F09)

`send_email`, `reply_email` and `forward_email` used to be guarded by `input.user_confirmed === true`. That value is an
argument **the model supplies**, so it is not evidence that the user agreed to anything (prompt injection in a received
e-mail can make the model set it). The first version of this branch (HMAC tokens) did not close F09 either: no Confirm UI,
no single use, and `legacy` was the default.

**Nothing here was applied to any live database or deployment.**

## Design

```
model calls send_email(...)            nothing is sent
  -> runTool -> gateIrreversible        stores the exact, normalized arguments in public.approval_requests (service role only)
  -> SSE {status:"approval_required", approval:{id, action, fields, context, expires_at}}
  -> <ApprovalTray> shows a Confirm card: To / Cc / Bcc / Subject / body as plain text, countdown, Confirm, Cancel
  -> POST /api/approve-action {id, decision}   (Bearer = the signed-in user's Supabase token)
       approve: one atomic  DELETE ... WHERE id AND user_id AND expires_at > now() RETURNING
                -> executes the STORED arguments (never anything from the request) -> Gmail
       reject : same DELETE, nothing is executed
```

| Property | How it holds |
|----------|--------------|
| The model cannot send | In `server` mode (the default) `gateIrreversible` never returns "proceed". `user_confirmed` is ignored. The tool result says `NOT SENT YET`, so the model is told not to claim it was sent. |
| The user approves what is executed | The card shows the stored fields; the endpoint executes the stored row, not request data. A request body carrying `args` changes nothing (tested). A digest recheck (`corrupt`) discards a row altered in the store; unknown fields in a stored row are dropped. |
| Single use / at most once | The row is consumed by the same `DELETE ... RETURNING` that releases it: double click, replay and two tabs give exactly one winner. If Gmail then fails, the request is **not** retried; the user asks again. The UI says so honestly (a network error says "may or may not have been sent: check your Sent folder"). |
| Bound to the user | `user_id` is in the `WHERE`. Another signed-in user gets 404. |
| Short lived, bounded | 10 min TTL, max 10 open requests per user, identical open requests are reused instead of stacked, rows expired for more than 1 h are removed. |
| Not a CSRF target | No CORS headers; authentication is a bearer header, not a cookie. POST only; 30 requests/min/user. |
| Fail closed | No user, no streaming client (the card cannot be shown), card delivery failure, missing table, invalid arguments, unknown `APPROVAL_MODE`: all block with `is_error` and store nothing that could later be released without a card. |
| Content is not kept or logged | The row is deleted when the user decides. Audit log lines carry `id`, action and digest only; provider error text is reduced to the HTTP code. |
| No script injection | The body is rendered as text in a `<pre>`; no `innerHTML`. |

## Configuration

| Variable | Meaning |
|----------|---------|
| `APPROVAL_MODE` unset / `server` | Default. Everything above. |
| `APPROVAL_MODE=legacy` | **Emergency switch only.** The old behaviour: the model's own `user_confirmed === true` releases the action (F09 open). Every release is logged: `[approval] APPROVAL_MODE=legacy ... (F09 open)`. |
| any other value | Blocks all three actions. |

No new secret is needed (the earlier `APPROVAL_SECRET` is gone).

## Evidence

* `npm test`: 51 tests (approval store, gate, endpoint, real `runTool` with Gmail stubbed, static wiring of chat stream / tool schemas / front end). No test sends anything.
* Mutation check on this branch's code: 45 seeded faults, 43 caught. The two survivors are equivalent: `digest ignores action` (field sets differ per action, so two actions can never produce the same canonical arguments) and `no-user check removed` (`createPending` rejects an empty user id before any database call).
  Surviving mutants found weak spots that were fixed: a test asserting nothing about database calls for malformed ids, no assertion that a non-interactive call stores no orphan row, no test of extra stored fields, and **a real leak: the provider error text (which can echo the message) was written to the server log** (now only the HTTP code).
* Browser check (Chromium, Playwright, phone width 390 px, light and dark): 20/20 checks. Three cards, a repeated id shown once; an HTML/`<script>` body rendered as text with no side effect; Confirm and Cancel disabled while a request is in flight; a double click sends one POST; the POST body is exactly `{id, decision}` with the bearer token; sent / failed / expired / cancelled / network-error states; countdown disables Confirm at 0; no horizontal scroll. This used the card component with the endpoint stubbed, **not** the whole app signed in against Supabase and Gmail.
* Real PostgreSQL 16.15 with Supabase-like roles (throwaway cluster): `approval-requests.sql` applies twice without error; `verify-approval-requests.sql` returns `0 failing of 20`; `anon` and `authenticated` get `permission denied` for select and insert; `service_role` can insert and read; a row with an unknown action violates the check constraint; 8 parallel `DELETE ... RETURNING` of one row, 25 rounds: exactly one winner every round. Negative tests of the verify script: `GRANT SELECT ... TO PUBLIC` -> `3 failing of 20`, `DISABLE ROW LEVEL SECURITY` -> `1 failing`, table absent -> `17 failing`.
* `tsc -b` and `vite build` pass.

## Deployment order

The code fails closed, so the order cannot cause an unintended send, but it decides whether sending works:

1. Backup / point-in-time marker. Confirm which Supabase project the production site really uses (not verified, see below).
2. Run `supabase/approval-requests.sql` (3 s `lock_timeout`; re-run if it aborts on a lock), then `supabase/verify-approval-requests.sql`: the last row must read `PASS`.
3. Deploy this branch. Smoke test with a test account: ask the assistant to send a mail to yourself, check that **nothing arrives before Confirm**, press Confirm once, check that it arrives once; press Cancel on another; let one expire.

| Situation | Result |
|-----------|--------|
| Code deployed **before** the SQL | Every send/reply/forward is blocked with "the approval store is unavailable (apply supabase/approval-requests.sql)". Nothing is sent, nothing else changes. |
| SQL applied before the code | Harmless: the table is unused. |
| Old front end + new API | The model's call is stored and the SSE event is ignored by the old UI: nothing can be confirmed, nothing is sent. |
| New front end + old API | The old API never emits the event; the tray stays empty. |

## Rollback

* Code: Vercel rollback to the previous deployment. The table can stay.
* `APPROVAL_MODE=legacy` re-opens F09 immediately without a deploy of old code. Use only knowingly, and only for a short time.
* `supabase/approval-requests-rollback.sql` drops the table. With the new code still deployed, sends are then blocked (fail closed).

## Still open (F09b) and not covered here

* Calendar invitations with attendees (they notify third parties), `modify_gmail` trash, and the daily digest cron (sent to the user's own address, composed by the server) do not go through this gate.
* The 10 minute window is a choice: shorter is safer, longer is friendlier.
* A real end-to-end run (signed in, real Gmail, real Supabase) was not possible here. PostgREST behaviour of `delete().select().maybeSingle()` (one row, `PGRST116` on several) is inferred from its documentation and from the SQL semantics, not run.
* Production mapping and live RLS/policies are unverified (no access), same as in the connector-security PR.
