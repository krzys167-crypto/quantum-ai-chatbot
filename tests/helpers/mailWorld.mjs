// End-to-end harness for the mail approval flow: the real runTool() (gate + tools), the real approve handler, the real
// MIME encoders and the real Gmail helpers. Only the network edge is replaced: Supabase (connector token) and the
// Gmail / Calendar HTTP APIs are answered by a stub that RECORDS what would have left the account.
import { makeApprovalDb } from './fakeApprovalDb.mjs';
import { makeApproveHandler } from '../../api/lib/approveHandler.js';

process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub';
delete process.env.APPROVAL_MODE;
const { runTool, performIrreversible } = await import('../../api/lib/claudeTools.js');

export const sends = []; // every message handed to Gmail: { raw, threadId }
export const events = []; // every calendar event handed to Google
export const calls = []; // every URL requested
export const original = { headers: null, status: 200 }; // the received message the stub serves

export const defaultOriginal = () => [
  { name: 'From', value: 'Mallory <mallory@evil.example>' },
  { name: 'To', value: 'owner@me.example, boss@corp.example' },
  { name: 'Cc', value: 'cfo@corp.example' },
  { name: 'Subject', value: 'Invoice' },
  { name: 'Date', value: 'Mon, 12 Oct 2026 10:00:00 +0000' },
  { name: 'Message-ID', value: '<a@b>' },
];

const realFetch = globalThis.fetch;
export function installNetworkStub() {
  original.headers = defaultOriginal();
  original.status = 200;
  sends.length = 0; events.length = 0; calls.length = 0;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    calls.push(url);
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    if (url.includes('/rest/v1/connectors')) return json([{ id: 'c1', access_token: 'tok', token_expires_at: '2099-01-01T00:00:00Z', refresh_token: null }]);
    if (url.includes('/messages/send')) { sends.push({ ...JSON.parse(opts.body) }); return json({ id: 'sent1', threadId: 'th', labelIds: [] }); }
    if (url.includes('/calendar/v3/calendars/primary/events') && opts.method === 'POST') { events.push(JSON.parse(opts.body)); return json({ id: 'e1', summary: 'x', start: { dateTime: 'x' }, end: { dateTime: 'y' }, htmlLink: 'l', status: 'confirmed' }); }
    if (/\/messages\/[^/?]+\?format=full/.test(url)) {
      if (original.status !== 200) return json({ error: 'quota' }, original.status);
      return json({ id: 'orig', threadId: 'th', payload: { headers: original.headers, body: { data: Buffer.from('original body').toString('base64url') } } });
    }
    throw new Error('unexpected request in test: ' + url);
  };
}
export const restoreNetwork = () => { globalThis.fetch = realFetch; };

export const decodeRaw = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
/** Parsed view of a raw MIME message: header lines (as [name, value]) and body. Fails the test on a bare "\n" header injection too. */
export function parseMime(raw) {
  const text = decodeRaw(raw);
  const cut = text.indexOf('\r\n\r\n');
  const head = text.slice(0, cut);
  const lines = head.split('\r\n');
  return { lines, headers: lines.map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]), body: text.slice(cut + 4), rawHeadBlock: head };
}
export const headerNames = (mime) => mime.headers.map(([n]) => n);
export const headerOf = (mime, name) => mime.headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];

const quiet = { info() {}, error() {}, warn() {} };
const res = () => { const r = { statusCode: 200, body: null, setHeader() {}, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

export function world(userId = 'u1') {
  const db = makeApprovalDb();
  const cards = [];
  const handler = makeApproveHandler({
    getUser: async (req) => (req.headers.authorization ? { id: req.headers.authorization.slice(7) } : null),
    getAdmin: () => db,
    log: quiet,
    perform: (action, args, user) => performIrreversible(action, args, user),
  });
  const approve = async (id, as = userId, decision = 'approve') => {
    const r = res();
    await handler({ method: 'POST', headers: { authorization: 'Bearer ' + as }, body: { id, decision } }, r);
    return r;
  };
  const model = (name, input, user = { id: userId }) =>
    runTool({ id: 'tu1', name, input }, user, { admin: db, onApprovalRequired: (c) => cards.push(c) });
  return { db, cards, approve, model };
}
