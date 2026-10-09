// Server-held approvals for irreversible actions with third-party effects (audit finding F09): Gmail send / reply /
// forward, Google Calendar events that invite or notify guests (create, update, cancel), and comments on shared
// Drive files.
//
// Problem: `user_confirmed` is an argument the MODEL supplies, so checking it proves nothing about the user.
//
// Design: when the model asks to send / reply / forward, nothing is sent. The exact arguments are stored in
// `approval_requests` (service role only) and the signed-in user is shown a Confirm card with those exact
// fields. Only `POST /api/approve-action {id}` from that user can release the action, and it executes the
// STORED arguments - the model never holds a token or any other capability, and cannot change what is sent.
// Release is one atomic `DELETE ... WHERE id AND user_id AND expires_at > now() RETURNING`, so a request is
// single use by construction (a double click, a replay or two tabs: exactly one wins, at-most-once delivery).
import { createHash, randomUUID } from 'node:crypto';

export const APPROVAL_TTL_MS = 10 * 60 * 1000; // time the user has to press Confirm
export const MAX_PENDING_PER_USER = 10; // stops a looping model from piling up cards
const CLEANUP_AFTER_MS = 60 * 60 * 1000;

// The arguments that define "what the user approved", per action. Anything else the model adds is dropped.
const FIELDS = {
  send_email: ['to', 'cc', 'bcc', 'subject', 'body'],
  reply_email: ['message_id', 'reply_all', 'cc', 'bcc', 'body'],
  forward_email: ['message_id', 'to', 'cc', 'bcc', 'body'],
  create_calendar_event: ['summary', 'start', 'end', 'all_day', 'time_zone', 'location', 'description', 'attendees'],
  // Added after the first version of this gate, when upstream added tools that reach the same third parties:
  update_calendar_event: ['event_id', 'summary', 'description', 'location', 'start', 'end', 'all_day', 'time_zone', 'attendees', 'add_attendees', 'remove_attendees', 'notify'],
  delete_calendar_event: ['event_id', 'notify'],
  add_file_comment: ['file_id', 'comment', 'cell'],
  reply_to_file_comment: ['file_id', 'comment_id', 'reply', 'resolve'],
};
// For these actions an ABSENT field means "leave it alone" and an empty string means "clear it" (updateCalendarEvent
// distinguishes undefined from ''), so normalization keeps only the fields the model really sent.
const PARTIAL = new Set(['update_calendar_event', 'delete_calendar_event']); // delete: an absent notify means "e-mail the guests", false means "do not"
const BOOL_FIELDS = new Set(['reply_all', 'all_day', 'notify', 'resolve']); // true only for the boolean true, never for a truthy string
const LIST_FIELDS = new Set(['attendees', 'add_attendees', 'remove_attendees']); // canonical form: unique, trimmed, lower-case e-mail addresses
const REQUIRED = {
  send_email: ['to', 'subject', 'body'], // sendGmail() refuses an empty subject: refuse it now, not after the user pressed Confirm
  reply_email: ['message_id', 'body'],
  forward_email: ['message_id', 'to'],
  create_calendar_event: ['summary', 'start', 'attendees'],
  update_calendar_event: ['event_id'],
  delete_calendar_event: ['event_id'],
  add_file_comment: ['file_id', 'comment'],
  reply_to_file_comment: ['file_id', 'comment_id'],
};
// What an update may change (event_id says which event; notify only says whether to e-mail about a change).
const UPDATE_CHANGES = ['summary', 'description', 'location', 'start', 'end', 'all_day', 'time_zone', 'attendees', 'add_attendees', 'remove_attendees'];
const MAX_LEN = {
  to: 2000, cc: 2000, bcc: 2000, subject: 998, body: 200_000, message_id: 128,
  summary: 1024, start: 64, end: 64, time_zone: 64, location: 1024, description: 8000,
  event_id: 1024, file_id: 256, comment_id: 128, comment: 8000, reply: 8000, cell: 128,
};
const DATE_FIELDS = ['start', 'end']; // must parse, so a bad value is refused now and not after the user pressed Confirm
export const MAX_ATTENDEES = 20;
export const MAX_RECIPIENTS = 50; // per field (to / cc / bcc)
const EMAIL_RE = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;
const ADDRESS_ASCII_RE = /^[\x21-\x7e]+$/; // addresses are shown and sent as plain ASCII: no homoglyphs, no bidi tricks, no spaces
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// Calendar event ids (also recurring instances, "<id>_<timestamp>") and Drive file / comment ids.
const ID_RE = { event_id: /^[A-Za-z0-9_-]{1,1024}$/, file_id: /^[A-Za-z0-9_-]{5,256}$/, comment_id: /^[A-Za-z0-9_-]{1,128}$/ };
// The card must show exactly what is sent. A control character (CR/LF above all) in a single-line field becomes a
// new MIME header ("Subject: x\r\nBcc: attacker@..."), and bidi overrides / invisible joiners reorder or hide text.
const CONTROL_SINGLE_LINE_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_MULTI_LINE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/; // body / description keep \t \n \r
const DECEPTIVE_RE = /[\u202a-\u202e\u2066-\u2069\u2060-\u2064\ufeff]/;
const MULTI_LINE_FIELDS = new Set(['body', 'description', 'comment', 'reply']);
const RECIPIENT_FIELDS = new Set(['to', 'cc', 'bcc']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const APPROVABLE_ACTIONS = Object.keys(FIELDS);

const fail = (code, message) => Object.assign(new Error(message || code), { code });

/**
 * The guests a create_calendar_event call would really invite: exactly what createCalendarEvent() keeps (an array,
 * strings turned into {email}, entries without an email dropped). The gate and the executor must agree on this.
 */
export function guestEntries(list) {
  if (!Array.isArray(list)) return [];
  return list.map((a) => (typeof a === 'string' ? { email: a } : a)).filter((a) => a?.email);
}
export function attendeeEntries(input) {
  return guestEntries(input?.attendees);
}

/** One plain, ASCII e-mail address (what the card shows and the MIME encoder receives). */
export function isPlainAddress(value) {
  const v = String(value ?? '');
  return v.length > 0 && v.length <= 254 && ADDRESS_ASCII_RE.test(v) && EMAIL_RE.test(v);
}

/**
 * to / cc / bcc: a comma or semicolon separated list of "addr" or "Name <addr>", reduced to unique bare addresses.
 * Anything else (a display name that contains an address, control or non-ASCII characters) is refused, so the card
 * shows the real recipients and nobody can hide one in a header.
 */
function normalizeRecipients(raw, field) {
  const text = String(raw ?? '');
  const seen = new Map();
  for (const part of text.split(/[,;]/)) {
    const piece = part.trim();
    if (!piece) continue;
    const named = /^(?:"[^"<>@,;\\]*"|[^<>"@,;()\\]*)\s*<([^<>\s]+)>$/.exec(piece);
    const addr = (named ? named[1] : piece).trim();
    if (!isPlainAddress(addr)) {
      throw fail('invalid_args', `${field} must contain plain e-mail addresses separated by commas (a display name must not contain an address; ASCII only)`);
    }
    const key = addr.toLowerCase();
    if (!seen.has(key)) seen.set(key, addr);
  }
  if (seen.size > MAX_RECIPIENTS) throw fail('invalid_args', `${field} has more than ${MAX_RECIPIENTS} addresses`);
  return [...seen.values()].join(', ');
}

