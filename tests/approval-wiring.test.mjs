// Static wiring checks: the places that are not exercised by running a handler (the chat stream, the compressed
// front-end source, the tool schemas) must keep the F09 contract. Cheap, but they fail loudly if someone removes a link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('chat.js streams the Confirm card only on an open SSE stream and never as a model-visible token', () => {
  const src = read('api/chat.js');
  assert.match(src, /onApprovalRequired:\s*wantStream\s*\?\s*\(card\)\s*=>\s*sseWrite\(res,\s*\{\s*status:\s*'approval_required',\s*approval:\s*card\s*\}\)\s*:\s*undefined/);
  assert.ok(!/approval_token/.test(src), 'no capability token is handed to the model any more');
});

test('tool schemas no longer accept an approval token and state that only the app can send', () => {
  const src = read('api/lib/claudeTools.js');
  assert.ok(!/approval_token/.test(src));
  assert.match(src, /Ignored by the app: only the user pressing Confirm sends\./);
  assert.match(src, /import \{ gateIrreversible, PROCEED \} from '\.\/sendGuard\.js'/);
  assert.ok((src.match(/if \(gate !== PROCEED\) return \{/g) || []).length >= 2, 'both gated branches must proceed only on the explicit PROCEED value');
  assert.ok(!/if \(gate\) return/.test(src), 'no truthiness test on the gate result (fail-open shape)');
  assert.match(src, /gateIrreversible\(name, input, user, \{[\s\S]*?onApprovalRequired: context\.onApprovalRequired/);
});

test('approve-action endpoint is bound to the stored-args executor and has no CORS', () => {
  const src = read('api/approve-action.js');
  assert.match(src, /perform:\s*\(action, args, user\)\s*=>\s*performIrreversible\(action, args, user\)/);
  assert.match(src, /getUser:\s*getUserFromAuthHeader/);
  assert.ok(!/Access-Control/i.test(src) && !/Access-Control/i.test(read('api/lib/approveHandler.js')));
});

test('the compressed front-end source renders the tray and listens for approval_required', () => {
  const app = inflateSync(Buffer.from(read('src/App.tsx.zlib.b64').trim(), 'base64')).toString('utf8');
  assert.match(app, /import ApprovalTray, \{ addApprovalCard/);
  assert.match(app, /evt\.status === 'approval_required' && evt\.approval/);
  assert.match(app, /<ApprovalTray cards=\{approvals\} setCards=\{setApprovals\} accessToken=\{session\?\.access_token\}/);
  const comp = read('src/components/ApprovalTray.tsx');
  assert.match(comp, /fetch\('\/api\/approve-action'/);
  assert.match(comp, /body: JSON\.stringify\(\{ id: card\.id, decision \}\)/);
  assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(comp), 'the e-mail body is rendered as text only');
});

test('the system prompt tells the model that guests need the Confirm card and never to claim an invitation without a tool result', () => {
  const src = read('api/chat.js');
  assert.match(src, /creating a calendar event with guests never happen from your call/);
  assert.match(src, /Never say an email was sent or guests were invited unless a tool result says so/);
  assert.ok(!/only send_email with user_confirmed=true after they say yes/.test(src), 'the old model-held confirmation instruction is gone');
});

test('runTool gates create_calendar_event and the executor is shared with the approval endpoint', () => {
  const src = read('api/lib/claudeTools.js');
  assert.match(src, /if \(name === 'create_calendar_event' && user\) \{[\s\S]*?gateIrreversible\(name, input, user, \{/);
  assert.match(src, /if \(name === 'create_calendar_event'\) return createEventFor\(user, input, id\);/);
  assert.equal((src.match(/createCalendarEvent\(token,/g) || []).length, 1, 'one single call site for the Calendar API');
});

test('the SQL constraint and the code list the same approvable actions', async () => {
  const { APPROVABLE_ACTIONS } = await import('../api/lib/approvals.js');
  const sql = read('supabase/approval-requests.sql');
  const m = /approval_requests_action_check\s+check \(action in \(([^)]*)\)\)/.exec(sql);
  assert.ok(m, 'named check constraint present');
  const listed = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(listed, [...APPROVABLE_ACTIONS].sort());
});

test('Confirm card: shows who really receives a reply, Cc and Bcc, and only a click can approve', () => {
  const src = read('src/components/ApprovalTray.tsx');
  assert.match(src, /isReply && <Row dark=\{dark\} label="To" value=\{rcpt\?\.to \?/, 'the reply recipient comes from the server-resolved context');
  assert.match(src, /label="Cc" value=\{isReply \? text\(rcpt\?\.cc \?\? f\.cc\)/);
  assert.match(src, /label="Bcc" value=\{isReply \? text\(rcpt\?\.bcc \?\? f\.bcc\)/);
  assert.match(src, /Unknown - do not confirm/, 'a reply card without recipients warns instead of looking normal');
  const calls = src.match(/\bdecide\(/g) || [];
  const clicks = src.match(/onClick=\{\(\) => void decide\(c, '(approve|reject)'\)\}/g) || [];
  assert.equal(calls.length, clicks.length, 'decide() is only ever called from a click handler');
  assert.equal(clicks.length, 2);
  assert.equal((src.match(/fetch\(/g) || []).length, 1, 'one network call, inside decide()');
  assert.match(src, /lineCount\(bodyText\)/, 'the card states how long the message is, so a hidden tail is visible');
});
