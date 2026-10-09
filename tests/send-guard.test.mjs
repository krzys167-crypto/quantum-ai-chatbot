import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalMode, gateIrreversible } from '../api/lib/sendGuard.js';
import { makeApprovalDb } from './helpers/fakeApprovalDb.mjs';

const USER = { id: 'u1' };
const SEND = { to: 'bob@example.com', subject: 'Hi', body: 'Hello Bob' };
const quiet = () => { const w = []; return { warn: (m) => w.push(m), info() {}, error() {}, w }; };
const run = (name, input, ctx = {}) => {
  const cards = [];
  return gateIrreversible(name, input, USER, { admin: makeApprovalDb(), onApprovalRequired: (c) => cards.push(c), env: {}, log: quiet(), ...ctx }).then((r) => ({ r, cards }));
};

test('default mode is server (fail closed), legacy only when asked for, anything else is invalid', () => {
  assert.equal(approvalMode({}), 'server');
  assert.equal(approvalMode({ APPROVAL_MODE: '' }), 'server');
  assert.equal(approvalMode({ APPROVAL_MODE: ' SERVER ' }), 'server');
  assert.equal(approvalMode({ APPROVAL_MODE: 'legacy' }), 'legacy');
  assert.equal(approvalMode({ APPROVAL_MODE: 'off' }), 'invalid');
  assert.equal(approvalMode({ APPROVAL_MODE: 'true' }), 'invalid');
});

test('server mode: the model can never release a send, whatever it claims', async () => {
  for (const name of ['send_email', 'reply_email', 'forward_email']) {
    const input = { to: 'a@b.c', message_id: 'm1', body: 'b', subject: 's', user_confirmed: true, approval_token: 'forged', approved: true };
    const { r, cards } = await run(name, input);
    assert.notEqual(r, null, name);
    assert.equal(r.is_error, false);
    assert.match(r.content, /NOT SENT YET/);
    assert.equal(cards.length, 1);
  }
});

test('server mode: the card carries exactly the stored fields, an id and an expiry, and nothing the model smuggled in', async () => {
  const { cards } = await run('send_email', { ...SEND, user_confirmed: true, approval_token: 'x', note: 'extra' });
  const [c] = cards;
  assert.equal(c.action, 'send_email');
  assert.deepEqual(c.fields, { to: 'bob@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello Bob' });
  assert.match(c.id, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(c.expires_at) > Date.now() - 1);
  assert.equal(c.context, null);
});

test('server mode: describe() adds best-effort context; a failing describe does not block the card', async () => {
  const ok = await run('reply_email', { message_id: 'm1', body: 'thanks' }, { describe: async () => ({ original: { from: 'Eve <eve@x.y>', subject: 'Invoice' } }) });
  assert.equal(ok.cards[0].context.original.from, 'Eve <eve@x.y>');
  const bad = await run('reply_email', { message_id: 'm1', body: 'thanks' }, { describe: async () => { throw new Error('gmail down'); } });
  assert.equal(bad.cards.length, 1);
  assert.equal(bad.cards[0].context, null);
});

test('server mode: no way to show a card (non-streaming / no callback) blocks instead of sending', async () => {
  const db = makeApprovalDb();
  const r = await gateIrreversible('send_email', SEND, USER, { admin: db, env: {}, log: quiet() });
  assert.equal(r.is_error, true);
  assert.match(r.content, /cannot show a Confirm card/);
  assert.equal(db.tables.approval_requests.length, 0, 'no orphan request is stored when nobody can confirm it');
});

test('server mode: a card that cannot be delivered blocks the action', async () => {
  const r = await gateIrreversible('send_email', SEND, USER, { admin: makeApprovalDb(), env: {}, log: quiet(), onApprovalRequired: () => { throw new Error('socket closed'); } });
  assert.equal(r.is_error, true);
  assert.match(r.content, /could not be delivered/);
});

test('server mode: invalid arguments, missing store, flood, missing user are all blocked with a reason', async () => {
  assert.match((await run('send_email', { subject: 's' })).r.content, /to is required/);
  const noStore = await run('send_email', SEND, { admin: makeApprovalDb({ fail: { 'approval_requests.insert': true } }) });
  assert.equal(noStore.r.is_error, true);
  assert.match(noStore.r.content, /approval-requests\.sql/);
  assert.equal(noStore.cards.length, 0, 'no card is shown for a request that was not stored');
  const db = makeApprovalDb();
  for (let i = 0; i < 10; i++) await gateIrreversible('send_email', { ...SEND, subject: `s${i}` }, USER, { admin: db, onApprovalRequired() {}, env: {}, log: quiet() });
  const flood = await gateIrreversible('send_email', { ...SEND, subject: 'x' }, USER, { admin: db, onApprovalRequired() {}, env: {}, log: quiet() });
  assert.match(flood.content, /too many/);
  const anon = await gateIrreversible('send_email', SEND, null, { admin: makeApprovalDb(), onApprovalRequired() {}, env: {}, log: quiet() });
  assert.equal(anon.is_error, true);
});

test('a repeated identical call re-shows the same card instead of stacking a second one', async () => {
  const db = makeApprovalDb();
  const cards = [];
  const ctx = { admin: db, onApprovalRequired: (c) => cards.push(c), env: {}, log: quiet() };
  await gateIrreversible('send_email', SEND, USER, ctx);
  await gateIrreversible('send_email', SEND, USER, ctx);
  assert.equal(db.tables.approval_requests.length, 1);
  assert.equal(cards[0].id, cards[1].id);
});

test('legacy mode (explicit): proceeds only on the model\'s own flag, and says so in the log', async () => {
  const log = quiet();
  const env = { APPROVAL_MODE: 'legacy' };
  assert.match((await gateIrreversible('send_email', SEND, USER, { env, log })).content, /user_confirmed must be true/);
  assert.equal(await gateIrreversible('send_email', { ...SEND, user_confirmed: 'true' }, USER, { env, log }).then((r) => r.is_error), true, 'a string is not true');
  assert.equal(await gateIrreversible('send_email', { ...SEND, user_confirmed: true }, USER, { env, log }), null);
  assert.equal(log.w.length, 1);
  assert.match(log.w[0], /F09 open/);
});

test('an unknown APPROVAL_MODE blocks everything', async () => {
  const r = await gateIrreversible('send_email', { ...SEND, user_confirmed: true }, USER, { env: { APPROVAL_MODE: 'disabled' }, log: quiet() });
  assert.equal(r.is_error, true);
  assert.match(r.content, /APPROVAL_MODE/);
});

test('other tools are not touched by the gate', async () => {
  for (const name of ['search_gmail', 'create_email_draft', 'modify_gmail', 'create_calendar_event']) {
    assert.equal(await gateIrreversible(name, { x: 1 }, USER, { env: {}, log: quiet() }), null, name);
  }
});
