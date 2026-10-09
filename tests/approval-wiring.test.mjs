// Static wiring checks: the places that are not exercised by running a handler (the chat stream, the compressed
// front-end source, the tool schemas) must keep the F09 contract. Cheap, but they fail loudly if someone removes a link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

test('the front-end renders the tray and listens for approval_required', () => {
  const app = read('src/App.tsx');
  assert.match(app, /import ApprovalTray, \{ addApprovalCard/);
  assert.match(app, /evt\.status === 'approval_required' && evt\.approval/);
  assert.match(app, /<ApprovalTray cards=\{approvals\} setCards=\{setApprovals\} accessToken=\{session\?\.access_token\}/);
  const comp = read('src/components/ApprovalTray.tsx');
  assert.match(comp, /fetch\('\/api\/approve-action'/);
  assert.match(comp, /body: JSON\.stringify\(\{ id: card\.id, decision \}\)/);
  assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(comp), 'the e-mail body is rendered as text only');
});

test('the system prompt tells the model that guests and comments need the Confirm card and never to claim an action without a tool result', () => {
  const src = read('api/chat.js');
  assert.match(src, /creating a calendar event with guests, changing or cancelling a calendar event that has guests/);
  for (const t of ['send_email', 'reply_email', 'forward_email', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event', 'add_file_comment', 'reply_to_file_comment']) {
    assert.ok(src.includes(`${t}`), `${t} is named in the confirmation rule`);
  }
  assert.match(src, /Never say an email was sent, guests were invited, an event was changed or a comment was posted unless a tool result says so/);
  assert.ok(!/only send_email with user_confirmed=true after they say yes/.test(src), 'the old model-held confirmation instruction is gone');
});

test('runTool gates the calendar and comment tools and the executor is shared with the approval endpoint', () => {
  const src = read('api/lib/claudeTools.js');
  assert.match(src, /if \(name === 'create_calendar_event' && user\) \{[\s\S]*?gateIrreversible\(name, input, user, \{/);
  assert.match(src, /if \(\(name === 'update_calendar_event' \|\| name === 'delete_calendar_event'\) && user\) \{[\s\S]*?gateIrreversible\(name, input, user, \{[\s\S]*?describe: \(args\) => describeCalendarEvent\(user, args\)/);
  assert.match(src, /if \(\(name === 'add_file_comment' \|\| name === 'reply_to_file_comment'\) && user\) \{[\s\S]*?gateIrreversible\(name, input, user, \{/);
  assert.ok((src.match(/if \(gate !== PROCEED\) return \{/g) || []).length >= 4, 'every gated branch proceeds only on the explicit PROCEED value');
  assert.match(src, /if \(name === 'create_calendar_event'\) return createEventFor\(user, input, id\);/);
  assert.match(src, /if \(name === 'update_calendar_event'\) return updateEventFor\(user, input, id\);/);
  assert.match(src, /if \(name === 'delete_calendar_event'\) return deleteEventFor\(user, input, id\);/);
  assert.equal((src.match(/createCalendarEvent\(token,/g) || []).length, 1, 'one single call site for the Calendar create API');
  assert.equal((src.match(/updateCalendarEvent\(token,/g) || []).length, 1, 'one single call site for the Calendar update API');
  assert.equal((src.match(/deleteCalendarEvent\(token,/g) || []).length, 1, 'one single call site for the Calendar delete API');
  assert.equal((src.match(/createFileComment\(token,/g) || []).length, 1, 'one single call site for creating a comment');
  assert.equal((src.match(/replyToFileComment\(token,/g) || []).length, 1, 'one single call site for replying to a comment');
  assert.equal((src.match(/postComment\(/g) || []).length, 3, 'postComment: its definition, the gated-legacy path and performIrreversible');
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
  assert.match(src, /isReply && <Row label="To" value=\{rcpt\?\.to \?/, 'the reply recipient comes from the server-resolved context');
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

test('Confirm card: calendar edits show the event and its guests as the server read them; comments show the file', () => {
  const src = read('src/components/ApprovalTray.tsx');
  for (const a of ['update_calendar_event', 'delete_calendar_event', 'add_file_comment', 'reply_to_file_comment']) {
    assert.ok(src.includes(`'${a}'`), `${a} is a known card action`);
  }
  assert.match(src, /label="Guests now" value=\{ev \? text\(ev\.guests\) \|\| 'none'/);
  assert.match(src, /Unknown event - do not confirm/, 'an edit card without the server-read event warns instead of looking normal');
  assert.match(src, /Unknown file \(/, 'a comment card without a file name still shows the file id');
  assert.match(src, /label="Visible to" value="Everyone with access to the file"/);
});

test('Confirm card: a reply the UI does not understand is never shown as a cancellation or a success', () => {
  const src = read('src/components/ApprovalTray.tsx');
  assert.match(src, /data\.status === 'cancelled'\) patch\(card\.id, \{ status: 'cancelled' \}\)/);
  assert.match(src, /data\.status === 'sent' \|\| data\.status === 'created' \|\| data\.status === 'done'/);
  assert.match(src, /else patch\(card\.id, \{ status: res\.status === 410 \? 'expired' : 'failed', message: String\(data\?\.error \|\| UNCLEAR\[kind\]\) \}\)/, 'anything else is a failure with a "check before asking again" message');
  assert.ok(!/data\.status === 'sent' \|\| data\.status === 'created' \? 'sent' : 'cancelled'/.test(src), 'the old "anything else is cancelled" fallthrough is gone');
});
