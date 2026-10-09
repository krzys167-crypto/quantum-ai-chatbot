// F04: the public pages must describe the OAuth scopes the code really requests, and must not claim "read-only"
// while write scopes are requested. This ties the text to PROVIDER_SCOPES / MS_PROVIDER_SCOPES, so changing a scope
// without changing the text (or the other way round) fails here.
// It does NOT read the Google Cloud consent-screen configuration, which lives outside this repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROVIDER_SCOPES } from '../api/lib/google.js';
import { MS_PROVIDER_SCOPES } from '../api/lib/microsoft.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8');
const privacy = read('public/privacy.html');
const home = read('public/home.html');
const terms = read('public/terms.html');
const text = (html) => html
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

const googleShort = (scope) => scope.replace('https://www.googleapis.com/auth/', '');
const msShort = (scope) => scope.replace('https://graph.microsoft.com/', '');
const googleScopes = [...new Set(Object.values(PROVIDER_SCOPES).flat().map(googleShort))];
const msScopes = [...new Set(Object.values(MS_PROVIDER_SCOPES).flat().map(msShort))];
// Section 3 is where the permissions are disclosed; the checks below look there, not anywhere on the page.
const section3 = text(privacy.slice(privacy.indexOf('<h2>3.'), privacy.indexOf('<h2>4.')));
const codeTokens = (html) => [...html.matchAll(/<code>([^<]+)<\/code>/g)].map((m) => m[1]);

test('the privacy policy lists every scope the code requests, as a <code> token', () => {
  const tokens = new Set(codeTokens(privacy));
  for (const scope of [...googleScopes, ...msScopes]) {
    assert.ok(tokens.has(scope), `privacy.html does not list the requested scope "${scope}"`);
  }
});

test('the privacy policy lists no scope the code does not request (no stale claims)', () => {
  const requested = new Set([...googleScopes, ...msScopes]);
  for (const token of codeTokens(privacy)) {
    assert.ok(requested.has(token), `privacy.html names "${token}", which no provider requests`);
  }
});

test('the home page "What we request" box lists every Gmail scope and names no scope that is not requested', () => {
  const tokens = new Set(codeTokens(home));
  for (const scope of PROVIDER_SCOPES.gmail.map(googleShort)) {
    assert.ok(tokens.has(scope), `home.html does not list the Gmail scope "${scope}"`);
  }
  const requested = new Set([...googleScopes, ...msScopes]);
  for (const token of tokens) assert.ok(requested.has(token), `home.html names "${token}", which no provider requests`);
});

test('no public page says Gmail is read-only or that send/modify is not requested while write scopes are requested', () => {
  const writes = PROVIDER_SCOPES.gmail.map(googleShort).filter((s) => /^gmail\.(send|compose|modify)$/.test(s));
  assert.ok(writes.length > 0, 'precondition: this test is about the case where Gmail write scopes are requested');
  const bad = [
    /gmail[^.]{0,80}read-only/i,
    /read-only[^.]{0,80}gmail/i,
    /not request[^.]{0,40}(send|modify|delete)/i,
  ];
  for (const [name, html] of [['privacy.html', privacy], ['home.html', home], ['terms.html', terms]]) {
    const t = text(html);
    for (const re of bad) assert.ok(!re.test(t), `${name} matches ${re}: "${(t.match(re) || [''])[0]}"`);
  }
});

test('every connector the app offers is named in section 3 of the privacy page', () => {
  assert.ok(section3.length > 500, 'section 3 must exist');
  const t = section3;
  for (const name of ['Gmail', 'Google Drive', 'Google Docs', 'Google Sheets', 'Google Calendar', 'Outlook', 'Excel']) {
    assert.ok(t.includes(name), `section 3 of privacy.html does not name ${name}`);
  }
  assert.deepEqual(Object.keys(PROVIDER_SCOPES).sort(), ['gmail', 'google_calendar', 'google_docs', 'google_drive', 'google_sheets'], 'a new Google provider needs a paragraph in privacy.html first');
  assert.deepEqual(Object.keys(MS_PROVIDER_SCOPES).sort(), ['excel', 'outlook'], 'a new Microsoft provider needs a paragraph in privacy.html first');
});

test('the scheduled mail features in the code are disclosed', () => {
  const t = section3;
  assert.match(read('api/lib/agentDigest.js'), /createGmailDraft\(/, 'precondition: the briefing creates a draft');
  assert.match(t, /daily inbox briefing/i);
  assert.match(t, /draft[^.]*addressed to your own account email[^.]*not sent/i);
  assert.match(read('api/cron/notes-reminders.js'), /sendGmail\(/, 'precondition: the reminder cron sends mail');
  assert.match(t, /overdue notes[^.]*emails a reminder from your own Gmail to your own address/i);
});

test('Gmail never permanently deletes: no Gmail DELETE call exists, only the Trash endpoint', () => {
  const g = read('api/lib/google.js');
  assert.match(g, /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/\$\{encodeURIComponent\(messageId\)\}\/trash/, 'precondition: trash is used');
  for (const rel of ['api/lib/google.js', 'api/lib/gmailDeep.js', 'api/lib/claudeTools.js']) {
    const src = read(rel);
    for (const m of src.matchAll(/method:\s*['"]DELETE['"]/g)) {
      const before = src.slice(Math.max(0, m.index - 400), m.index);
      assert.ok(!/gmail\.googleapis\.com/.test(before), `${rel}: a DELETE call right after a Gmail URL contradicts "does not permanently delete email"`);
    }
  }
  assert.match(text(privacy), /does not permanently delete email/i);
});