function normalizeGuestList(list, field) {
  const seen = new Set();
  for (const entry of guestEntries(list)) {
    const email = String(entry.email).trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) throw fail('invalid_args', `${field} contains an invalid e-mail address`);
    seen.add(email);
  }
  if (seen.size > MAX_ATTENDEES) throw fail('invalid_args', `${field} has more than ${MAX_ATTENDEES} addresses`);
  return [...seen];
}

/** Canonical, validated arguments: exactly what is shown, stored and executed. Throws {code:'invalid_args'|'not_approvable'}. */
export function normalizeArgs(action, args) {
  const fields = Object.hasOwn(FIELDS, action) ? FIELDS[action] : null;
  if (!fields) throw fail('not_approvable', `action is not approvable: ${String(action)}`);
  const a = args && typeof args === 'object' ? args : {};
  const out = {};
  for (const f of fields) {
    if (PARTIAL.has(action) && (a[f] === undefined || (BOOL_FIELDS.has(f) && typeof a[f] !== 'boolean'))) continue; // a flag that is not a real boolean is as good as absent
    if (BOOL_FIELDS.has(f)) out[f] = a[f] === true;
    else if (LIST_FIELDS.has(f)) {
      if (PARTIAL.has(action) && !Array.isArray(a[f])) continue; // the executor ignores anything that is not an array
      out[f] = normalizeGuestList(a[f], f);
    } else {
      const raw = String(a[f] ?? '');
      if (raw.length > MAX_LEN[f]) throw fail('invalid_args', `${f} is too long`); // before any scanning of a huge value
      if ((MULTI_LINE_FIELDS.has(f) ? CONTROL_MULTI_LINE_RE : CONTROL_SINGLE_LINE_RE).test(raw) || DECEPTIVE_RE.test(raw)) {
        throw fail('invalid_args', `${f} contains control or invisible formatting characters`);
      }
      out[f] = RECIPIENT_FIELDS.has(f) ? normalizeRecipients(raw, f) : raw;
      if (f === 'message_id' && out[f] && !MESSAGE_ID_RE.test(out[f])) throw fail('invalid_args', 'message_id is not a valid message id');
      if (ID_RE[f] && out[f] && !ID_RE[f].test(out[f])) throw fail('invalid_args', `${f} is not a valid id`);
    }
  }
  for (const f of REQUIRED[action]) {
    const v = out[f] ?? '';
    if (Array.isArray(v) ? v.length === 0 : !String(v).trim()) throw fail('invalid_args', `${f} is required`);
  }
  if (action === 'update_calendar_event' && !UPDATE_CHANGES.some((f) => out[f] !== undefined)) throw fail('invalid_args', 'nothing to update: no field to change was given');
  if (action === 'reply_to_file_comment' && !out.reply.trim() && out.resolve !== true) throw fail('invalid_args', 'reply is required unless the thread is only being resolved');
  for (const f of DATE_FIELDS) {
    if (fields.includes(f) && out[f] && !Number.isFinite(Date.parse(out[f]))) throw fail('invalid_args', `${f} is not a valid date`);
  }
  return out;
}

