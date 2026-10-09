// Handlers a signed-in user calls (title, suggestions, tts, stt, agent schedules, MCP servers) must not put database or
// provider error text into the response body: table and constraint names, quota and account details, the voice and model
// in use. The detail goes to the server log; the caller gets a fixed sentence. Validation answers we wrote ourselves
// (400) stay as they were. Real handlers; only the network edge (Supabase REST + auth, Anthropic, ElevenLabs) is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { format } from 'node:util';
import { Readable } from 'node:stream';

const USER_ID = '22222222-2222-4222-8222-222222222222';
process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub';
process.env.SUPABASE_ANON_KEY = 'anon-stub';
process.env.ANTHROPIC_API_KEY = 'anthropic-stub';
process.env.ELEVENLABS_API_KEY = 'eleven-stub';
for (const k of ['ELEVENLABS_VOICE_ID', 'ELEVENLABS_VOICE_MALE', 'ELEVENLABS_VOICE_HAUSA_MALE', 'ELEVENLABS_VOICE', 'ELEVENLABS_TTS_MODEL', 'ELEVENLABS_TTS_FALLBACK_MODEL']) delete process.env[k];

const title = (await import('../api/title.js')).default;
const suggestions = (await import('../api/suggestions.js')).default;
const tts = (await import('../api/tts.js')).default;
const stt = (await import('../api/stt.js')).default;
const schedules = (await import('../api/agents/schedules.js')).default;
const mcp = (await import('../api/connectors/mcp.js')).default;

const MARK = 'LEAK-relation_agent_schedules_does_not_exist-7f3a';
const TOKEN = 'xoxb-SECRET-TOKEN-VALUE-91c2';
const VOICE = 'voiceIdAbCdEfGhIjKl1234';

const realFetch = globalThis.fetch;
const realErr = console.error;
const realWarn = console.warn;
let logged = [];
let world = {};
test.beforeEach(() => {
  logged = [];
  world = {};
  console.error = (...a) => logged.push(format(...a));
  console.warn = (...a) => logged.push(format(...a));
});
test.after(() => { globalThis.fetch = realFetch; console.error = realErr; console.warn = realWarn; });

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.includes('/auth/v1/user')) {
    return json({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'u@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
  }
  if (url.includes('api.anthropic.com')) return world.anthropic(url, opts);
  if (url.includes('api.elevenlabs.io')) return world.eleven(url, opts);
  if (url.includes('/rest/v1/')) return world.rest(url, opts);
  throw new Error('unexpected request in test: ' + url);
};

const res = () => {
  const r = { statusCode: 200, body: null, headers: {}, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; }, send() { return r; }, write() {} };
  return r;
};
const req = (method, body, extra = {}) => ({ method, headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body, query: {}, ...extra });
const wire = (r) => JSON.stringify(r.body);
const logText = () => logged.join('\n');

// ---------------------------------------------------------------- title, suggestions

for (const [name, handler, body] of [
  ['title', title, { userText: 'hello', assistantText: 'hi there' }],
  ['suggestions', suggestions, { userText: 'hello', assistantText: 'hi there' }],
]) {
  test(`${name}: a provider error returns a fixed message; status and body text go to the log only`, async () => {
    world.anthropic = async () => new Response(`{"error":{"message":"${MARK} org_9981 is over quota"}}`, { status: 429 });
    const r = res();
    await handler(req('POST', body), r);
    assert.equal(r.statusCode, 502);
    assert.deepEqual(r.body, { error: 'AI provider error' });
    assert.ok(!wire(r).includes(MARK));
    assert.ok(logText().includes(MARK) && logText().includes('429'), 'the detail is in the server log');
  });

  test(`${name}: an unexpected exception returns a fixed message; the message goes to the log only`, async () => {
    world.anthropic = async () => { throw new Error(`socket hang up ${MARK}`); };
    const r = res();
    await handler(req('POST', body), r);
    assert.equal(r.statusCode, 500);
    assert.deepEqual(r.body, { error: 'Internal server error' });
    assert.ok(!wire(r).includes(MARK));
    assert.ok(logText().includes(MARK));
  });

  test(`${name}: validation and auth answers are unchanged`, async () => {
    const r1 = res();
    await handler(req('POST', { userText: '', assistantText: '' }), r1);
    assert.equal(r1.statusCode, 400);
    const r2 = res();
    await handler({ ...req('POST', body), headers: {} }, r2);
    assert.equal(r2.statusCode, 401);
    assert.deepEqual(r2.body, { error: 'Sign in required' });
    const r3 = res();
    await handler(req('GET'), r3);
    assert.equal(r3.statusCode, 405);
  });
}

