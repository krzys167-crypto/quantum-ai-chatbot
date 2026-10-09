// Renders the real <ApprovalTray> (server-side, no browser) for every approvable action and checks what the user would
// read on the card. This is NOT a browser test: layout, colours and clicks are not exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const outDir = `${root}node_modules/.cache/approval-tray-test`;
let Tray; let renderToStaticMarkup; let createElement;

test.before(async () => {
  mkdirSync(outDir, { recursive: true });
  const { build } = await import('esbuild');
  await build({
    entryPoints: [`${root}src/components/ApprovalTray.tsx`],
    outfile: `${outDir}/tray.mjs`,
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'lucide-react'],
  });
  Tray = (await import(pathToFileURL(`${outDir}/tray.mjs`).href + `?t=${Date.now()}`)).default;
  ({ renderToStaticMarkup } = require('react-dom/server'));
  ({ createElement } = require('react'));
});

const FUTURE = new Date(Date.now() + 9 * 60_000).toISOString();
const html = (card) => renderToStaticMarkup(createElement(Tray, { cards: [{ expires_at: FUTURE, status: 'pending', ...card }], setCards: () => {}, accessToken: 't' }));
const plain = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const EV = { summary: 'Board', start: '2026-10-12T10:00:00Z', end: '2026-10-12T11:00:00Z', guests: ['bob@ex.example', 'carol@ex.example'], recurring: false };

test('update card: shows the event, who is on it now, and exactly what changes', () => {
  const h = plain(html({ id: 'a', action: 'update_calendar_event', fields: { event_id: 'ev1', start: '2026-10-13T10:00:00Z', end: '2026-10-13T11:00:00Z', add_attendees: ['eve@evil.example'], notify: false, location: '' }, context: { event: EV } }));
  assert.match(h, /Change this event that has guests\?/);
  assert.match(h, /Event Board/);
  assert.match(h, /Guests now bob@ex\.example, carol@ex\.example/);
  assert.match(h, /New time 2026-10-13T10:00:00Z - 2026-10-13T11:00:00Z/);
  assert.match(h, /New place \(cleared\)/);
  assert.match(h, /Invite eve@evil\.example/);
  assert.match(h, /Notify No e-mail to the guests/);
  assert.match(h, /Nothing is changed or shared until you confirm/);
});

test('update card that only adds guests to an event nobody else is on says so; without the server-read event it warns', () => {
  const adds = plain(html({ id: 'b', action: 'update_calendar_event', fields: { event_id: 'ev1', add_attendees: ['eve@evil.example'] }, context: { event: { ...EV, guests: [] } } }));
  assert.match(adds, /Change this event and invite new guests\?/);
  assert.match(adds, /Guests now none/);
  const unknown = plain(html({ id: 'c', action: 'update_calendar_event', fields: { event_id: 'ev1', summary: 'x' }, context: null }));
  assert.match(unknown, /Unknown event - do not confirm/);
});

test('delete card: event, time, guests who are told, recurring series', () => {
  const h = plain(html({ id: 'd', action: 'delete_calendar_event', fields: { event_id: 'ev1' }, context: { event: { ...EV, recurring: true } } }));
  assert.match(h, /Cancel this event that has guests\?/);
  assert.match(h, /Guests bob@ex\.example, carol@ex\.example/);
  assert.match(h, /Series Part of a recurring series/);
  assert.match(h, /Notify Calendar default/);
});

test('comment cards: file name (or the id when unknown), the exact text, who sees it', () => {
  const add = plain(html({ id: 'e', action: 'add_file_comment', fields: { file_id: 'file-1-id', comment: 'Please check B4 <script>x</script>', cell: 'B4' }, context: { file: { name: 'Q3 budget', type: 'x' } } }));
  assert.match(add, /Post this comment on the file\?/);
  assert.match(add, /File Q3 budget/);
  assert.match(add, /About cell B4/);
  assert.match(add, /Visible to Everyone with access to the file/);
  assert.match(add, /Please check B4 <script>x<\/script>/, 'shown as text');
  assert.ok(!html({ id: 'e', action: 'add_file_comment', fields: { file_id: 'f', comment: '<script>x</script>' }, context: null }).includes('<script>'), 'the text is escaped, never markup');
  const unknown = plain(html({ id: 'f', action: 'add_file_comment', fields: { file_id: 'file-1-id', comment: 'hi' }, context: null }));
  assert.match(unknown, /File Unknown file \(file-1-id\)/);
  const bare = plain(html({ id: 'g', action: 'reply_to_file_comment', fields: { file_id: 'file-1-id', comment_id: 'c9', reply: '', resolve: true }, context: null }));
  assert.match(bare, /Post this reply on the file\?/);
  assert.match(bare, /Resolve Yes - marks the thread resolved/);
  assert.match(bare, /Resolved\./, 'the text Drive will actually post for a bare resolve is shown');
});

test('mail and create-event cards keep their wording', () => {
  const send = plain(html({ id: 'h', action: 'send_email', fields: { to: 'a@b.co', cc: '', bcc: 'h@b.co', subject: 'Hi', body: 'Hello' } }));
  assert.match(send, /Send this email\?/);
  assert.match(send, /To a@b\.co/);
  assert.match(send, /Bcc h@b\.co/);
  assert.match(send, /Subject Hi/);
  assert.match(send, /Nothing is sent until you confirm/);
  const ev = plain(html({ id: 'i', action: 'create_calendar_event', fields: { summary: 'Kickoff', start: '2026-10-12T10:00:00Z', attendees: ['bob@ex.example'] } }));
  assert.match(ev, /Create this event and invite the guests\?/);
  assert.match(ev, /Guests bob@ex\.example/);
  const reply = plain(html({ id: 'j', action: 'reply_email', fields: { message_id: 'm1', reply_all: true, body: 'ok' }, context: { original: { from: 'Eve <eve@x.yz>', subject: 'S' }, recipients: { to: 'eve@x.yz', cc: 'cfo@corp.example', bcc: '' } } }));
  assert.match(reply, /Mode Reply to all/);
  assert.match(reply, /To eve@x\.yz/);
  assert.match(reply, /Cc cfo@corp\.example/);
  const noRcpt = plain(html({ id: 'k', action: 'reply_email', fields: { message_id: 'm1', body: 'ok' }, context: null }));
  assert.match(noRcpt, /Unknown - do not confirm/);
});

test('finished states say the right thing per action and never "Sent" for a comment', () => {
  const done = (action, fields) => plain(html({ id: 'z', action, fields, status: 'done' }));
  assert.match(done('update_calendar_event', { event_id: 'e' }), /Event updated\./);
  assert.match(done('delete_calendar_event', { event_id: 'e' }), /Event cancelled\./);
  assert.match(done('add_file_comment', { file_id: 'file-1-id', comment: 'x' }), /Comment posted\./);
  assert.match(done('send_email', { to: 'a@b.co' }), /Sent\./);
  const cancelled = (action, fields) => plain(html({ id: 'z', action, fields, status: 'cancelled' }));
  assert.match(cancelled('delete_calendar_event', { event_id: 'e' }), /The event was not cancelled\./);
  assert.match(cancelled('add_file_comment', { file_id: 'file-1-id', comment: 'x' }), /Nothing was posted\./);
  const failed = plain(html({ id: 'z', action: 'add_file_comment', fields: { file_id: 'file-1-id', comment: 'x' }, status: 'failed', message: 'Google Drive refused the request (HTTP 403). Nothing was posted.' }));
  assert.match(failed, /Nothing was posted\./);
});
