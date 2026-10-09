// Every tool the model can call must be classified here on purpose. A new tool that can reach a third party (send a
// draft, share a file, update an event with guests, post a message...) fails this test until someone decides whether
// it needs the server-side approval gate. This is the check that "the model can never send" stays true as tools are added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Approval gate (api/lib/sendGuard.js). update/delete_calendar_event are gated only when the event has guests (or the edit
// adds some); the two comment tools always, because a comment notifies everyone with access to the file.
const GATED = [
  'send_email', 'reply_email', 'forward_email', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event',
  'add_file_comment', 'reply_to_file_comment',
];
const READ_ONLY = [
  'web_search', 'web_fetch', 'search_gmail', 'get_gmail_message', 'list_gmail_labels', 'search_drive', 'read_google_doc',
  'search_sheets', 'read_sheet', 'list_calendar_events', 'search_outlook', 'search_excel', 'read_drive_file', 'list_drive_folder', 'list_notes',
  'read_sheet_notes', 'read_file_comments', 'recall_memory', 'list_sheet_edits',
];
// Writes that stay inside the user's own account and can be undone (drafts are never sent by a tool, trash is recoverable,
// documents and sheets are the user's own). Reviewed in docs/approval.md under "not gated by decision".
const OWN_DATA_REVERSIBLE = [
  'create_email_draft', 'modify_gmail', 'bulk_archive_gmail', 'create_google_doc', 'append_google_doc', 'create_spreadsheet',
  'update_sheet', 'save_memory', 'save_note', 'update_note', 'delete_note',
  // A cell note notifies nobody; the PDF is built here and, at most, saved into the user's own Drive; undo/redo restore the user's own sheet.
  'set_sheet_note', 'generate_pdf_document', 'undo_sheet_edit', 'redo_sheet_edit',
];

const read = (f) => readFileSync(new URL(`../api/lib/${f}`, import.meta.url), 'utf8');
// Every module under api/lib, so a tool defined in a new file cannot escape the inventory.
const libFiles = () => readdirSync(new URL('../api/lib/', import.meta.url)).filter((f) => f.endsWith('.js'));
const definedTools = () => {
  const names = new Set();
  for (const f of libFiles()) {
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
    // A reviewed read-only tool may mention the word (read_file_comments only reads).
    if (/^(read|list|search|get|recall)_/.test(n) && READ_ONLY.includes(n)) continue;
    if (/send|share|invite|post|publish|permission|forward|reply|comment|notify|attendee/.test(n)) assert.ok(GATED.includes(n), `${n} sounds outward-facing but is not gated`);
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

test('the provider calls that reach other people have exactly the reviewed call sites', () => {
  // File -> how many times each helper is called there. A new caller anywhere under api/ (cron, agents, a new endpoint)
  // fails here until it is reviewed: it must either go through performIrreversible() or only ever address the account owner.
  const root = new URL('../api/', import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
      if (e.isDirectory()) walk(u);
      else if (e.name.endsWith('.js')) files.push(u);
    }
  };
  walk(root);
  const helpers = ['sendGmail', 'replyGmail', 'forwardGmail', 'createCalendarEvent', 'updateCalendarEvent', 'deleteCalendarEvent', 'createFileComment', 'replyToFileComment'];
  const found = {};
  for (const u of files) {
    const rel = u.pathname.slice(root.pathname.length);
    // Comments are not call sites. (Crude on purpose: a '//' inside a string only makes the count smaller, and the exact-match below would then fail loudly.)
    const src = readFileSync(u, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    for (const h of helpers) {
      const n = (src.match(new RegExp(`(?<![\\w.])${h}\\(`, 'g')) || []).length - (new RegExp(`export async function ${h}\\(`).test(src) ? 1 : 0);
      if (n > 0) (found[rel] ||= {})[h] = n;
    }
  }
  assert.deepEqual(found, {
    // performIrreversible() / createEventFor / updateEventFor / deleteEventFor / postComment, plus the ungated own-data path
    // for an event nobody else is on (updateEventFor / deleteEventFor are called from runTool after the gate said PROCEED).
    'lib/claudeTools.js': { sendGmail: 1, replyGmail: 1, forwardGmail: 1, createCalendarEvent: 1, updateCalendarEvent: 1, deleteCalendarEvent: 1, createFileComment: 1, replyToFileComment: 1 },
    // The overdue-notes reminder is mailed to the account owner's own address, with a fixed template.
    'cron/notes-reminders.js': { sendGmail: 1 },
  });
});
