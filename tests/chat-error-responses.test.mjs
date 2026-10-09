// The chat endpoint answers a failed turn with a fixed sentence per provider status. The provider's response body
// (account, quota and credit details) and the message of any other exception go to the server log, not to the user.
// Real handler (api/chat.js) and real tool loading; only the network edge (Supabase REST + auth, Anthropic) is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { format } from 'node:util';

const USER_ID = '33333333-3333-4333-8333-333333333333';
process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub';
process.env.SUPABASE_ANON_KEY = 'anon-stub';
process.env.ANTHROPIC_API_KEY = 'anthropic-stub';

const chat = (await import('../api/chat.js')).default;
const { chatErrorMessage } = await import('../api/lib/publicError.js');

const MARK = 'LEAK-your_credit_balance_is_too_low_org_7731-c9';
const realFetch = globalThis.fetch;
const realErr = console.error;
let logged = [];
let anthropic;
test.beforeEach(() => { logged = []; console.error = (...a) => logged.push(format(...a)); });
test.after(() => { globalThis.fetch = realFetch; console.error = realErr; });

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.includes('/auth/v1/user')) return json({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'u@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
  if (url.includes('api.anthropic.com')) return anthropic(url, opts);
  if (url.includes('/rest/v1/')) return json([]);
  throw new Error('unexpected request in test: ' + url);
};

const res = () => {
  const r = { statusCode: 200, body: null, headers: {}, chunks: [], ended: false,
    setHeader(k, v) { r.headers[k] = v; }, flushHeaders() {}, status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; return r; }, write(c) { r.chunks.push(String(c)); return true; }, end() { r.ended = true; return r; } };
  return r;
};
const req = (stream) => ({
  method: 'POST',
  headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' },
  body: { messages: [{ role: 'user', content: 'hello' }], stream },
});
const providerError = (status) => () => new Response(`{"type":"error","error":{"type":"x","message":"${MARK}"}}`, { status });

test('chatErrorMessage: one fixed sentence per status, none of which contains provider text', () => {
  assert.equal(chatErrorMessage({ status: 401 }), 'AI provider auth failed. Check ANTHROPIC_API_KEY on the server.');
  assert.equal(chatErrorMessage({ status: 429 }), 'AI rate limit hit. Wait a moment and try again.');
  assert.match(chatErrorMessage({ status: 400 }), /rejected this request.*too long/);
  assert.equal(chatErrorMessage({ status: 413 }), chatErrorMessage({ status: 400 }));
  for (const s of [500, 502, 503, 529]) assert.match(chatErrorMessage({ status: s }), /having trouble/);
  assert.equal(chatErrorMessage({ status: 418 }), 'AI provider error (418).');
  assert.equal(chatErrorMessage(new Error(`db ${MARK}`)), 'Internal server error');
  assert.equal(chatErrorMessage({ status: 500, details: MARK, message: MARK }).includes(MARK), false);
  assert.equal(chatErrorMessage(undefined), 'Internal server error');
});

for (const status of [400, 401, 429, 500, 529]) {
  test(`chat (JSON) ${status} from the provider: fixed message, status number, no provider body; the body is logged`, async () => {
    anthropic = providerError(status);
    const r = res();
    await chat(req(false), r);
    assert.equal(r.statusCode, 502);
    assert.deepEqual(r.body, { error: chatErrorMessage({ status }), status });
    assert.ok(!JSON.stringify(r.body).includes(MARK));
    assert.ok(logged.join('\n').includes(MARK), 'the provider body is in the server log');
  });
}

test('chat (stream): the SSE error events carry the fixed message, not the provider body', async () => {
  anthropic = providerError(500);
  const r = res();
  await chat(req(true), r);
  const wire = r.chunks.join('');
  assert.ok(wire.includes(chatErrorMessage({ status: 500 })));
  assert.ok(!wire.includes(MARK));
  assert.ok(wire.includes('[DONE]') && r.ended);
  assert.ok(logged.join('\n').includes(MARK));
});

test('chat: an exception that is not a provider error returns "Internal server error" (JSON and stream), message in the log', async () => {
  anthropic = async () => { throw new Error(`relation "connectors" does not exist ${MARK}`); };
  const j = res();
  await chat(req(false), j);
  assert.equal(j.statusCode, 500);
  assert.deepEqual(j.body, { error: 'Internal server error' });
  assert.ok(!JSON.stringify(j.body).includes(MARK));
  const s = res();
  await chat(req(true), s);
  assert.ok(!s.chunks.join('').includes(MARK));
  assert.ok(s.chunks.join('').includes('Internal server error'));
  assert.ok(logged.join('\n').includes(MARK));
});

test('chat: validation and auth answers are unchanged', async () => {
  const noMsgs = res();
  await chat({ ...req(false), body: {} }, noMsgs);
  assert.equal(noMsgs.statusCode, 400);
  assert.deepEqual(noMsgs.body, { error: 'messages array is required' });
  const noAuth = res();
  await chat({ ...req(false), headers: {} }, noAuth);
  assert.equal(noAuth.statusCode, 401);
  assert.deepEqual(noAuth.body, { error: 'Sign in required' });
});
