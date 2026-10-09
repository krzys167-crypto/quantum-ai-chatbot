// Server-held approvals for irreversible actions with third-party effects (audit finding F09): Gmail send / reply /
// forward, and Google Calendar events that invite guests.
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
};
const BOOL_FIELDS = new Set(['reply_all', 'all_day']); // true only for the boolean true, never for a truthy string
const LIST_FIELDS = new Set(['attendees']); // canonical form: unique, trimmed, lower-case e-mail addresses
const REQUIRED = {
  send_email: ['to', 'body'],
  reply_email: ['message_id', 'body'],
  forward_email: ['message_id', 'to'],
  create_calendar_event: ['summary', 'start', 'attendees'],
};
const MAX_LEN = {
  to: 2000, cc: 2000, bcc: 2000, subject: 998, body: 200_000, message_id: 128,
  summary: 1024, start: 64, end: 64, time_zone: 64, location: 1024, description: 8000,
};
const DATE_FIELDS = ['start', 'end']; // must parse, so a bad value is refused now and not after the user pressed Confirm
export const MAX_ATTENDEES = 20;
const EMAIL_RE = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const APPROVABLE_ACTIONS = Object.keys(FIELDS);

const fail = (code, message) => Object.assign(new Error(message || code), { code });

/**
 * The guests a create_calendar_event call would really invite: exactly what createCalendarEvent() keeps (an array,
 * strings turned into {email}, entries without an email dropped). The gate and the executor must agree on this.
 */
export function attendeeEntries(input) {
  if (!Array.isArray(input?.attendees)) return [];
  return input.attendees.map((a) => (typeof a === 'string' ? { email: a } : a)).filter((a) => a?.email);
}

function normalizeAttendees(input) {
  const seen = new Set();
  for (const entry of attendeeEntries(input)) {
    const email = String(entry.email).trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) throw fail('invalid_args', 'attendees contains an invalid e-mail address');
    seen.add(email);
  }
  if (seen.size > MAX_ATTENDEES) throw fail('invalid_args', `attendees has more than ${MAX_ATTENDEES} addresses`);
  return [...seen];
}

/** Canonical, validated arguments: exactly what is shown, stored and executed. Throws {code:'invalid_args'|'not_approvable'}. */
export function normalizeArgs(action, args) {
  const fields = Object.hasOwn(FIELDS, action) ? FIELDS[action] : null;
  if (!fields) throw fail('not_approvable', `action is not approvable: ${String(action)}`);
  const a = args && typeof args === 'object' ? args : {};
  const out = {};
  for (const f of fields) {
    if (BOOL_FIELDS.has(f)) out[f] = a[f] === true;
    else if (LIST_FIELDS.has(f)) out[f] = normalizeAttendees(a);
    else out[f] = String(a[f] ?? '');
  }
  for (const f of REQUIRED[action]) {
    const v = out[f];
    if (Array.isArray(v) ? v.length === 0 : !v.trim()) throw fail('invalid_args', `${f} is required`);
  }
  for (const f of fields) {
    if (typeof out[f] === 'string' && out[f].length > MAX_LEN[f]) throw fail('invalid_args', `${f} is too long`);
  }
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
export async function createPending({ admin, userId, action, args, now = Date.now() }) {
  if (typeof userId !== 'string' || !userId) throw fail('invalid_args', 'userId is required');
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
  store_unavailable: 'Approvals are temporarily unavailable. Nothing was sent.',
};
