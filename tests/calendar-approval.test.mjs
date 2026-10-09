// F09b: calendar events that invite guests go through the same server-held approval as outgoing mail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArgs, digestArgs, attendeeEntries, createPending, decidePending, MAX_ATTENDEES } from '../api/lib/approvals.js';
import { gateIrreversible } from '../api/lib/sendGuard.js';
import { makeApproveHandler } from '../api/lib/approveHandler.js';
import { runTool, performIrreversible, CREATE_EVENT_TOOL } from '../api/lib/claudeTools.js';
import { makeApprovalDb } from './helpers/fakeApprovalDb.mjs';

const T0 = 1_800_000_000_000;
const USER = { id: 'u1' };
const EVENT = { summary: 'Kickoff', start: '2026-10-12T10:00:00Z', end: '2026-10-12T11:00:00Z', time_zone: 'Europe/Warsaw', location: 'Room 1', description: 'Agenda inside', attendees: ['Bob@Example.com', 'carol@example.com'] };
const quiet = () => { const w = []; return { warn: (m) => w.push(m), info() {}, error() {}, w }; };
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no error'; };

test('normalize: canonical guests (trimmed, lower-case, unique, objects reduced to the address), strict all_day, extras dropped', () => {
  const a = normalizeArgs('create_calendar_event', { ...EVENT, attendees: [' Bob@Example.com ', 'bob@example.com', { email: 'Dan@Example.com', responseStatus: 'accepted', organizer: true }, 'carol@example.com'], all_day: 'false', user_confirmed: true, evil: 1 });
  assert.deepEqual(a.attendees, ['bob@example.com', 'dan@example.com', 'carol@example.com']);
  assert.equal(a.all_day, false);
  assert.equal(normalizeArgs('create_calendar_event', { ...EVENT, all_day: true }).all_day, true);
  assert.deepEqual(Object.keys(a).sort(), ['all_day', 'attendees', 'description', 'end', 'location', 'start', 'summary', 'time_zone']);
});

