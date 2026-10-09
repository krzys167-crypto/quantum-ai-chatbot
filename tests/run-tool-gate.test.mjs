import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool, SEND_EMAIL_TOOL, REPLY_EMAIL_TOOL, FORWARD_EMAIL_TOOL } from '../api/lib/claudeTools.js';
import { makeApprovalDb } from './helpers/fakeApprovalDb.mjs';

// The real runTool() with the real gate. Any attempt to talk to Gmail / Supabase over the network is recorded
// and refused, so a regression that sends (or even tries to) fails the test.
const USER = { id: 'u1' };
const net = [];
const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async (url) => { net.push(String(url)); throw new Error('network is not available in this test'); }; });
test.after(() => { globalThis.fetch = realFetch; delete process.env.APPROVAL_MODE; });
test.beforeEach(() => { net.length = 0; delete process.env.APPROVAL_MODE; });

const call = (name, input, ctx = {}) => runTool({ id: 't1', name, input }, USER, ctx);

test('server mode (default): send_email with a forged confirmation files a pending request and touches no network', async () => {
  const admin = makeApprovalDb();
  const cards = [];
  const out = await call('send_email', { to: 'x@y.z', subject: 's', body: 'b', user_confirmed: true, approval_token: 'forged' }, { admin, onApprovalRequired: (c) => cards.push(c) });
  assert.equal(out.type, 'tool_result');
  assert.equal(out.tool_use_id, 't1');
  assert.equal(out.is_error, false);
  assert.match(out.content, /NOT SENT YET/);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].fields.to, 'x@y.z');
  assert.equal(admin.tables.approval_requests.length, 1);
  assert.deepEqual(net, [], 'no Gmail (or any other) request was made');
});

test('server mode: reply and forward are gated the same way (card still shown if the original cannot be loaded)', async () => {
  for (const [name, input] of [['reply_email', { message_id: 'm1', body: 'ok', user_confirmed: true }], ['forward_email', { message_id: 'm1', to: 'x@y.z', user_confirmed: true }]]) {
    const admin = makeApprovalDb();
    const cards = [];
    const out = await call(name, input, { admin, onApprovalRequired: (c) => cards.push(c) });
    assert.match(out.content, /NOT SENT YET/, name);
    assert.equal(cards.length, 1, name);
    assert.equal(cards[0].action, name);
    assert.ok(!net.some((u) => /\/messages\/send/.test(u)), `${name} must not send`);
  }
});

test('server mode without a card channel (non-streaming) blocks and sends nothing', async () => {
  const out = await call('send_email', { to: 'x@y.z', subject: 's', body: 'b', user_confirmed: true }, { admin: makeApprovalDb() });
  assert.equal(out.is_error, true);
  assert.deepEqual(net, []);
});

test('legacy mode without the model flag is still blocked, with the flag it proceeds to Gmail (and fails here: no network/connector)', async () => {
  process.env.APPROVAL_MODE = 'legacy';
  const blocked = await call('send_email', { to: 'x@y.z', subject: 's', body: 'b' }, { admin: makeApprovalDb() });
  assert.equal(blocked.is_error, true);
  assert.match(blocked.content, /user_confirmed must be true/);
  // With the flag the code goes on to look up the connector (needs the real database, absent here): it is not gated.
  await assert.rejects(
    call('send_email', { to: 'x@y.z', subject: 's', body: 'b', user_confirmed: true }, { admin: makeApprovalDb() }),
    /Missing SUPABASE_URL/,
  );
});

test('tool schemas no longer offer a model-held approval token and tell the model it cannot send', () => {
  for (const t of [SEND_EMAIL_TOOL, REPLY_EMAIL_TOOL, FORWARD_EMAIL_TOOL]) {
    assert.ok(!('approval_token' in t.input_schema.properties), t.name);
    assert.match(t.description, /Confirm/);
    assert.match(t.input_schema.properties.user_confirmed.description, /Ignored/);
  }
});
