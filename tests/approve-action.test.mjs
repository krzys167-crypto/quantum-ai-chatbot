import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApproveHandler } from '../api/lib/approveHandler.js';
import { createPending } from '../api/lib/approvals.js';
import { makeApprovalDb } from './helpers/fakeApprovalDb.mjs';

const T0 = 1_800_000_000_000;
const SEND = { to: 'bob@example.com', subject: 'Hi', body: 'Hello Bob' };
const quiet = { info() {}, error() {}, warn() {} };

function res() {
  const r = { headers: {}, statusCode: 200, body: undefined,
    setHeader(k, v) { r.headers[k] = v; }, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } };
  return r;
}
function setup(over = {}) {
  const db = makeApprovalDb();
  const performed = [];
  const handler = makeApproveHandler({
    getUser: async (req) => (req.headers?.authorization ? { id: req.headers.authorization.replace('Bearer ', '') } : null),
    getAdmin: () => db, log: quiet, now: () => T0 + 1000,
    perform: async (action, args, user) => { performed.push({ action, args, user: user.id }); return { type: 'tool_result', content: '{"sent":true}' }; },
    ...over,
  });
  const call = async (as, body, method = 'POST') => { const r = res(); await handler({ method, headers: as ? { authorization: `Bearer ${as}` } : {}, body }, r); return r; };
  const open = (userId = 'u1', args = SEND) => createPending({ admin: db, userId, action: 'send_email', args, now: T0 });
  return { db, performed, call, open };
}

test('approve: executes the STORED content once and reports it as sent', async () => {
  const { call, open, performed, db } = setup();
  const p = await open();
  const r = await call('u1', { id: p.id, decision: 'approve' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, status: 'sent', action: 'send_email' });
  assert.equal(performed.length, 1);
  assert.deepEqual(performed[0], { action: 'send_email', user: 'u1', args: { to: 'bob@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello Bob' } });
  assert.equal(db.tables.approval_requests.length, 0);
});

test('approve: whatever else the request carries cannot change what is sent', async () => {
  const { call, open, performed } = setup();
  const p = await open();
  await call('u1', { id: p.id, decision: 'approve', args: { to: 'attacker@evil.example' }, to: 'attacker@evil.example', body: 'pwned', action: 'forward_email' });
  assert.equal(performed.length, 1);
  assert.equal(performed[0].args.to, 'bob@example.com');
  assert.equal(performed[0].args.body, 'Hello Bob');
  assert.equal(performed[0].action, 'send_email');
});

test('replay and double click: the second attempt finds nothing and sends nothing', async () => {
  const { call, open, performed } = setup();
  const p = await open();
  const second = await call('u1', { id: p.id, decision: 'approve' }).then(() => call('u1', { id: p.id, decision: 'approve' }));
  assert.equal(second.statusCode, 404);
  assert.equal(performed.length, 1);
  const q = await open('u1', { ...SEND, subject: 'again' });
  const both = await Promise.all([call('u1', { id: q.id, decision: 'approve' }), call('u1', { id: q.id, decision: 'approve' })]);
  assert.deepEqual(both.map((x) => x.statusCode).sort(), [200, 404]);
  assert.equal(performed.length, 2, 'one delivery per request, even for two parallel clicks');
});

test('another signed-in user cannot release or cancel it', async () => {
  const { call, open, performed, db } = setup();
  const p = await open('alice');
  assert.equal((await call('mallory', { id: p.id, decision: 'approve' })).statusCode, 404);
  assert.equal((await call('mallory', { id: p.id, decision: 'reject' })).statusCode, 404);
  assert.equal(performed.length, 0);
  assert.equal(db.tables.approval_requests.length, 1, 'alice\'s request is untouched');
});

test('reject: nothing is sent and the request is gone', async () => {
  const { call, open, performed, db } = setup();
  const p = await open();
  const r = await call('u1', { id: p.id, decision: 'reject' });
  assert.deepEqual(r.body, { ok: true, status: 'cancelled', action: 'send_email' });
  assert.equal(performed.length, 0);
  assert.equal(db.tables.approval_requests.length, 0);
});

test('expired: 410 and nothing is sent', async () => {
  const { call, open, performed } = setup({ now: () => T0 + 11 * 60_000 });
  const p = await open();
  const r = await call('u1', { id: p.id, decision: 'approve' });
  assert.equal(r.statusCode, 410);
  assert.equal(performed.length, 0);
});

