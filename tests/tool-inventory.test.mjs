// Every tool the model can call must be classified here on purpose. A new tool that can reach a third party (send a
// draft, share a file, update an event with guests, post a message...) fails this test until someone decides whether
// it needs the server-side approval gate. This is the check that "the model can never send" stays true as tools are added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const GATED = ['send_email', 'reply_email', 'forward_email', 'create_calendar_event']; // approval gate (api/lib/sendGuard.js)
const READ_ONLY = [
  'web_search', 'web_fetch', 'search_gmail', 'get_gmail_message', 'list_gmail_labels', 'search_drive', 'read_google_doc',
  'search_sheets', 'read_sheet', 'list_calendar_events', 'search_outlook', 'search_excel', 'read_drive_file', 'list_drive_folder', 'list_notes',
];
// Writes that stay inside the user's own account and can be undone (drafts are never sent by a tool, trash is recoverable,
// documents and sheets are the user's own). Reviewed in docs/approval.md under "not gated by decision".
const OWN_DATA_REVERSIBLE = [
  'create_email_draft', 'modify_gmail', 'bulk_archive_gmail', 'create_google_doc', 'append_google_doc', 'create_spreadsheet',
  'update_sheet', 'save_memory', 'save_note', 'update_note', 'delete_note',
];

const read = (f) => readFileSync(new URL(`../api/lib/${f}`, import.meta.url), 'utf8');
const definedTools = () => {
  const names = new Set();
  for (const f of ['claudeTools.js', 'driveRead.js']) {
    for (const m of read(f).matchAll(/export const \w+_TOOL = \{[\s\S]*?\bname:\s*'([a-z_]+)'/g)) names.add(m[1]);
  }
  return names;
};

test('every tool defined for the model is classified (gated, read-only or own-data reversible)', () => {
  const known = new Set([...GATED, ...READ_ONLY, ...OWN_DATA_REVERSIBLE]);
  const defined = definedTools();
  const unclassified = [...defined].filter((n) => !known.has(n));
  assert.deepEqual(unclassified, [], `new tool(s) ${unclassified.join(', ')}: decide whether they reach a third party and, if so, put them behind gateIrreversible`);
  const stale = [...known].filter((n) => !defined.has(n));
  assert.deepEqual(stale, [], `classified but no longer defined: ${stale.join(', ')}`);
  assert.equal(new Set([...GATED, ...READ_ONLY, ...OWN_DATA_REVERSIBLE]).size, GATED.length + READ_ONLY.length + OWN_DATA_REVERSIBLE.length, 'a tool is in two classes');
});

test('names that suggest an outward effect are only ever the gated ones', () => {
  for (const n of definedTools()) {
    if (/send|share|invite|post|publish|permission|forward|reply/.test(n)) assert.ok(GATED.includes(n), `${n} sounds outward-facing but is not gated`);
  }
});

test('only approval-gated code paths can call the Gmail send API or create events with guests', () => {
  // Gmail "messages/send" appears only in the helpers that performIrreversible() uses.
  const callers = { 'google.js': /messages\/send/g, 'gmailDeep.js': /messages\/send/g };
  let total = 0;
  for (const [f, re] of Object.entries(callers)) total += (read(f).match(re) || []).length;
  assert.equal(total, 3, 'sendGmail, replyGmail and forwardGmail are the only senders; a new one must be reviewed here');
  const tools = read('claudeTools.js');
  for (const fn of ['sendGmail(', 'replyGmail(', 'forwardGmail(']) {
    const uses = (tools.match(new RegExp(fn.replace('(', '\\('), 'g')) || []).length;
    assert.equal(uses, 1, `${fn} must have exactly one call site (inside performIrreversible)`);
  }
  assert.equal((tools.match(/createCalendarEvent\(/g) || []).length, 1, 'createCalendarEvent has one call site (createEventFor)');
});
