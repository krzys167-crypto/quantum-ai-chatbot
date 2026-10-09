// The two cron endpoints answer whoever holds CRON_SECRET (Vercel Cron, or anyone the secret leaked to). A failure must
// not echo database or provider error text in the response body; the detail goes to the server log. The owner of a
// schedule still sees the full message in agent_runs / last_error. Real handlers and the real tick; only the network
// edge (Supabase REST, Gmail) is stubbed. Also pins the front-end wiring that drops pending Confirm cards on sign-out
// (static check: the effect is not executed here, there is no browser or React effect runner in this repo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { format } from 'node:util';

process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub';
process.env.CRON_SECRET = 'cron-secret-stub';
const tick = (await import('../api/cron/agent-tick.js')).default;
const reminders = (await import('../api/cron/notes-reminders.js')).default;

const MARK = 'DETAIL-relation_agent_schedules_does_not_exist-7f3a';
const realFetch = globalThis.fetch;
const realErr = console.error;
let logged = [];
let updates = [];
test.beforeEach(() => { logged = []; updates = []; console.error = (...a) => logged.push(format(...a)); });
test.after(() => { globalThis.fetch = realFetch; console.error = realErr; });

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const res = () => { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const authed = { headers: { authorization: 'Bearer cron-secret-stub' } };

test('agent-tick: a database failure returns a generic body and logs the detail', async () => {
  globalThis.fetch = async () => json({ message: MARK, code: '42P01' }, 500);
  const r = res();
  await tick(authed, r);
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.body, { error: 'tick failed' });
  assert.ok(logged.some((l) => l.includes(MARK)), 'the detail is in the server log');
});

test('notes-reminders: a query failure returns a generic body and logs the detail', async () => {
  globalThis.fetch = async () => json({ message: MARK, code: '42P01' }, 500);
  const r = res();
  await reminders(authed, r);
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.body, { error: 'query failed' });
  assert.ok(logged.some((l) => l.includes(MARK)));
});

test('a failing schedule: the HTTP response is generic, the stored run keeps the full message for its owner', async () => {
  const PROVIDER = 'quota exceeded for project 1234567890 (internal-detail-9b2c)';
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    const method = opts.method || 'GET';
    if (url.includes('/rest/v1/agent_schedules') && method === 'GET') return json([{ id: 's1', user_id: '11111111-1111-4111-8111-111111111111', kind: 'daily_gmail_digest', interval_hours: 24, config: {}, enabled: true }]);
    if (url.includes('/rest/v1/agent_runs') && method === 'POST') return json({ id: 'run1' });
    if (url.includes('/rest/v1/agent_runs') || url.includes('/rest/v1/agent_schedules')) { updates.push({ url, method, body: JSON.parse(opts.body || 'null') }); return new Response(null, { status: 204 }); }
    if (url.includes('/rest/v1/connectors')) return json([{ id: 'c1', access_token: 'tok', token_expires_at: '2099-01-01T00:00:00Z', refresh_token: null }]);
    if (url.includes('/auth/v1/admin/users/')) return json({ id: '11111111-1111-4111-8111-111111111111', email: 'owner@me.example' });
    if (url.includes('gmail.googleapis.com')) return new Response(PROVIDER, { status: 403 });
    throw new Error('unexpected request in test: ' + url);
  };
  const r = res();
  await tick(authed, r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.results, [{ id: 's1', status: 'failed', error: 'run failed' }]);
  assert.ok(!JSON.stringify(r.body).includes('internal-detail-9b2c'));
  const stored = updates.filter((u) => u.method === 'PATCH').map((u) => u.body);
  assert.ok(stored.some((b) => b.status === 'failed' && String(b.error).includes('internal-detail-9b2c')), 'agent_runs keeps the full message');
  assert.ok(stored.some((b) => b.last_status === 'failed' && String(b.last_error).includes('internal-detail-9b2c')), 'last_error keeps it for the schedule owner');
  assert.ok(logged.some((l) => l.includes('internal-detail-9b2c')));
});

test('a schedule whose run row cannot be written: generic result, detail in the log', async () => {
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    const method = opts.method || 'GET';
    if (url.includes('/rest/v1/agent_schedules') && method === 'GET') return json([{ id: 's1', user_id: '11111111-1111-4111-8111-111111111111', kind: 'daily_gmail_digest', interval_hours: 24, config: {}, enabled: true }]);
    if (url.includes('/rest/v1/agent_runs') && method === 'POST') return json({ message: MARK, code: '23503' }, 409);
    throw new Error('unexpected request in test: ' + url);
  };
  const r = res();
  await tick(authed, r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.results, [{ id: 's1', error: 'could not record run' }]);
  assert.ok(!JSON.stringify(r.body).includes(MARK));
  assert.ok(logged.some((l) => l.includes(MARK)));
});

test('both endpoints still refuse a call without the secret', async () => {
  for (const h of [tick, reminders]) {
    const r = res();
    await h({ headers: {} }, r);
    assert.equal(r.statusCode, 401);
    assert.deepEqual(r.body, { error: 'Unauthorized' });
  }
});

test('front end: pending Confirm cards are dropped whenever the signed-in user changes, sign-out included', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /const sessionUserId = session\?\.user\?\.id\s*\n\s*useEffect\(\(\) => \{ setApprovals\(\[\]\) \}, \[sessionUserId\]\)/);
  assert.ok(app.indexOf("const [session, setSession]") < app.indexOf('const sessionUserId'), 'declared after the session state it reads');
});
