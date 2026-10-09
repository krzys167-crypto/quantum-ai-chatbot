// POST /api/approve-action  { id, decision: "approve" | "reject" }   (Authorization: Bearer <Supabase access token>)
// Called by the app only after the signed-in user pressed Confirm / Cancel on a Confirm card. Same-origin only:
// no CORS headers on purpose, and authentication is a bearer header (not a cookie), so a third-party page cannot
// trigger it. The action that runs is the one STORED when the model asked, never anything sent in this request.
import { decidePending, DECISION_MESSAGES } from './approvals.js';

const STATUS = { not_found: 404, expired: 410, corrupt: 409, store_unavailable: 503 };

// What each action talks to and what to say about it. The mail and create-event strings are the ones the app has always shown.
const KIND = {
  create_calendar_event: 'calendar', update_calendar_event: 'calendar', delete_calendar_event: 'calendar',
  add_file_comment: 'comment', reply_to_file_comment: 'comment',
};
const kindOf = (action) => KIND[action] || 'mail';
const WHO = { calendar: 'Google Calendar', comment: 'Google Drive', mail: 'Gmail' };
const CHECK = { calendar: 'check your calendar', comment: 'check the comments on the file', mail: 'check your Sent folder' };
const NOTHING = {
  create_calendar_event: 'Nothing was created.',
  update_calendar_event: 'Nothing was changed.',
  delete_calendar_event: 'Nothing was cancelled.',
  add_file_comment: 'Nothing was posted.',
  reply_to_file_comment: 'Nothing was posted.',
};
const nothing = (action) => NOTHING[action] || 'Nothing was sent.';
// create -> "created", mail -> "sent", every other action -> "done" (the app words it per action).
const doneStatus = (action) => (action === 'create_calendar_event' ? 'created' : kindOf(action) === 'mail' ? 'sent' : 'done');

/**
 * What to tell the user when the provider call failed, without echoing provider text (it can quote the message).
 * Only a 4xx answer proves the provider did nothing; a 5xx, a timeout or a reply we could not read may have gone through.
 */
function safeFailure(e, action) {
  const code = /\b([45]\d\d)\b/.exec(String(e?.message || ''))?.[1];
  const kind = kindOf(action);
  if (code && code.startsWith('4')) return `${WHO[kind]} refused the request (HTTP ${code}). ${nothing(action)}`;
  return `The request to ${WHO[kind]} did not complete${code ? ` (HTTP ${code})` : ''}. It may or may not have gone through: ${CHECK[kind]} before asking again.`;
}

// The provider answered "not connected" (or the tool had no usable token): nothing was attempted.
const notConnected = (action) =>
  kindOf(action) === 'comment'
    ? 'Google Drive is not connected for this account (comments need the Google Drive connector). Nothing was posted.'
    : `${WHO[kindOf(action)]} is not connected for this account. ${nothing(action)}`;

export function makeApproveHandler({ getUser, getAdmin, perform, allow = () => true, log = console, now = () => Date.now() }) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const user = await getUser(req);
      if (!user) return res.status(401).json({ error: 'Sign in required' });
      if (!allow(`approve:${user.id}`, 30, 60_000)) return res.status(429).json({ error: 'Too many requests' });
      let body;
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { body = null; }
      if (!body || typeof body.id !== 'string' || (body.decision !== 'approve' && body.decision !== 'reject')) {
        return res.status(400).json({ error: 'id and decision ("approve" or "reject") are required' });
      }

      const d = await decidePending({ admin: getAdmin(), userId: user.id, id: body.id, decision: body.decision, now: now() });
      if (!d.ok) {
        log.info?.(JSON.stringify({ evt: 'approval_refused', user: user.id, reason: d.reason }));
        return res.status(STATUS[d.reason] || 400).json({ ok: false, status: d.reason, error: DECISION_MESSAGES[d.reason] });
      }
      if (d.decision === 'reject') {
        log.info?.(JSON.stringify({ evt: 'approval_rejected', user: user.id, action: d.action, digest: d.digest }));
        return res.status(200).json({ ok: true, status: 'cancelled', action: d.action });
      }

      // From here the request is consumed: at most one delivery attempt, never retried automatically.
      let out;
      try {
        out = await perform(d.action, d.args, user);
      } catch (e) {
        log.error?.('approved action failed:', safeFailure(e, d.action)); // never the raw provider text: it can echo the message
        log.info?.(JSON.stringify({ evt: 'approval_failed', user: user.id, action: d.action, digest: d.digest }));
        return res.status(502).json({ ok: false, status: 'failed', action: d.action, error: safeFailure(e, d.action) });
      }
      if (out?.is_error) {
        log.info?.(JSON.stringify({ evt: 'approval_failed', user: user.id, action: d.action, digest: d.digest }));
        return res.status(502).json({ ok: false, status: 'failed', action: d.action, error: notConnected(d.action) });
      }
      log.info?.(JSON.stringify({ evt: 'approval_executed', user: user.id, action: d.action, digest: d.digest }));
      return res.status(200).json({ ok: true, status: doneStatus(d.action), action: d.action });
    } catch (e) {
      log.error?.('approve-action error:', e?.message);
      return res.status(500).json({ error: 'approval is not available' });
    }
  };
}
