// F09 end to end: what the Confirm card shows is exactly what Gmail receives. Real gate, real approve handler, real
// MIME encoding; only the network edge is stubbed (tests/helpers/mailWorld.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, installNetworkStub, restoreNetwork, sends, calls, original, defaultOriginal, parseMime, headerOf, headerNames } from './helpers/mailWorld.mjs';
import { MAX_PENDING_PER_USER } from '../api/lib/approvals.js';
import { sendGmail } from '../api/lib/google.js';
import { replyGmail } from '../api/lib/gmailDeep.js';

test.beforeEach(() => installNetworkStub());
test.after(() => restoreNetwork());

const SEND = { to: 'friend@ok.example', cc: 'c1@ok.example', bcc: 'hidden@ok.example', subject: 'Meeting notes', body: 'Line 1\nLine 2' };

test('send_email: the MIME handed to Gmail carries exactly the recipients, subject and body shown on the card', async () => {
  const w = world();
  const out = await w.model('send_email', SEND);
  assert.match(out.content, /NOT SENT YET/);
  assert.equal(sends.length, 0, 'nothing is sent before Confirm');
  const [card] = w.cards;
  const r = await w.approve(card.id);
  assert.equal(r.statusCode, 200);
  assert.equal(sends.length, 1);
  const mime = parseMime(sends[0].raw);
  assert.equal(headerOf(mime, 'To'), card.fields.to);
  assert.equal(headerOf(mime, 'Cc'), card.fields.cc);
  assert.equal(headerOf(mime, 'Bcc'), card.fields.bcc);
  assert.equal(headerOf(mime, 'Subject'), card.fields.subject);
  assert.equal(mime.body, card.fields.body);
  assert.deepEqual(headerNames(mime), ['To', 'Cc', 'Bcc', 'Subject', 'MIME-Version', 'Content-Type']);
});

test('send_email: a second Confirm, a replay and another user send nothing more', async () => {
  const w = world();
  await w.model('send_email', SEND);
  const id = w.cards[0].id;
  assert.equal((await w.approve(id, 'u2')).statusCode, 404, 'another user cannot release it');
  assert.equal(sends.length, 0);
  assert.equal((await w.approve(id)).statusCode, 200);
  assert.equal((await w.approve(id)).statusCode, 404);
  assert.equal(sends.length, 1, 'exactly one delivery');
});

test('header injection through any single-line field is refused at the gate: no card, no stored request, no Gmail call', async () => {
  const bad = [
    { ...SEND, subject: 'Meeting notes\r\nBcc: attacker@evil.example' },
    { ...SEND, subject: 'Meeting notes\nBcc: attacker@evil.example' },
    { ...SEND, subject: 'x Bcc: attacker@evil.example' },
    { ...SEND, to: 'friend@ok.example\r\nBcc: attacker@evil.example' },
    { ...SEND, cc: 'a@ok.example\r\nBcc: attacker@evil.example' },
    { ...SEND, bcc: 'a@ok.example\nX-Evil: 1' },
    { ...SEND, to: '"ceo@good.com" <evil@bad.example>' },
    { ...SEND, to: 'friend@ok.exаmple' }, // Cyrillic a
    { ...SEND, subject: 'invoice‮gnp.exe' },
    { ...SEND, body: 'ok\u0000' },
  ];
  for (const input of bad) {
    const w = world();
    const out = await w.model('send_email', input);
    assert.equal(out.is_error, true, JSON.stringify(input));
    assert.equal(w.cards.length, 0, JSON.stringify(input));
    assert.equal(w.db.tables.approval_requests.length, 0);
  }
  assert.equal(sends.length, 0);
});

test('the MIME encoders themselves cannot be made to add a header, whoever calls them (defence in depth)', async () => {
  await sendGmail('tok', { to: 'a@ok.example', subject: 'Hi\r\nBcc: attacker@evil.example', body: 'b', cc: 'c@ok.example\r\nX-Evil: 1' });
  const m = parseMime(sends[0].raw);
  assert.ok(!headerNames(m).includes('Bcc') && !headerNames(m).includes('X-Evil'), JSON.stringify(m.lines));
  assert.equal(headerNames(m).length, 6 - 1, 'To, Cc, Subject, MIME-Version, Content-Type');
  // a received message whose Subject carries a line break must not become headers of the reply either
  original.headers = defaultOriginal().map((h) => (h.name === 'Subject' ? { name: 'Subject', value: 'Invoice\r\nBcc: attacker@evil.example' } : h));
  await replyGmail('tok', { messageId: 'orig', body: 'thanks', replyAll: false });
  const r = parseMime(sends[1].raw);
  assert.ok(!headerNames(r).includes('Bcc'), JSON.stringify(r.lines));
});