test('normalize: refuses bad guests and bad dates now, not after the user pressed Confirm', () => {
  for (const bad of ['a b@c.de', 'a@b', '<a@b.co>', 'a@b.co, d@e.fg', 'x@y.zz;z@y.zz', '"q"@b.co', 'x'.repeat(250) + '@b.co', '@b.co']) {
    assert.equal(code(() => normalizeArgs('create_calendar_event', { ...EVENT, attendees: [bad] })), 'invalid_args', bad);
  }
  const many = Array.from({ length: MAX_ATTENDEES + 1 }, (_, i) => `g${i}@example.com`);
  assert.equal(code(() => normalizeArgs('create_calendar_event', { ...EVENT, attendees: many })), 'invalid_args');
  assert.equal(normalizeArgs('create_calendar_event', { ...EVENT, attendees: many.slice(0, MAX_ATTENDEES) }).attendees.length, MAX_ATTENDEES);
  assert.equal(code(() => normalizeArgs('create_calendar_event', { ...EVENT, start: 'next tuesday' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('create_calendar_event', { ...EVENT, end: 'soon' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('create_calendar_event', { ...EVENT, summary: '  ' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('create_calendar_event', { ...EVENT, attendees: [] })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('create_calendar_event', { ...EVENT, description: 'x'.repeat(8001) })), 'invalid_args');
});

test('attendeeEntries is exactly what createCalendarEvent would invite (gate and executor agree)', () => {
  assert.equal(attendeeEntries({}).length, 0);
  assert.equal(attendeeEntries({ attendees: 'a@b.co' }).length, 0, 'a non-array is ignored by the executor, so it is not a guest');
  assert.equal(attendeeEntries({ attendees: [] }).length, 0);
  assert.equal(attendeeEntries({ attendees: ['', null, undefined, 0, {}, { email: '' }, 7] }).length, 0);
  assert.equal(attendeeEntries({ attendees: ['a@b.co', { email: 'c@d.co' }, ''] }).length, 2);
  assert.equal(attendeeEntries({ attendees: [' '] }).length, 1, 'a blank string is still passed to Google by the executor, so it counts and is then refused as invalid');
});

test('digest depends on every guest and on the event fields', () => {
  const base = digestArgs('create_calendar_event', EVENT);
  assert.notEqual(base, digestArgs('create_calendar_event', { ...EVENT, attendees: [...EVENT.attendees, 'eve@example.com'] }));
  const changed = { summary: 'Kickoff 2', start: '2026-10-13T10:00:00Z', end: '2026-10-13T11:00:00Z', time_zone: 'UTC', location: 'Room 2', description: 'Other agenda' };
  for (const [f, v] of Object.entries(changed)) assert.notEqual(base, digestArgs('create_calendar_event', { ...EVENT, [f]: v }), f);
  assert.notEqual(base, digestArgs('create_calendar_event', { ...EVENT, all_day: true }));
  assert.equal(base, digestArgs('create_calendar_event', { ...EVENT, attendees: ['BOB@example.com', 'carol@example.com'], junk: 1 }));
});

test('store round trip: guests stay a list, and a row tampered with a new guest is discarded', async () => {
  const db = makeApprovalDb();
  const p = await createPending({ admin: db, userId: 'u1', action: 'create_calendar_event', args: EVENT, now: T0 });
  assert.deepEqual(db.tables.approval_requests[0].args.attendees, ['bob@example.com', 'carol@example.com']);
  db.tables.approval_requests[0].args.attendees.push('attacker@evil.example');
  assert.deepEqual(await decidePending({ admin: db, userId: 'u1', id: p.id, decision: 'approve', now: T0 + 1 }), { ok: false, reason: 'corrupt' });
  const p2 = await createPending({ admin: db, userId: 'u1', action: 'create_calendar_event', args: EVENT, now: T0 });
  const r = await decidePending({ admin: db, userId: 'u1', id: p2.id, decision: 'approve', now: T0 + 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.args.attendees, ['bob@example.com', 'carol@example.com']);
});

// ---- the gate
const gate = (input, ctx = {}) => {
  const cards = [];
  const db = ctx.admin || makeApprovalDb();
  return gateIrreversible('create_calendar_event', input, USER, { admin: db, onApprovalRequired: (c) => cards.push(c), env: {}, log: quiet(), ...ctx }).then((r) => ({ r, cards, db }));
};

test('gate: an event without guests is not gated (no card, no stored request)', async () => {
  for (const attendees of [undefined, [], [''], [null, {}], 'a@b.co', 7]) {
    const { r, cards, db } = await gate({ summary: 's', start: '2026-10-12T10:00:00Z', attendees });
    assert.equal(r, null, JSON.stringify(attendees));
    assert.equal(cards.length, 0);
    assert.equal(db.tables.approval_requests.length, 0);
  }
});

test('gate: with guests the model can never create it, whatever it claims', async () => {
  const { r, cards, db } = await gate({ ...EVENT, user_confirmed: true, approved: true, approval_token: 'forged' });
  assert.equal(r.is_error, false);
  assert.match(r.content, /^NOT CREATED YET/);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].action, 'create_calendar_event');
  assert.deepEqual(cards[0].fields.attendees, ['bob@example.com', 'carol@example.com']);
  assert.ok(!('user_confirmed' in cards[0].fields) && !('approved' in cards[0].fields));
  assert.equal(db.tables.approval_requests.length, 1);
});

test('gate: bad guests are blocked with a reason and store nothing; no card channel blocks without an orphan row', async () => {
  const bad = await gate({ ...EVENT, attendees: ['not an address'] });
  assert.equal(bad.r.is_error, true);
  assert.match(bad.r.content, /invalid e-mail address/);
  assert.equal(bad.db.tables.approval_requests.length, 0);
  const db = makeApprovalDb();
  const r = await gateIrreversible('create_calendar_event', EVENT, USER, { admin: db, env: {}, log: quiet() });
  assert.equal(r.is_error, true);
  assert.match(r.content, /without guests/);
  assert.equal(db.tables.approval_requests.length, 0);
});

test('gate: legacy mode is the explicit emergency switch and says so; an unknown mode blocks', async () => {
  const log = quiet();
  const legacy = await gate(EVENT, { env: { APPROVAL_MODE: 'legacy' }, log });
  assert.equal(legacy.r, null);
  assert.ok(log.w.some((m) => /legacy/.test(m) && /F09 open/.test(m)));
  const invalid = await gate(EVENT, { env: { APPROVAL_MODE: 'nope' } });
  assert.equal(invalid.r.is_error, true);
});

// ---- the real runTool / performIrreversible, with Supabase and Google stubbed at fetch level
const realFetch = globalThis.fetch;
const env0 = { url: process.env.VITE_SUPABASE_URL, sb: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
const calls = [];
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
test.before(() => {
  process.env.VITE_SUPABASE_URL = 'http://sb.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body ? String(init.body) : undefined });
    if (u.startsWith('http://sb.test/rest/v1/connectors')) return json({ id: 'c1', access_token: 'cal-token', token_expires_at: new Date(Date.now() + 3_600_000).toISOString(), status: 'connected' });
    if (u === 'https://www.googleapis.com/calendar/v3/calendars/primary/events') return json({ id: 'ev1', summary: 'Kickoff', start: { dateTime: '2026-10-12T10:00:00Z' }, end: { dateTime: '2026-10-12T11:00:00Z' }, htmlLink: 'https://cal.test/ev1', status: 'confirmed' });
    throw new Error('unexpected request: ' + u);
  };
});
test.after(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of [['VITE_SUPABASE_URL', env0.url], ['SUPABASE_URL', env0.sb], ['SUPABASE_SERVICE_ROLE_KEY', env0.key]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete process.env.APPROVAL_MODE;
});
test.beforeEach(() => { calls.length = 0; delete process.env.APPROVAL_MODE; });
const eventPosts = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/calendar/v3/'));

test('runTool: an event with guests files a pending approval and never reaches the Calendar API', async () => {
  const admin = makeApprovalDb();
  const cards = [];
  const out = await runTool({ id: 't1', name: 'create_calendar_event', input: { ...EVENT, user_confirmed: true } }, USER, { admin, onApprovalRequired: (c) => cards.push(c) });
  assert.match(out.content, /^NOT CREATED YET/);
  assert.equal(out.is_error, false);
  assert.equal(cards.length, 1);
  assert.equal(admin.tables.approval_requests.length, 1);
  assert.deepEqual(eventPosts(), []);
  assert.deepEqual(calls.filter((c) => /googleapis/.test(c.url)), [], 'not even a token lookup for Google');
});

test('runTool: an event without guests is created immediately and carries no attendees', async () => {
  const out = await runTool({ id: 't2', name: 'create_calendar_event', input: { summary: 'Solo', start: '2026-10-12T10:00:00Z', attendees: [] } }, USER, {});
  assert.equal(eventPosts().length, 1);
  assert.ok(!('attendees' in JSON.parse(eventPosts()[0].body)));
  assert.equal(JSON.parse(out.content).id, 'ev1');
});

test('runTool: no guests and no admin client in the context needs no approval store at all', async () => {
  // the lazy admin getter is only evaluated for guests: with no Supabase env the failure comes from the connector lookup, not the gate
  const saved = process.env.VITE_SUPABASE_URL;
  delete process.env.VITE_SUPABASE_URL; delete process.env.SUPABASE_URL;
  try {
    await assert.rejects(runTool({ id: 't3', name: 'create_calendar_event', input: { summary: 'Solo', start: '2026-10-12T10:00:00Z' } }, USER, {}), /Missing SUPABASE_URL/);
  } finally { process.env.VITE_SUPABASE_URL = saved; }
  assert.deepEqual(eventPosts(), []);
});

test('performIrreversible after Confirm: the STORED, normalized guests are what Google receives', async () => {
  const db = makeApprovalDb();
  const p = await createPending({ admin: db, userId: 'u1', action: 'create_calendar_event', args: { ...EVENT, attendees: [{ email: 'Bob@Example.com', optional: true, organizer: true }, 'carol@example.com'] }, now: T0 });
  const d = await decidePending({ admin: db, userId: 'u1', id: p.id, decision: 'approve', now: T0 + 1 });
  const out = await performIrreversible(d.action, d.args, USER);
  assert.equal(eventPosts().length, 1);
  const body = JSON.parse(eventPosts()[0].body);
  assert.deepEqual(body.attendees, [{ email: 'bob@example.com' }, { email: 'carol@example.com' }]);
  assert.equal(body.summary, 'Kickoff');
  assert.equal(body.description, 'Agenda inside');
  assert.equal(JSON.parse(out.content).id, 'ev1');
});

test('tool schema tells the model that guests need the Confirm card', () => {
  assert.match(CREATE_EVENT_TOOL.description, /Confirm card/);
  assert.match(CREATE_EVENT_TOOL.description, /Never say guests were invited/);
});

// ---- the endpoint
function res() {
  const r = { statusCode: 200, body: undefined, setHeader() {}, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } };
  return r;
}
async function approve(perform, decision = 'approve') {
  const db = makeApprovalDb();
  const p = await createPending({ admin: db, userId: 'u1', action: 'create_calendar_event', args: EVENT, now: T0 });
  const handler = makeApproveHandler({ getUser: async () => USER, getAdmin: () => db, perform, log: quiet(), now: () => T0 + 1000 });
  const r = res();
  await handler({ method: 'POST', headers: { authorization: 'Bearer x' }, body: { id: p.id, decision } }, r);
  return { r, db };
}

test('endpoint: Confirm creates the event once from the stored arguments and reports "created"', async () => {
  const seen = [];
  const { r, db } = await approve(async (action, args, user) => { seen.push({ action, args, user: user.id }); return { content: '{}' }; });
  assert.deepEqual(r.body, { ok: true, status: 'created', action: 'create_calendar_event' });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].args.attendees, ['bob@example.com', 'carol@example.com']);
  assert.equal(db.tables.approval_requests.length, 0);
});

test('endpoint: Cancel creates nothing; failures speak about the calendar and leak no provider text', async () => {
  const seen = [];
  const cancelled = await approve(async () => { seen.push(1); return {}; }, 'reject');
  assert.deepEqual(cancelled.r.body, { ok: true, status: 'cancelled', action: 'create_calendar_event' });
  assert.equal(seen.length, 0);
  const failed = await approve(async () => { throw new Error('Calendar create failed: 403 {"detail":"guest list: bob@example.com"}'); });
  assert.equal(failed.r.statusCode, 502);
  assert.match(failed.r.body.error, /Google Calendar refused the request \(HTTP 403\)\. Nothing was created\./);
  assert.ok(!JSON.stringify(failed.r.body).includes('bob@example.com'));
  const offline = await approve(async () => ({ is_error: true, content: 'Google Calendar is not connected.' }));
  assert.equal(offline.r.statusCode, 502);
  assert.match(offline.r.body.error, /Google Calendar is not connected for this account\. Nothing was created\./);
});