// ---------------------------------------------------------------- tts

test('tts: an ElevenLabs error returns a fixed message and does not reveal status, details, voice or model', async () => {
  world.eleven = async () => new Response(`{"detail":{"message":"${MARK} subscription 8812 expired"}}`, { status: 500 });
  const r = res();
  await tts(req('POST', { text: 'Hello there, this is a test.' }), r);
  assert.equal(r.statusCode, 502);
  assert.deepEqual(r.body, { error: 'Text-to-speech failed' });
  const w = wire(r);
  for (const leak of [MARK, '500', 'eleven_v3', 'eleven_turbo', 'rPlZjuLXpONhaMouRFww', 'details', 'voiceId', 'modelId']) assert.ok(!w.includes(leak), `response contains "${leak}"`);
  // a 5xx is not retried on the fallback model, so the model in use is the primary one
  assert.ok(logText().includes(MARK) && logText().includes('500') && logText().includes('eleven_v3') && logText().includes('rPlZjuLXpONhaMouRFww'), 'the log has the detail, the status, the model and the voice');
});

test('tts: the fallback model is still tried after a 4xx, and its failure is generic too', async () => {
  const seen = [];
  world.eleven = async (url, opts) => { seen.push(JSON.parse(opts.body).model_id); return new Response(`${MARK}`, { status: 422 }); };
  const r = res();
  await tts(req('POST', { text: 'Hello there, this is a test.' }), r);
  assert.deepEqual(seen, ['eleven_v3', 'eleven_turbo_v2_5']);
  assert.equal(r.statusCode, 502);
  assert.deepEqual(r.body, { error: 'Text-to-speech failed' });
});

test('tts: an unexpected exception returns a fixed message and logs the real one', async () => {
  world.eleven = async () => { throw new Error(`ECONNRESET ${MARK}`); };
  const r = res();
  await tts(req('POST', { text: 'Hello there.' }), r);
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.body, { error: 'Internal server error' });
  assert.ok(!wire(r).includes(MARK));
  assert.ok(logText().includes(MARK));
});

// ---------------------------------------------------------------- stt

const sttReq = () => {
  const audio = Buffer.alloc(400, 1).toString('base64');
  const r = Readable.from([Buffer.from(JSON.stringify({ audioBase64: audio, mimeType: 'audio/webm', language: 'en' }))]);
  r.method = 'POST';
  r.headers = { authorization: 'Bearer user-jwt', 'content-type': 'application/json' };
  return r;
};

test('stt: an ElevenLabs error returns a fixed message and does not reveal status or details', async () => {
  world.eleven = async () => new Response(`{"detail":{"message":"${MARK} quota"}}`, { status: 401 });
  const r = res();
  await stt(sttReq(), r);
  assert.equal(r.statusCode, 502);
  assert.deepEqual(r.body, { error: 'Speech-to-text failed' });
  assert.ok(!wire(r).includes(MARK) && !wire(r).includes('401'));
  assert.ok(logText().includes(MARK) && logText().includes('401'));
});

test('stt: an unexpected exception returns a fixed message and logs the real one', async () => {
  world.eleven = async () => { throw new Error(`boom ${MARK}`); };
  const r = res();
  await stt(sttReq(), r);
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.body, { error: 'Internal server error' });
  assert.ok(!wire(r).includes(MARK));
  assert.ok(logText().includes(MARK));
});

test('stt: a successful transcription is unchanged', async () => {
  world.eleven = async () => json({ text: 'hello world', language_code: 'eng', words: [] });
  const r = res();
  await stt(sttReq(), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.text, 'hello world');
});

// ---------------------------------------------------------------- agent schedules

const pgError = (status = 500) => json({ message: MARK, details: `Failing row contains (${TOKEN})`, hint: 'secret hint', code: '23502' }, status);

for (const [label, method, body, query] of [
  ['list', 'GET', undefined, {}],
  ['create', 'POST', { kind: 'daily_gmail_digest' }, {}],
  ['update', 'PATCH', { enabled: false }, { id: 'abc' }],
  ['delete', 'DELETE', undefined, { id: 'abc' }],
]) {
  test(`agent schedules ${label}: a database error returns a fixed message; the detail goes to the log without the row`, async () => {
    world.rest = async () => pgError();
    const r = res();
    await schedules(req(method, body, { query }), r);
    assert.equal(r.statusCode, 500);
    assert.deepEqual(r.body, { error: 'Request failed' });
    assert.ok(!wire(r).includes(MARK));
    assert.ok(logText().includes(MARK), 'the message is in the server log');
    assert.ok(!logText().includes(TOKEN), 'the failing row (details) is not written to the log');
  });
}