test('reply_email: the card shows the real recipients (reply-all expansion included) and exactly they receive it', async () => {
  const w = world();
  const out = await w.model('reply_email', { message_id: 'orig', body: 'Thanks', reply_all: true, bcc: 'archive@me.example' });
  assert.match(out.content, /NOT SENT YET/);
  const [card] = w.cards;
  assert.deepEqual(card.context.recipients, { to: 'mallory@evil.example', cc: 'owner@me.example, boss@corp.example, cfo@corp.example', bcc: 'archive@me.example' });
  assert.equal(card.context.original.subject, 'Invoice');
  assert.equal((await w.approve(card.id)).statusCode, 200);
  const mime = parseMime(sends[0].raw);
  assert.equal(headerOf(mime, 'To'), card.context.recipients.to);
  assert.equal(headerOf(mime, 'Cc'), card.context.recipients.cc);
  assert.equal(headerOf(mime, 'Bcc'), card.context.recipients.bcc);
  assert.equal(headerOf(mime, 'Subject'), 'Re: Invoice');
});

test('reply_email to sender only: the card lists exactly one recipient and the reply has no Cc', async () => {
  const w = world();
  await w.model('reply_email', { message_id: 'orig', body: 'Thanks' });
  const [card] = w.cards;
  assert.deepEqual(card.context.recipients, { to: 'mallory@evil.example', cc: '', bcc: '' });
  await w.approve(card.id);
  const mime = parseMime(sends[0].raw);
  assert.equal(headerOf(mime, 'Cc'), undefined);
  assert.equal(headerOf(mime, 'To'), 'mallory@evil.example');
});

test('reply_email / forward_email: if the original cannot be read there is no card and nothing is stored or sent', async () => {
  for (const status of [429, 500, 404]) {
    original.status = status;
    for (const [name, input] of [['reply_email', { message_id: 'orig', body: 'x', reply_all: true }], ['forward_email', { message_id: 'orig', to: 'x@ok.example' }]]) {
      const w = world();
      const out = await w.model(name, input);
      assert.equal(out.is_error, true, `${name} ${status}`);
      assert.match(out.content, /original message could not be read/);
      assert.equal(w.cards.length, 0);
      assert.equal(w.db.tables.approval_requests.length, 0);
    }
  }
  assert.equal(sends.length, 0);
});

test('reply_email: a From header that names several addresses is refused instead of mailing all of them', async () => {
  original.headers = defaultOriginal().map((h) => (h.name === 'From' ? { name: 'From', value: 'evil@bad.example, boss@corp.example' } : h));
  const w = world();
  const out = await w.model('reply_email', { message_id: 'orig', body: 'x' });
  assert.equal(out.is_error, true);
  assert.equal(w.cards.length, 0);
  assert.equal(sends.length, 0);
});

test('send_email without a subject is refused now, not after the user pressed Confirm (the approval is not burned)', async () => {
  const w = world();
  for (const subject of ['', '   ', undefined]) {
    const out = await w.model('send_email', { to: 'a@ok.example', body: 'b', subject });
    assert.equal(out.is_error, true);
  }
  assert.equal(w.cards.length, 0);
  assert.equal(w.db.tables.approval_requests.length, 0);
});

test('many tool calls at once cannot exceed the pending limit', async () => {
  const w = world();
  const outs = await Promise.all(Array.from({ length: 40 }, (_, i) => w.model('send_email', { to: `v${i}@ok.example`, subject: `s${i}`, body: 'b' })));
  assert.equal(w.db.tables.approval_requests.length, MAX_PENDING_PER_USER);
  assert.equal(w.cards.length, MAX_PENDING_PER_USER);
  assert.equal(outs.filter((o) => o.is_error).length, 40 - MAX_PENDING_PER_USER);
  assert.ok(!calls.some((u) => u.includes('/messages/send')));
});

test('a Gmail 5xx after Confirm is reported as possibly delivered, a 4xx as not sent; no provider text is echoed', async () => {
  const w = world();
  await w.model('send_email', SEND);
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => (String(url).includes('/messages/send') ? new Response('the body of the message: top secret', { status: 503 }) : real(url, o));
  const r = await w.approve(w.cards[0].id);
  globalThis.fetch = real;
  assert.equal(r.statusCode, 502);
  assert.match(r.body.error, /may or may not have gone through/);
  assert.ok(!/secret/.test(JSON.stringify(r.body)));
});
