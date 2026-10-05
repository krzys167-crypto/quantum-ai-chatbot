import test from 'node:test';
import assert from 'node:assert/strict';
import { createApproval, verifyApproval, digestArgs } from '../api/lib/approval.js';
import { guardIrreversible, approvalMode } from '../api/lib/sendGuard.js';

const SECRET = 'x'.repeat(40);
const user = { id: 'user-1' };
const mail = { to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello' };
const make = (over = {}) => createApproval({ secret: SECRET, userId: 'user-1', action: 'send_email', args: mail, now: 1_000, ...over });
const check = (token, over = {}) => verifyApproval({ secret: SECRET, token, userId: 'user-1', action: 'send_email', args: mail, now: 1_500, ...over });

test('a fresh approval verifies for the same user, action and arguments', () => {
  assert.equal(check(make().token).ok, true);
});

for (const [name, args] of [['to', { ...mail, to: 'evil@example.com' }], ['subject', { ...mail, subject: 'Other' }],
  ['body', { ...mail, body: 'Hello!' }], ['cc', { ...mail, cc: 'x@example.com' }], ['bcc', { ...mail, bcc: 'x@example.com' }]]) {
  test(`changing ${name} after approval invalidates it`, () => {
    const v = check(make().token, { args });
    assert.equal(v.ok, false);
    assert.match(v.reason, /differs/);
  });
}

test('arguments the digest does not cover cannot invalidate or extend an approval', () => {
  assert.equal(check(make().token, { args: { ...mail, user_confirmed: true, note: 'x' } }).ok, true);
});

test('another user, another action, expiry', () => {
  const t = make().token;
  assert.match(check(t, { userId: 'user-2' }).reason, /another user/);
  assert.match(check(t, { action: 'forward_email', args: { ...mail, message_id: 'm' } }).reason, /another action/);
  assert.match(check(t, { now: 1_000 + 120_001 }).reason, /expired/);
  assert.equal(check(t, { now: 1_000 + 120_000 }).ok, true);
});

test('tampered signature or payload, missing and malformed tokens', () => {
  const t = make().token.split('.');
  const flipped = t[2].slice(0, -2) + (t[2].endsWith('AA') ? 'BB' : 'AA');
  assert.equal(check([t[0], t[1], flipped].join('.')).ok, false);
  const payload = JSON.parse(Buffer.from(t[1], 'base64url').toString());
  payload.exp += 10_000_000;
  assert.match(check([t[0], Buffer.from(JSON.stringify(payload)).toString('base64url'), t[2]].join('.')).reason, /signature/);
  for (const bad of [undefined, null, '', 'v1', 'v1.a', 'v2.a.b', 42, {}, 'v1.%%%.%%%']) assert.equal(check(bad).ok, false, String(bad));
});

test('a token signed with another secret is rejected', () => {
  const t = createApproval({ secret: 'y'.repeat(40), userId: 'user-1', action: 'send_email', args: mail, now: 1_000 }).token;
  assert.match(check(t).reason, /signature/);
});

test('short or missing secrets are refused on both sides', () => {
  assert.throws(() => createApproval({ secret: 'short', userId: 'u', action: 'send_email', args: mail }));
  assert.equal(verifyApproval({ secret: '', token: make().token, userId: 'user-1', action: 'send_email', args: mail, now: 1_500 }).ok, false);
});

test('tokens are unique per call (nonce) but bind the same digest', () => {
  const a = make(), b = make();
  assert.notEqual(a.token, b.token);
  assert.equal(a.digest, b.digest);
  assert.equal(a.digest, digestArgs('send_email', mail));
});

test('reply_all is part of what was approved', () => {
  const args = { message_id: 'm1', body: 'ok', reply_all: false };
  const t = createApproval({ secret: SECRET, userId: 'user-1', action: 'reply_email', args, now: 1_000 }).token;
  const v = (a) => verifyApproval({ secret: SECRET, token: t, userId: 'user-1', action: 'reply_email', args: a, now: 1_500 });
  assert.equal(v(args).ok, true);
  assert.equal(v({ ...args, reply_all: true }).ok, false);
  assert.equal(v({ ...args, reply_all: 'true' }).ok, true, 'only a boolean true counts as reply_all, a string does not');
});

test('actions that are not approvable are rejected', () => {
  assert.throws(() => createApproval({ secret: SECRET, userId: 'u', action: 'delete_everything', args: {} }));
});

// ---- guard
const legacy = {};
const server = { APPROVAL_MODE: 'server', APPROVAL_SECRET: SECRET };

test('legacy mode keeps the old behaviour (default)', () => {
  assert.equal(approvalMode({}), 'legacy');
  assert.match(guardIrreversible('send_email', { ...mail }, user, { env: legacy }), /user_confirmed must be true/);
  assert.equal(guardIrreversible('send_email', { ...mail, user_confirmed: true }, user, { env: legacy }), null);
  assert.equal(guardIrreversible('read_sheet', {}, user, { env: legacy }), null);
});

test('server mode ignores the model-supplied user_confirmed', () => {
  const r = guardIrreversible('send_email', { ...mail, user_confirmed: true }, user, { env: server, now: 1_500 });
  assert.match(r, /approval_token is required/);
});

test('server mode lets exactly the approved content through and nothing else', () => {
  const token = make().token;
  assert.equal(guardIrreversible('send_email', { ...mail, approval_token: token }, user, { env: server, now: 1_500 }), null);
  assert.match(guardIrreversible('send_email', { ...mail, body: 'changed', approval_token: token }, user, { env: server, now: 1_500 }), /differs/);
  assert.match(guardIrreversible('send_email', { ...mail, approval_token: token }, { id: 'user-2' }, { env: server, now: 1_500 }), /another user/);
  assert.match(guardIrreversible('send_email', { ...mail, approval_token: token }, null, { env: server, now: 1_500 }), /another user/);
});

test('misconfiguration fails closed', () => {
  assert.match(guardIrreversible('send_email', mail, user, { env: { APPROVAL_MODE: 'server' } }), /APPROVAL_SECRET/);
  assert.match(guardIrreversible('send_email', mail, user, { env: { APPROVAL_MODE: 'server', APPROVAL_SECRET: 'short' } }), /APPROVAL_SECRET/);
  assert.match(guardIrreversible('send_email', { ...mail, user_confirmed: true }, user, { env: { APPROVAL_MODE: 'Serverr' } }), /APPROVAL_MODE/);
});