test('agent schedules: success and validation answers are unchanged', async () => {
  world.rest = async () => json([{ id: 's1', user_id: USER_ID }]);
  const ok = res();
  await schedules(req('GET'), ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body, { schedules: [{ id: 's1', user_id: USER_ID }] });
  const noId = res();
  await schedules(req('PATCH', { enabled: true }), noId);
  assert.equal(noId.statusCode, 400);
  assert.deepEqual(noId.body, { error: 'id required' });
});

// ---------------------------------------------------------------- MCP servers

for (const [label, method, body, query] of [
  ['list', 'GET', undefined, {}],
  ['toggle', 'POST', { id: 'abc', enabled: false }, {}],
  ['save', 'POST', { url: 'https://mcp.example.com/sse', token: TOKEN, label: 'x' }, {}],
  ['delete', 'DELETE', undefined, { id: 'abc' }],
]) {
  test(`mcp servers ${label}: a database error returns a fixed message and the log never carries the token`, async () => {
    world.rest = async (url, opts = {}) => {
      // the first call of "save" is the count query; let it succeed so the upsert is what fails
      if (label === 'save' && (opts.method || 'GET') === 'GET') return json([]);
      return pgError();
    };
    const r = res();
    await mcp(req(method, body, { query }), r);
    assert.equal(r.statusCode, 500);
    assert.deepEqual(r.body, { error: 'Request failed' });
    assert.ok(!wire(r).includes(MARK) && !wire(r).includes(TOKEN));
    assert.ok(logText().includes(MARK));
    assert.ok(!logText().includes(TOKEN), 'the failing row (details) is not written to the log');
  });
}

test('mcp servers: an unexpected exception returns a fixed message and logs the real one', async () => {
  const r = res();
  await mcp(req('POST', '{not json'), r);
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.body, { error: 'Internal server error' });
  assert.ok(!wire(r).includes('JSON'), 'the parser message is not echoed');
  assert.ok(logText().includes('JSON'));
});

test('mcp servers: the messages we wrote ourselves are still returned', async () => {
  world.rest = async () => json([]);
  const badUrl = res();
  await mcp(req('POST', { url: 'ftp://nope' }), badUrl);
  assert.equal(badUrl.statusCode, 400);
  assert.ok(typeof badUrl.body.error === 'string' && badUrl.body.error.length > 10 && badUrl.body.error !== 'Request failed');
  const noId = res();
  await mcp(req('DELETE', undefined, { query: {} }), noId);
  assert.equal(noId.statusCode, 400);
  assert.deepEqual(noId.body, { error: 'id is required' });
  world.rest = async () => json({ message: 'relation "public.mcp_servers" does not exist', code: '42P01' }, 404);
  const missing = res();
  await mcp(req('GET'), missing);
  assert.equal(missing.statusCode, 200);
  assert.deepEqual(missing.body, { servers: [], not_installed: true });
});

// ---------------------------------------------------------------- static guard

test('the six handlers contain no response that carries error text, details or message fields', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const rel of ['title.js', 'suggestions.js', 'tts.js', 'stt.js', 'agents/schedules.js', 'connectors/mcp.js']) {
    const src = strip(readFileSync(new URL(`../api/${rel}`, import.meta.url), 'utf8'));
    const jsonCalls = [...src.matchAll(/\.json\(([\s\S]*?)\)\s*;/g)].map((m) => m[1]);
    assert.ok(jsonCalls.length > 3, `${rel}: precondition, found its responses`);
    for (const c of jsonCalls) {
      assert.ok(!/\b(err|error|e)\??\.message\b/.test(c), `${rel}: a response echoes an error message: ${c}`);
      assert.ok(!/\bdetails\s*:/.test(c), `${rel}: a response has a "details" field: ${c}`);
      assert.ok(!/\bmessage\s*:\s*err/.test(c), `${rel}: a response has a "message: err..." field: ${c}`);
      assert.ok(!/\b(voiceId|modelId)\b/.test(c), `${rel}: a response carries voice/model: ${c}`);
    }
  }
});
