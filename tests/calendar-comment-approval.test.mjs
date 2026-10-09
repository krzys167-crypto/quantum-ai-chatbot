// F09b/c: editing or cancelling a calendar event that has guests, and commenting on a shared Drive file, are gated like
// outgoing mail. An event nobody else is on stays immediate. Real runTool + gate + approve handler; only the network
// edge (Supabase connector lookup, Google Calendar and Drive) is stubbed and RECORDS what would have left the account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArgs, digestArgs, guestEntries, MAX_ATTENDEES } from '../api/lib/approvals.js';
import { gateIrreversible, PROCEED } from '../api/lib/sendGuard.js';
import { world, installNetworkStub, restoreNetwork } from './helpers/mailWorld.mjs';
import { makeApprovalDb } from './helpers/fakeApprovalDb.mjs';

const USER = { id: 'u1' };
const quiet = () => { const w = []; return { warn: (m) => w.push(m), info() {}, error() {}, w }; };
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no error'; };

// ---- normalization -------------------------------------------------------------------------------------------------
test('update: absent fields stay absent (leave alone), empty strings stay (clear), extras and wrong types are dropped', () => {
  const a = normalizeArgs('update_calendar_event', { event_id: 'ev1', summary: 'New', location: '', notify: 'yes', all_day: 'true', attendees: 'a@b.co', user_confirmed: true, evil: 1 });
  assert.deepEqual(a, { event_id: 'ev1', summary: 'New', location: '' });
  assert.ok(!('notify' in a) && !('all_day' in a) && !('attendees' in a), 'a non-boolean flag / non-list is "not sent", never "false" / "[]"');
  assert.equal(normalizeArgs('update_calendar_event', { event_id: 'ev1', summary: 'x', notify: false }).notify, false);
  assert.equal(normalizeArgs('update_calendar_event', { event_id: 'ev1', summary: 'x', notify: true }).notify, true);
  assert.deepEqual(normalizeArgs('update_calendar_event', { event_id: 'ev1', add_attendees: [' Bob@Example.com ', 'bob@example.com', { email: 'Dan@Example.com', organizer: true }] }).add_attendees, ['bob@example.com', 'dan@example.com']);
});