test('authentication, method, body and rate limit', async () => {
  const { call, open, performed } = setup();
  const p = await open();
  assert.equal((await call(null, { id: p.id, decision: 'approve' })).statusCode, 401);
  assert.equal((await call('u1', { id: p.id, decision: 'approve' }, 'GET')).statusCode, 405);
  assert.equal((await call('u1', { id: p.id, decision: 'approve' }, 'OPTIONS')).statusCode, 405);
  for (const body of [null, {}, { id: p.id }, { decision: 'approve' }, { id: 5, decision: 'approve' }, { id: p.id, decision: 'yes' }, 'not json{']) {
    assert.equal((await call('u1', body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await call('u1', JSON.stringify({ id: p.id, decision: 'approve' }))).statusCode, 200, 'a JSON string body is parsed');
  assert.equal(performed.length, 1);
  const limited = setup({ allow: () => false });
  assert.equal((await limited.call('u1', { id: 'x', decision: 'approve' })).statusCode, 429);
});

test('no CORS headers: the endpoint is same-origin only', async () => {
  const { call, open } = setup();
  const p = await open();
  const r = await call('u1', { id: p.id, decision: 'approve' });
  assert.deepEqual(Object.keys(r.headers).filter((h) => h.toLowerCase().startsWith('access-control')), []);
});

test('a Gmail failure is reported without provider text and the request is not retried', async () => {
  const { call, open, db } = setup({ perform: async () => { throw new Error('Gmail send failed: 403 {"error":"secret detail about the account"}'); } });
  const p = await open();
  const r = await call('u1', { id: p.id, decision: 'approve' });
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /HTTP 403/);
  assert.ok(!JSON.stringify(r.body).includes('secret detail'));
  assert.equal(db.tables.approval_requests.length, 0, 'consumed: at most one delivery attempt');
  const again = await call('u1', { id: p.id, decision: 'approve' });
  assert.equal(again.statusCode, 404);
});

test('Gmail not connected: reported as failed, nothing claimed as sent', async () => {
  const { call, open } = setup({ perform: async () => ({ type: 'tool_result', is_error: true, content: 'not connected' }) });
  const r = await call('u1', { id: (await open()).id, decision: 'approve' });
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.status, 'failed');
});

test('store outage on release: 503 and nothing is sent', async () => {
  const db = makeApprovalDb({ fail: { 'approval_requests.delete': true } });
  const performed = [];
  const h = makeApproveHandler({ getUser: async () => ({ id: 'u1' }), getAdmin: () => db, perform: async (...a) => { performed.push(a); return {}; }, log: quiet });
  const p = await createPending({ admin: makeApprovalDb(), userId: 'u1', action: 'send_email', args: SEND, now: T0 });
  db.tables.approval_requests.push({ id: p.id, user_id: 'u1', action: 'send_email', digest: 'x', args: SEND, expires_at: new Date(Date.now() + 1e6).toISOString() });
  const r = res();
  await h({ method: 'POST', headers: {}, body: { id: p.id, decision: 'approve' } }, r);
  assert.equal(r.statusCode, 503);
  assert.equal(performed.length, 0);
});

test('end to end: two injected sends produce two cards; approving one sends only that one', async () => {
  const { call, db, performed } = setup();
  const cards = [];
  const { gateIrreversible } = await import('../api/lib/sendGuard.js');
  const ctx = { admin: db, onApprovalRequired: (c) => cards.push(c), env: {}, log: quiet, now: T0 };
  await gateIrreversible('send_email', { to: 'boss@corp.example', subject: 'Report', body: 'Numbers attached' }, { id: 'u1' }, ctx);
  await gateIrreversible('send_email', { to: 'attacker@evil.example', subject: 'Fwd', body: 'secrets from the inbox' }, { id: 'u1' }, ctx);
  assert.equal(cards.length, 2);
  const legit = cards.find((c) => c.fields.to === 'boss@corp.example');
  const r = await call('u1', { id: legit.id, decision: 'approve' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(performed.map((p) => p.args.to), ['boss@corp.example']);
  assert.equal(db.tables.approval_requests.length, 1, 'the other request is still waiting and was never sent');
});

test('audit log lines carry ids, action and digest, never the message content, recipients or provider text', async () => {
  const lines = [];
  const sink = { info: (m) => lines.push(String(m)), error: (...m) => lines.push(m.join(' ')), warn: (m) => lines.push(String(m)) };
  const secretArgs = { to: 'victim@example.com', subject: 'Confidential subject', body: 'TOP SECRET BODY 4242' };
  {
    const { call, open } = setup({ log: sink });
    const p = await open('u1', secretArgs);
    await call('u1', { id: p.id, decision: 'approve' });
  }
  {
    const { call, open } = setup({ log: sink, perform: async () => { throw new Error('Gmail send failed: 403 TOP SECRET BODY 4242'); } });
    const p = await open('u1', secretArgs);
    await call('u1', { id: p.id, decision: 'approve' });
  }
  {
    const { call, open } = setup({ log: sink });
    const p = await open('u1', secretArgs);
    await call('u1', { id: p.id, decision: 'reject' });
  }
  const all = lines.join('\n');
  assert.match(all, /approval_executed/);
  assert.match(all, /approval_rejected/);
  for (const needle of ['victim@example.com', 'Confidential subject', 'TOP SECRET BODY']) assert.ok(!all.includes(needle), `log leaked: ${needle}`);
});
