import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeArgs, digestArgs, createPending, decidePending, APPROVABLE_ACTIONS, APPROVAL_TTL_MS, MAX_PENDING_PER_USER,
} from '../api/lib/approvals.js';
import { makeApprovalDb } from './helpers/fakeApprovalDb.mjs';

const T0 = 1_800_000_000_000;
const SEND = { to: 'bob@example.com', subject: 'Hi', body: 'Hello Bob', cc: '', bcc: '' };
const mk = (db, over = {}) => createPending({ admin: db, userId: 'u1', action: 'send_email', args: SEND, now: T0, ...over });

test('normalizeArgs keeps exactly the fields of the action and drops everything else', () => {
  const a = normalizeArgs('send_email', { ...SEND, user_confirmed: true, approval_token: 'x', evil: 1 });
  assert.deepEqual(Object.keys(a).sort(), ['bcc', 'body', 'cc', 'subject', 'to']);
  assert.deepEqual(normalizeArgs('reply_email', { message_id: 'm1', body: 'ok', reply_all: 'yes' }), { message_id: 'm1', reply_all: false, cc: '', bcc: '', body: 'ok' });
  assert.equal(normalizeArgs('reply_email', { message_id: 'm1', body: 'ok', reply_all: true }).reply_all, true);
  assert.deepEqual(normalizeArgs('forward_email', { message_id: 'm1', to: 'x@y.z' }), { message_id: 'm1', to: 'x@y.z', cc: '', bcc: '', body: '' });
  assert.deepEqual([...APPROVABLE_ACTIONS].sort(), ['add_file_comment', 'create_calendar_event', 'delete_calendar_event', 'forward_email', 'reply_email', 'reply_to_file_comment', 'send_email', 'update_calendar_event']);
});