export function digestArgs(action, args) {
  return createHash('sha256').update(JSON.stringify({ action, args: normalizeArgs(action, args) })).digest('hex');
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Store a pending approval and return what the UI must show. Identical open requests are reused (a model that
 * repeats the call must not stack cards). Throws {code: invalid_args | not_approvable | too_many_pending |
 * approval_store_unavailable}.
 */
export async function createPending(opts) {
  const { userId } = opts || {};
  if (typeof userId !== 'string' || !userId) throw fail('invalid_args', 'userId is required');
  // The model may issue many tool calls at once (chat.js runs them with Promise.all). The "count open, then insert"
  // below is not atomic in the database, so calls of one user are queued one after the other in this process.
  // Other server instances can still overlap; the overshoot is bounded by the instances serving one user at a time.
  const previous = creating.get(userId) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => createPendingNow(opts));
  const tail = run.catch(() => {}).then(() => { if (creating.get(userId) === tail) creating.delete(userId); });
  creating.set(userId, tail);
  return run;
}
const creating = new Map();

async function createPendingNow({ admin, userId, action, args, now = Date.now() }) {
  const normalized = normalizeArgs(action, args);
  const digest = digestArgs(action, normalized);
  const nowIso = iso(now);

  const open = await admin.from('approval_requests').select('id, digest, expires_at').eq('user_id', userId).gt('expires_at', nowIso);
  if (open.error) throw fail('approval_store_unavailable');
  const same = (open.data || []).find((r) => r.digest === digest);
  if (same) return { id: same.id, expiresAt: new Date(same.expires_at).getTime(), args: normalized, reused: true };
  if ((open.data || []).length >= MAX_PENDING_PER_USER) throw fail('too_many_pending');

  const id = randomUUID();
  const expiresAt = now + APPROVAL_TTL_MS;
  const ins = await admin.from('approval_requests').insert({
    id, user_id: userId, action, digest, args: normalized, expires_at: iso(expiresAt),
  });
  if (ins.error) throw fail('approval_store_unavailable');
  try {
    await admin.from('approval_requests').delete().lt('expires_at', iso(now - CLEANUP_AFTER_MS)); // housekeeping, best effort
  } catch { /* ignore */ }
  return { id, expiresAt, args: normalized, reused: false };
}

/**
 * Release (approve) or discard (reject) a pending request. Atomic and single use: the row is DELETEd with the
 * owner and expiry in the WHERE clause, and only the caller that gets the row back may act on it.
 * Returns { ok: true, decision, action, args, digest } or { ok: false, reason: not_found | expired | corrupt | store_unavailable }.
 */
export async function decidePending({ admin, userId, id, decision, now = Date.now() }) {
  if (decision !== 'approve' && decision !== 'reject') return { ok: false, reason: 'not_found' };
  if (typeof userId !== 'string' || !userId || typeof id !== 'string' || !UUID_RE.test(id)) return { ok: false, reason: 'not_found' };
  const nowIso = iso(now);
  const got = await admin
    .from('approval_requests')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .gt('expires_at', nowIso)
    .select('action, args, digest')
    .maybeSingle();
  if (got.error) return { ok: false, reason: 'store_unavailable' };
  if (!got.data) {
    // Tell "ran out of time" apart from "never existed / already used / not yours" (best effort, owner only).
    const stale = await admin.from('approval_requests').select('id').eq('id', id).eq('user_id', userId).maybeSingle();
    if (stale.data) {
      await admin.from('approval_requests').delete().eq('id', id).eq('user_id', userId);
      return { ok: false, reason: 'expired' };
    }
    return { ok: false, reason: 'not_found' };
  }
  const { action, args, digest } = got.data;
  if (decision === 'reject') return { ok: true, decision, action, args, digest };
  // The stored arguments must still be what was digested when the card was created.
  let again;
  try { again = digestArgs(action, args); } catch { return { ok: false, reason: 'corrupt' }; }
  if (again !== digest) return { ok: false, reason: 'corrupt' };
  return { ok: true, decision, action, args: normalizeArgs(action, args), digest };
}

export const DECISION_MESSAGES = {
  not_found: 'This request does not exist any more (already used, cancelled or not yours). Ask the assistant to prepare it again.',
  expired: 'This request expired. Ask the assistant to prepare it again.',
  corrupt: 'This request could not be verified and was discarded. Ask the assistant to prepare it again.',
  store_unavailable: 'Approvals are temporarily unavailable. Nothing was sent or changed.',
};