test('update: refuses an edit that changes nothing, bad ids and bad guests now, not after Confirm', () => {
  assert.equal(code(() => normalizeArgs('update_calendar_event', { event_id: 'ev1' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('update_calendar_event', { event_id: 'ev1', notify: true })), 'invalid_args', 'notify alone is not a change');
  assert.equal(code(() => normalizeArgs('update_calendar_event', { summary: 'x' })), 'invalid_args');
  for (const bad of ['', 'a b', 'ev/1', 'ev\n1', 'x'.repeat(1025), '../x']) {
    assert.equal(code(() => normalizeArgs('update_calendar_event', { event_id: bad, summary: 'x' })), 'invalid_args', JSON.stringify(bad));
  }
  assert.equal(code(() => normalizeArgs('update_calendar_event', { event_id: 'ev1', add_attendees: ['not an address'] })), 'invalid_args');
  const many = Array.from({ length: MAX_ATTENDEES + 1 }, (_, i) => `g${i}@example.com`);
  assert.equal(code(() => normalizeArgs('update_calendar_event', { event_id: 'ev1', add_attendees: many })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('update_calendar_event', { event_id: 'ev1', start: 'next tuesday' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('update_calendar_event', { event_id: 'ev1', description: 'x'.repeat(8001) })), 'invalid_args');
});

test('delete: only the event and an explicit notify; an absent notify stays absent (Google then decides, not "false")', () => {
  assert.deepEqual(normalizeArgs('delete_calendar_event', { event_id: 'ev1', summary: 'x', user_confirmed: true }), { event_id: 'ev1' });
  assert.deepEqual(normalizeArgs('delete_calendar_event', { event_id: 'ev1', notify: false }), { event_id: 'ev1', notify: false });
  assert.deepEqual(normalizeArgs('delete_calendar_event', { event_id: 'ev1', notify: 'false' }), { event_id: 'ev1' });
  assert.equal(code(() => normalizeArgs('delete_calendar_event', {})), 'invalid_args');
});

test('comments: file and text are required, a reply needs text or an explicit resolve, ids are single tokens', () => {
  assert.deepEqual(normalizeArgs('add_file_comment', { file_id: 'file-1-id', comment: 'Please check B4', cell: 'B4', x: 1 }), { file_id: 'file-1-id', comment: 'Please check B4', cell: 'B4' });
  assert.equal(code(() => normalizeArgs('add_file_comment', { file_id: 'file-1-id' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('add_file_comment', { file_id: 'F1', comment: 'x' })), 'invalid_args', 'a 2-character id cannot be a Drive file id');
  assert.equal(code(() => normalizeArgs('add_file_comment', { comment: 'x' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('add_file_comment', { file_id: 'file 1', comment: 'x' })), 'invalid_args');
  assert.equal(code(() => normalizeArgs('add_file_comment', { file_id: 'file-1-id', comment: 'x'.repeat(8001) })), 'invalid_args');
  assert.deepEqual(normalizeArgs('reply_to_file_comment', { file_id: 'file-1-id', comment_id: 'c1', reply: 'Done', resolve: true }), { file_id: 'file-1-id', comment_id: 'c1', reply: 'Done', resolve: true });
  assert.deepEqual(normalizeArgs('reply_to_file_comment', { file_id: 'file-1-id', comment_id: 'c1', resolve: true }), { file_id: 'file-1-id', comment_id: 'c1', reply: '', resolve: true });
  assert.equal(code(() => normalizeArgs('reply_to_file_comment', { file_id: 'file-1-id', comment_id: 'c1' })), 'invalid_args', 'neither text nor resolve');
  assert.equal(code(() => normalizeArgs('reply_to_file_comment', { file_id: 'file-1-id', comment_id: 'c1', resolve: 'true' })), 'invalid_args', 'resolve must be a real boolean');
  assert.equal(code(() => normalizeArgs('reply_to_file_comment', { file_id: 'file-1-id', reply: 'x' })), 'invalid_args');
});

test('digest separates the new actions and every field they show', () => {
  const upd = { event_id: 'ev1', summary: 'A', add_attendees: ['b@c.de'] };
  const base = digestArgs('update_calendar_event', upd);
  for (const [f, v] of Object.entries({ event_id: 'ev2', summary: 'B', add_attendees: ['x@c.de'] })) assert.notEqual(base, digestArgs('update_calendar_event', { ...upd, [f]: v }), f);
  assert.notEqual(base, digestArgs('update_calendar_event', { ...upd, notify: false }));
  assert.notEqual(digestArgs('delete_calendar_event', { event_id: 'ev1' }), digestArgs('delete_calendar_event', { event_id: 'ev1', notify: false }));
  assert.notEqual(digestArgs('add_file_comment', { file_id: 'file-f-id', comment: 'x' }), digestArgs('add_file_comment', { file_id: 'file-f-id', comment: 'x', cell: 'A1' }));
  assert.notEqual(digestArgs('reply_to_file_comment', { file_id: 'file-f-id', comment_id: 'c', reply: 'x' }), digestArgs('reply_to_file_comment', { file_id: 'file-f-id', comment_id: 'c', reply: 'x', resolve: true }));
});

test('guestEntries counts what the executor would pass to Google, and nothing else', () => {
  assert.equal(guestEntries(undefined).length, 0);
  assert.equal(guestEntries('a@b.co').length, 0);
  assert.equal(guestEntries(['', null, {}, { email: '' }, 7]).length, 0);
  assert.equal(guestEntries(['a@b.co', { email: 'c@d.co' }]).length, 2);
});

// ---- the gate ------------------------------------------------------------------------------------------------------
const GUESTS = { event: { summary: 'Board', start: '2026-10-12T10:00:00Z', end: '2026-10-12T11:00:00Z', guests: ['bob@ex.example'], recurring: false } };
const ALONE = { event: { ...GUESTS.event, guests: [] } };
const run = (name, input, ctx = {}) => {
  const cards = [];
  const db = ctx.admin || makeApprovalDb();
  const onApprovalRequired = 'onApprovalRequired' in ctx ? ctx.onApprovalRequired : (c) => cards.push(c);
  return gateIrreversible(name, input, USER, { admin: db, env: {}, log: quiet(), ...ctx, onApprovalRequired }).then((r) => ({ r, cards, db }));
};
const rows = (db) => db.tables.approval_requests.length;

test('gate: an edit of an event nobody else is on is immediate (no card, no stored request)', async () => {
  for (const [name, input] of [['update_calendar_event', { event_id: 'ev1', summary: 'x' }], ['delete_calendar_event', { event_id: 'ev1' }], ['update_calendar_event', { event_id: 'ev1', attendees: [] }]]) {
    const { r, cards, db } = await run(name, input, { describe: async () => ALONE });
    assert.equal(r, PROCEED, name);
    assert.equal(cards.length, 0);
    assert.equal(rows(db), 0);
  }
});

test('gate: guest-free event, but the edit adds guests -> approval with the event as context', async () => {
  for (const input of [{ event_id: 'ev1', add_attendees: ['eve@evil.example'] }, { event_id: 'ev1', attendees: ['eve@evil.example'] }, { event_id: 'ev1', summary: 'x', add_attendees: [{ email: 'eve@evil.example' }] }]) {
    const { r, cards, db } = await run('update_calendar_event', input, { describe: async () => ALONE });
    assert.notEqual(r, PROCEED, JSON.stringify(input));
    assert.match(r.content, /^NOT DONE YET/);
    assert.equal(r.is_error, false);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].action, 'update_calendar_event');
    assert.deepEqual(cards[0].context, ALONE);
    assert.equal(rows(db), 1);
  }
});

test('gate: an event with guests is gated for update and delete, whatever the model claims about notifying them', async () => {
  for (const [name, input] of [
    ['update_calendar_event', { event_id: 'ev1', summary: 'Moved', notify: false, user_confirmed: true, approved: true }],
    ['update_calendar_event', { event_id: 'ev1', attendees: [] }],
    ['update_calendar_event', { event_id: 'ev1', remove_attendees: ['bob@ex.example'] }],
    ['delete_calendar_event', { event_id: 'ev1', notify: false, user_confirmed: true }],
  ]) {
    const { r, cards, db } = await run(name, input, { describe: async () => GUESTS });
    assert.notEqual(r, PROCEED, `${name} ${JSON.stringify(input)}`);
    assert.match(r.content, /^NOT DONE YET/);
    assert.equal(cards.length, 1);
    assert.ok(!('user_confirmed' in cards[0].fields) && !('approved' in cards[0].fields));
    assert.equal(rows(db), 1);
  }
});

test('gate reads the event once per request (no second, possibly different, read for the card)', async () => {
  let n = 0;
  const { cards } = await run('update_calendar_event', { event_id: 'ev1', summary: 'x' }, { describe: async () => { n += 1; return GUESTS; } });
  assert.equal(n, 1);
  assert.deepEqual(cards[0].context, GUESTS);
});

test('gate fails closed when the event cannot be read: nothing is stored, nothing proceeds', async () => {
  const bad = [async () => { throw new Error('Calendar get failed: 500'); }, async () => null, async () => ({}), async () => ({ event: {} }), async () => ({ event: { guests: 'bob@ex.example' } }), async () => ({ event: { guests: null } })];
  for (const describe of bad) {
    for (const [name, input] of [['update_calendar_event', { event_id: 'ev1', summary: 'x' }], ['delete_calendar_event', { event_id: 'ev1' }]]) {
      const { r, cards, db } = await run(name, input, { describe });
      assert.notEqual(r, PROCEED, name);
      assert.equal(r.is_error, true);
      assert.match(r.content, /could not be read/);
      assert.equal(cards.length, 0);
      assert.equal(rows(db), 0);
    }
  }
  const noDescribe = await run('update_calendar_event', { event_id: 'ev1', summary: 'x' });
  assert.equal(noDescribe.r.is_error, true, 'no way to read the event at all -> blocked');
});

test('gate without a card channel: guest-free edits still work, anything that reaches people is blocked and stores nothing', async () => {
  const ok = await run('update_calendar_event', { event_id: 'ev1', summary: 'x' }, { onApprovalRequired: undefined, describe: async () => ALONE });
  assert.equal(ok.r, PROCEED);
  for (const [name, input, d] of [
    ['update_calendar_event', { event_id: 'ev1', summary: 'x' }, GUESTS],
    ['update_calendar_event', { event_id: 'ev1', add_attendees: ['e@x.yz'] }, ALONE],
    ['delete_calendar_event', { event_id: 'ev1' }, GUESTS],
  ]) {
    const { r, db } = await run(name, input, { onApprovalRequired: undefined, describe: async () => d });
    assert.equal(r.is_error, true, name);
    assert.match(r.content, /non-interactive/);
    assert.equal(rows(db), 0);
  }
});

test('gate: comments are always gated (they notify everyone with access); the file name is only context', async () => {
  for (const [name, input] of [['add_file_comment', { file_id: 'file-1-id', comment: 'Ping', user_confirmed: true }], ['reply_to_file_comment', { file_id: 'file-1-id', comment_id: 'c1', reply: 'Done', resolve: true }]]) {
    const withName = await run(name, input, { describe: async () => ({ file: { name: 'Budget', type: 'application/vnd.google-apps.spreadsheet' } }) });
    assert.match(withName.r.content, /^NOT DONE YET/, name);
    assert.deepEqual(withName.cards[0].context, { file: { name: 'Budget', type: 'application/vnd.google-apps.spreadsheet' } });
    const noName = await run(name, input, { describe: async () => { throw new Error('drive down'); } });
    assert.match(noName.r.content, /^NOT DONE YET/, 'a failing lookup only loses the file name; the card still shows the exact fields');
    assert.equal(noName.cards[0].context, null);
    assert.equal(noName.cards[0].fields.file_id, 'file-1-id');
    const cardless = await run(name, input, { onApprovalRequired: undefined });
    assert.equal(cardless.r.is_error, true);
    assert.match(cardless.r.content, /non-interactive/);
    assert.equal(rows(cardless.db), 0);
  }
});

test('gate: legacy mode is the logged emergency switch for the new actions too; an unknown mode blocks', async () => {
  const log = quiet();
  for (const [name, input] of [['update_calendar_event', { event_id: 'ev1', summary: 'x' }], ['delete_calendar_event', { event_id: 'ev1' }], ['add_file_comment', { file_id: 'file-f-id', comment: 'x' }]]) {
    const { r, db } = await run(name, input, { env: { APPROVAL_MODE: 'legacy' }, log });
    assert.equal(r, PROCEED, name);
    assert.equal(rows(db), 0);
  }
  assert.equal(log.w.filter((m) => /legacy/.test(m) && /F09 open/.test(m)).length, 3);
  const invalid = await run('delete_calendar_event', { event_id: 'ev1' }, { env: { APPROVAL_MODE: 'off' }, describe: async () => ALONE });
  assert.equal(invalid.r.is_error, true);
});

test('gate: invalid input is refused with its reason and stores nothing', async () => {
  const { r, db } = await run('update_calendar_event', { event_id: 'ev1', add_attendees: ['not an address'] }, { describe: async () => ALONE });
  assert.equal(r.is_error, true);
  assert.match(r.content, /invalid e-mail address/);
  assert.equal(rows(db), 0);
});

// ---- end to end: the real runTool and approve handler against a recording Google --------------------------------------
const g = { events: new Map(), files: new Map(), connected: new Set(), writes: [], reads: [] };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const event = (over = {}) => ({
  id: 'ev1', status: 'confirmed', summary: 'Board', start: { dateTime: '2026-10-12T10:00:00Z' }, end: { dateTime: '2026-10-12T11:00:00Z' },
  attendees: [{ email: 'owner@me.example', self: true, organizer: true }, { email: 'bob@ex.example' }], ...over,
});
const ALONE_EV = () => event({ attendees: [{ email: 'owner@me.example', self: true, organizer: true }] });

function installGoogle() {
  installNetworkStub();
  const base = globalThis.fetch;
  g.events.clear(); g.files.clear(); g.writes.length = 0; g.reads.length = 0;
  g.connected = new Set(['google_calendar', 'google_drive']);
  g.failWith = null;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    const conn = /provider=eq\.([a-z_]+)/.exec(u);
    if (u.includes('/rest/v1/connectors') && conn) {
      return g.connected.has(conn[1]) ? json([{ id: 'c-' + conn[1], access_token: 'tok-' + conn[1], token_expires_at: '2099-01-01T00:00:00Z', refresh_token: null }]) : json([]);
    }
    let m = /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\/([^/?]+)(\?.*)?$/.exec(u);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const ev = g.events.get(id);
      if (method === 'GET') { g.reads.push({ kind: 'event', id }); return ev ? json(ev) : json({ error: 'nf' }, 404); }
      if (g.failWith) return json({ error: 'x' }, g.failWith);
      g.writes.push({ kind: 'event', method, id, params: Object.fromEntries(new URLSearchParams(m[2] || '')), body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.Authorization });
      if (method === 'PATCH') return json({ ...ev, ...JSON.parse(opts.body) });
      if (method === 'DELETE') return new Response(null, { status: 204 });
    }
    m = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)\/comments(?:\/([^/?]+)\/replies)?(\?.*)?$/.exec(u);
    if (m && method === 'POST') {
      if (g.failWith) return json({ error: 'x' }, g.failWith);
      g.writes.push({ kind: m[2] ? 'reply' : 'comment', file: decodeURIComponent(m[1]), comment: m[2], body: JSON.parse(opts.body), auth: opts.headers?.Authorization });
      return json({ id: 'new1', content: JSON.parse(opts.body).content, createdTime: '2026-10-12T10:00:00Z', action: JSON.parse(opts.body).action });
    }
    m = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)\?/.exec(u);
    if (m && method === 'GET') {
      g.reads.push({ kind: 'file', id: decodeURIComponent(m[1]) });
      const f = g.files.get(decodeURIComponent(m[1]));
      return f ? json(f) : json({ error: 'nf' }, 404);
    }
    return base(url, opts);
  };
}
test.beforeEach(() => installGoogle());
test.after(() => restoreNetwork());

test('e2e update: guests on the event -> nothing is PATCHed until Confirm, then exactly the stored change is, once', async () => {
  g.events.set('ev1', event());
  const w = world();
  const out = await w.model('update_calendar_event', { event_id: 'ev1', start: '2026-10-13T10:00:00Z', end: '2026-10-13T11:00:00Z', notify: false, user_confirmed: true });
  assert.match(out.content, /^NOT DONE YET/);
  assert.deepEqual(g.writes, [], 'no write to Calendar before Confirm');
  const [card] = w.cards;
  assert.equal(card.action, 'update_calendar_event');
  assert.deepEqual(card.context.event.guests, ['bob@ex.example'], 'the card lists the guests as Calendar reported them, without the owner');
  assert.equal(card.context.event.summary, 'Board');
  const r = await w.approve(card.id);
  assert.deepEqual(r.body, { ok: true, status: 'done', action: 'update_calendar_event' });
  assert.equal(g.writes.length, 1);
  assert.equal(g.writes[0].method, 'PATCH');
  assert.equal(g.writes[0].params.sendUpdates, 'none', 'the stored notify:false is honored exactly');
  assert.equal(g.writes[0].body.start.dateTime, '2026-10-13T10:00:00.000Z');
  assert.equal((await w.approve(card.id)).statusCode, 404);
  assert.equal(g.writes.length, 1, 'a replay writes nothing more');
});

test('e2e update: Cancel changes nothing; another user cannot release it', async () => {
  g.events.set('ev1', event());
  const w = world();
  await w.model('update_calendar_event', { event_id: 'ev1', summary: 'Renamed' });
  const id = w.cards[0].id;
  assert.equal((await w.approve(id, 'mallory')).statusCode, 404);
  const r = await w.approve(id, 'u1', 'reject');
  assert.deepEqual(r.body, { ok: true, status: 'cancelled', action: 'update_calendar_event' });
  assert.deepEqual(g.writes, []);
});

test('e2e update: an event nobody else is on is changed immediately, with no card and no stored request', async () => {
  g.events.set('ev1', ALONE_EV());
  const w = world();
  const out = await w.model('update_calendar_event', { event_id: 'ev1', summary: 'Solo focus' });
  assert.equal(w.cards.length, 0);
  assert.equal(w.db.tables.approval_requests.length, 0);
  assert.equal(g.writes.length, 1);
  assert.equal(g.writes[0].body.summary, 'Solo focus');
  assert.equal(JSON.parse(out.content).summary, 'Solo focus');
});

test('e2e bypass attempt: creating a guest-free event and then adding a guest by update is still gated', async () => {
  g.events.set('ev1', ALONE_EV());
  const w = world();
  const out = await w.model('update_calendar_event', { event_id: 'ev1', add_attendees: ['attacker@evil.example'], notify: true, user_confirmed: true });
  assert.match(out.content, /^NOT DONE YET/);
  assert.deepEqual(g.writes, []);
  assert.deepEqual(w.cards[0].fields.add_attendees, ['attacker@evil.example']);
  assert.deepEqual(w.cards[0].context.event.guests, [], 'the card shows who is on the event now, so the new guest is visible as new');
});

test('e2e update: if Calendar cannot be read the model gets a block, not a write', async () => {
  const w = world();
  const missing = await w.model('update_calendar_event', { event_id: 'nope', summary: 'x' });
  assert.equal(missing.is_error, true);
  assert.match(missing.content, /could not be read/);
  g.connected.delete('google_calendar');
  g.events.set('ev1', event());
  const offline = await w.model('delete_calendar_event', { event_id: 'ev1' });
  assert.equal(offline.is_error, true);
  assert.deepEqual(g.writes, []);
  assert.equal(w.cards.length, 0);
  assert.equal(w.db.tables.approval_requests.length, 0);
});

test('e2e delete: guests -> approval, then one DELETE with the stored notify choice', async () => {
  g.events.set('ev1', event());
  const w = world();
  const out = await w.model('delete_calendar_event', { event_id: 'ev1', user_confirmed: true });
  assert.match(out.content, /^NOT DONE YET/);
  assert.deepEqual(g.writes, []);
  const r = await w.approve(w.cards[0].id);
  assert.deepEqual(r.body, { ok: true, status: 'done', action: 'delete_calendar_event' });
  assert.equal(g.writes.length, 1);
  assert.equal(g.writes[0].method, 'DELETE');
  assert.equal(g.writes[0].params.sendUpdates, 'all', 'absent notify -> the helper default, which tells the guests');
});

test('e2e: an already cancelled event is not described as editable; nothing is stored or written', async () => {
  g.events.set('ev1', event({ status: 'cancelled' }));
  const w = world();
  for (const [name, input] of [['update_calendar_event', { event_id: 'ev1', summary: 'x' }], ['delete_calendar_event', { event_id: 'ev1' }]]) {
    const out = await w.model(name, input);
    assert.equal(out.is_error, true, name);
    assert.match(out.content, /could not be read/);
  }
  assert.deepEqual(g.writes, []);
  assert.equal(w.cards.length, 0);
  assert.equal(w.db.tables.approval_requests.length, 0);
});

test('e2e delete: the stored notify choice is what Calendar receives', async () => {
  g.events.set('ev1', event());
  const w = world();
  await w.model('delete_calendar_event', { event_id: 'ev1', notify: false });
  assert.equal(w.cards[0].fields.notify, false);
  await w.approve(w.cards[0].id);
  assert.equal(g.writes.length, 1);
  assert.equal(g.writes[0].params.sendUpdates, 'none');
});

test('e2e delete: an event nobody else is on is cancelled immediately (as before)', async () => {
  g.events.set('ev1', ALONE_EV());
  const w = world();
  const out = await w.model('delete_calendar_event', { event_id: 'ev1' });
  assert.equal(w.cards.length, 0);
  assert.equal(g.writes.length, 1);
  assert.equal(JSON.parse(out.content).deleted, true);
});

test('e2e comment: nothing is posted until Confirm; the card names the file; the stored text is what Drive receives', async () => {
  g.files.set('file-1-id', { name: 'Q3 budget', mimeType: 'application/vnd.google-apps.spreadsheet' });
  const w = world();
  const out = await w.model('add_file_comment', { file_id: 'file-1-id', comment: 'Please check B4', cell: 'B4', user_confirmed: true });
  assert.match(out.content, /^NOT DONE YET/);
  assert.deepEqual(g.writes, []);
  assert.deepEqual(w.cards[0].context, { file: { name: 'Q3 budget', type: 'application/vnd.google-apps.spreadsheet' } });
  const r = await w.approve(w.cards[0].id);
  assert.deepEqual(r.body, { ok: true, status: 'done', action: 'add_file_comment' });
  assert.equal(g.writes.length, 1);
  assert.equal(g.writes[0].kind, 'comment');
  assert.equal(g.writes[0].file, 'file-1-id');
  assert.equal(g.writes[0].body.content, '[B4] Please check B4');
  assert.equal((await w.approve(w.cards[0].id)).statusCode, 404);
  assert.equal(g.writes.length, 1);
});

test('e2e reply to a comment: resolve is a stored, shown choice and reaches Drive only after Confirm', async () => {
  g.files.set('file-1-id', { name: 'Q3 budget', mimeType: 'application/vnd.google-apps.spreadsheet' });
  const w = world();
  await w.model('reply_to_file_comment', { file_id: 'file-1-id', comment_id: 'c9', reply: 'Fixed', resolve: true });
  assert.deepEqual(g.writes, []);
  assert.equal(w.cards[0].fields.resolve, true);
  const r = await w.approve(w.cards[0].id);
  assert.equal(r.body.status, 'done');
  assert.deepEqual(g.writes.map((x) => [x.kind, x.file, x.comment, x.body.content, x.body.action]), [['reply', 'file-1-id', 'c9', 'Fixed', 'resolve']]);
});

test('e2e comment: reading comments stays ungated, and the file name lookup failing does not block the card', async () => {
  const w = world();
  const out = await w.model('add_file_comment', { file_id: 'unknown', comment: 'hello' });
  assert.match(out.content, /^NOT DONE YET/);
  assert.equal(w.cards[0].context, null);
  assert.deepEqual(g.writes, []);
});

test('endpoint: a refused comment names Drive and says nothing was posted; a view-only 403 on reading is explained', async () => {
  g.files.set('file-1-id', { name: 'Q3 budget', mimeType: 'x' });
  const w = world();
  await w.model('add_file_comment', { file_id: 'file-1-id', comment: 'hi' });
  g.failWith = 403;
  const refused = await w.approve(w.cards[0].id);
  assert.equal(refused.statusCode, 502);
  assert.match(refused.body.error, /Google Drive refused the request \(HTTP 403\)\. Nothing was posted\./);
  assert.ok(!/Gmail|Sent folder/.test(refused.body.error));
  // reading comments is not gated; a 403 there is a sharing problem and is explained as such
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => (/\/drive\/v3\/files\/[^/]+\/comments\?/.test(String(url)) && (opts.method || 'GET') === 'GET' ? json({ error: 'forbidden' }, 403) : real(url, opts));
  try {
    const { runTool } = await import('../api/lib/claudeTools.js');
    const out = await runTool({ id: 'r1', name: 'read_file_comments', input: { file_id: 'file-1-id' } }, { id: 'u1' }, {});
    assert.equal(out.is_error, true);
    assert.match(out.content, /view-only access/);
  } finally { globalThis.fetch = real; }
});

test('endpoint: failures name the right service and never claim success; "not connected" is explicit', async () => {
  g.files.set('file-1-id', { name: 'Q3 budget', mimeType: 'x' });
  g.events.set('ev1', event());
  const w = world();
  await w.model('add_file_comment', { file_id: 'file-1-id', comment: 'hi' });
  g.connected.delete('google_drive');
  const offline = await w.approve(w.cards[0].id);
  assert.equal(offline.statusCode, 502);
  assert.match(offline.body.error, /Google Drive is not connected for this account \(comments need the Google Drive connector\)\. Nothing was posted\./);

  const w2 = world();
  await w2.model('update_calendar_event', { event_id: 'ev1', summary: 'x' });
  g.failWith = 403;
  const refused = await w2.approve(w2.cards[0].id);
  assert.equal(refused.statusCode, 502);
  assert.match(refused.body.error, /Google Calendar refused the request \(HTTP 403\)\. Nothing was changed\./);

  const w3 = world();
  await w3.model('delete_calendar_event', { event_id: 'ev1' });
  g.failWith = 503;
  const unsure = await w3.approve(w3.cards[0].id);
  assert.equal(unsure.statusCode, 502);
  assert.match(unsure.body.error, /may or may not have gone through: check your calendar/);
  assert.ok(!JSON.stringify(unsure.body).includes('bob@ex.example'));
});