test('normalizeArgs rejects missing required fields, oversize values and non-approvable actions', () => {
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no error'; };
  assert.equal(code(() => normalizeArgs('send_email', { subject: 's', body: 'b' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('send_email', { to: '  ', body: 'b' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('send_email', { to: 'a@b.c', body: '' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('reply_email', { body: 'b' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('forward_email', { message_id: 'm' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('send_email', { ...SEND, body: 'x'.repeat(200_001) })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('send_email', { ...SEND, subject: 'x'.repeat(999) })), 'invalid_args');
  for (const bad of ['trash_email', 'constructor', '__proto__', undefined, '']) assert.equal(code(() => normalizeArgs(bad, SEND)), 'not_approvable', String(bad));
  assert.equal(code(() => normalizeArgs('send_email', null)), 'invalid_args');
});

test('digest depends on the action and on every shown field, not on extras', () => {
  const base = digestArgs('send_email', SEND);
  assert.equal(base, digestArgs('send_email', { ...SEND, user_confirmed: true, junk: 'x' }));
  const changed = { to: 'other@example.com', cc: 'cc2@example.com', bcc: 'bcc2@example.com', subject: SEND.subject + 'x', body: SEND.body + 'x' };
  for (const f of Object.keys(changed)) assert.notEqual(base, digestArgs('send_email', { ...SEND, [f]: changed[f] }), f);
  assert.notEqual(digestArgs('reply_email', { message_id: 'm', body: 'b' }), digestArgs('forward_email', { message_id: 'm', body: 'b', to: 'x@y.zz' }));
});

test('createPending stores the canonical content for this user only, with a 10 minute life', async () => {
  const db = makeApprovalDb();
  const p = await mk(db);
  assert.match(p.id, /^[0-9a-f-]{36}$/);
  assert.equal(p.expiresAt, T0 + APPROVAL_TTL_MS);
  assert.equal(p.reused, false);
  const [row] = db.tables.approval_requests;
  assert.equal(row.user_id, 'u1');
  assert.equal(row.action, 'send_email');
  assert.deepEqual(row.args, normalizeArgs('send_email', SEND));
  assert.equal(row.digest, digestArgs('send_email', SEND));
  assert.equal(new Date(row.expires_at).getTime(), T0 + APPROVAL_TTL_MS);
});

test('an identical open request is reused instead of stacking cards; a different one is a new card', async () => {
  const db = makeApprovalDb();
  const a = await mk(db);
  const b = await mk(db, { args: { ...SEND, user_confirmed: true } });
  assert.equal(b.id, a.id);
  assert.equal(b.reused, true);
  const c = await mk(db, { args: { ...SEND, to: 'attacker@evil.example' } });
  assert.notEqual(c.id, a.id);
  assert.equal(db.tables.approval_requests.length, 2);
  // another user with identical content gets their own request
  const d = await mk(db, { userId: 'u2' });
  assert.notEqual(d.id, a.id);
});

test('an expired identical request is not reused', async () => {
  const db = makeApprovalDb();
  const a = await mk(db);
  const b = await mk(db, { now: T0 + APPROVAL_TTL_MS + 1 });
  assert.notEqual(a.id, b.id);
});

test('at most MAX_PENDING_PER_USER open requests per user', async () => {
  const db = makeApprovalDb();
  for (let i = 0; i < MAX_PENDING_PER_USER; i++) await mk(db, { args: { ...SEND, subject: `s${i}` } });
  await assert.rejects(mk(db, { args: { ...SEND, subject: 'one too many' } }), { code: 'too_many_pending' });
  await mk(db, { userId: 'u2' }); // other users are not affected
});

test('createPending fails closed: store errors, invalid arguments, unknown actions', async () => {
  await assert.rejects(mk(makeApprovalDb({ fail: { 'approval_requests.insert': true } })), { code: 'approval_store_unavailable' });
  await assert.rejects(mk(makeApprovalDb({ fail: { 'approval_requests.select': true } })), { code: 'approval_store_unavailable' });
  await assert.rejects(mk(makeApprovalDb(), { args: { to: 'a@b.c' } }), { code: 'invalid_args' });
  await assert.rejects(mk(makeApprovalDb(), { action: 'trash_email' }), { code: 'not_approvable' });
  await assert.rejects(mk(makeApprovalDb(), { userId: '' }), { code: 'invalid_args' });
});

test('housekeeping removes requests that expired more than an hour ago', async () => {
  const db = makeApprovalDb();
  db.tables.approval_requests.push({ id: 'old', user_id: 'u9', action: 'send_email', digest: 'd', args: {}, expires_at: new Date(T0 - 2 * 3600_000).toISOString() });
  await mk(db);
  assert.ok(!db.tables.approval_requests.some((r) => r.id === 'old'));
});

// ---- release
test('approve returns the STORED arguments and is single use', async () => {
  const db = makeApprovalDb();
  const p = await mk(db);
  const d = await decidePending({ admin: db, userId: 'u1', id: p.id, decision: 'approve', now: T0 + 1000 });
  assert.equal(d.ok, true);
  assert.equal(d.action, 'send_email');
  assert.deepEqual(d.args, normalizeArgs('send_email', SEND));
  assert.equal(db.tables.approval_requests.length, 0, 'the row (and the email body) is gone after release');
  assert.deepEqual(await decidePending({ admin: db, userId: 'u1', id: p.id, decision: 'approve', now: T0 + 2000 }), { ok: false, reason: 'not_found' });
});

test('8 concurrent approvals of one request: exactly one gets the content', async () => {
  const db = makeApprovalDb();
  const p = await mk(db);
  const r = await Promise.all(Array.from({ length: 8 }, () => decidePending({ admin: db, userId: 'u1', id: p.id, decision: 'approve', now: T0 + 5 })));
  assert.equal(r.filter((x) => x.ok).length, 1);
});

test('another user cannot release or discard it, and the owner still can afterwards', async () => {
  const db = makeApprovalDb();
  const p = await mk(db);
  for (const decision of ['approve', 'reject']) {
    assert.deepEqual(await decidePending({ admin: db, userId: 'u2', id: p.id, decision, now: T0 + 1 }), { ok: false, reason: 'not_found' });
  }
  assert.equal(db.tables.approval_requests.length, 1);
  assert.equal((await decidePending({ admin: db, userId: 'u1', id: p.id, decision: 'approve', now: T0 + 2 })).ok, true);
});

test('an expired request cannot be released and is removed', async () => {
  const db = makeApprovalDb();
  const p = await mk(db);
  assert.deepEqual(await decidePending({ admin: db, userId: 'u1', id: p.id, decision: 'approve', now: T0 + APPROVAL_TTL_MS }), { ok: false, reason: 'expired' });
  assert.equal(db.tables.approval_requests.length, 0);
  assert.equal((await decidePending({ admin: db, userId: 'u1', id: (await mk(db, { now: T0 + 10 })).id, decision: 'approve', now: T0 + APPROVAL_TTL_MS + 9 })).ok, true, 'just inside the lifetime is accepted');
});

test('reject discards the request without returning content to execute', async () => {
  const db = makeApprovalDb();
  const p = await mk(db);
  const d = await decidePending({ admin: db, userId: 'u1', id: p.id, decision: 'reject', now: T0 + 1 });
  assert.equal(d.ok, true);
  assert.equal(d.decision, 'reject');
  assert.equal(db.tables.approval_requests.length, 0);
  assert.equal((await decidePending({ admin: db, userId: 'u1', id: p.id, decision: 'approve', now: T0 + 2 })).ok, false, 'cannot approve after cancel');
});

test('a row whose content no longer matches its digest is discarded, not executed', async () => {
  const db = makeApprovalDb();
  const p = await mk(db);
  db.tables.approval_requests[0].args.to = 'attacker@evil.example'; // tampering in the store
  assert.deepEqual(await decidePending({ admin: db, userId: 'u1', id: p.id, decision: 'approve', now: T0 + 1 }), { ok: false, reason: 'corrupt' });
  assert.equal(db.tables.approval_requests.length, 0);
});

test('malformed ids, decisions and users are rejected before the database', async () => {
  const db = makeApprovalDb();
  for (const id of [undefined, null, '', 'x', '1; drop table', 123, ['a'], '0'.repeat(35)]) {
    assert.deepEqual(await decidePending({ admin: db, userId: 'u1', id, decision: 'approve', now: T0 }), { ok: false, reason: 'not_found' });
  }
  assert.equal(db.calls.length, 0, 'a malformed id never reaches the database (a uuid column would answer 503, not 404)');
  const real = await mk(db);
  const n = db.calls.length;
  for (const decision of [undefined, 'APPROVE', 'yes', '', null]) {
    assert.equal((await decidePending({ admin: db, userId: 'u1', id: real.id, decision, now: T0 })).ok, false);
  }
  assert.equal((await decidePending({ admin: db, userId: '', id: real.id, decision: 'approve', now: T0 })).ok, false);
  assert.equal(db.calls.length, n, 'bad decisions never reach the database');
});

test('a stored row with extra, unshown fields releases only the canonical fields (defence in depth)', async () => {
  const db = makeApprovalDb();
  const p = await mk(db);
  db.tables.approval_requests[0].args.attachments = ['/etc/passwd']; // a field that was never shown on the card
  db.tables.approval_requests[0].args.user_confirmed = true;
  const r = await decidePending({ admin: db, userId: 'u1', id: p.id, decision: 'approve', now: T0 + 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.args).sort(), ['bcc', 'body', 'cc', 'subject', 'to']);
});

test('store errors on release are reported and nothing is executed', async () => {
  const db = makeApprovalDb();
  const p = await mk(db);
  db.calls.length = 0;
  const failing = makeApprovalDb({ fail: { 'approval_requests.delete': true } });
  failing.tables.approval_requests.push(...db.tables.approval_requests);
  assert.deepEqual(await decidePending({ admin: failing, userId: 'u1', id: p.id, decision: 'approve', now: T0 + 1 }), { ok: false, reason: 'store_unavailable' });
});
