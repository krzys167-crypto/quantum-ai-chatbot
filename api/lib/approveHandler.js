// POST /api/approve-action  { id, decision: "approve" | "reject" }   (Authorization: Bearer <Supabase access token>)
// Called by the app only after the signed-in user pressed Confirm / Cancel on a Confirm card. Same-origin only:
// no CORS headers on purpose, and authentication is a bearer header (not a cookie), so a third-party page cannot
// trigger it. The action that runs is the one STORED when the model asked, never anything sent in this request.
import { decidePending, DECISION_MESSAGES } from './approvals.js';

const STATUS = { not_found: 404, expired: 410, corrupt: 409, store_unavailable: 503 };

const isCalendar = (action) => action === 'create_calendar_event';

function safeFailure(e, action) {
  const code = /\b([45]\d\d)\b/.exec(String(e?.message || ''))?.[1];
  const who = isCalendar(action) ? 'Google Calendar' : 'Gmail';
  const nothing = isCalendar(action) ? 'Nothing was created.' : 'Nothing was sent.';
  return code ? `${who} refused the request (HTTP ${code}). ${nothing}` : `The request to ${who} failed. ${nothing}`;
}

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
        return res.status(502).json({ ok: false, status: 'failed', action: d.action, error: isCalendar(d.action) ? 'Google Calendar is not connected for this account. Nothing was created.' : 'Gmail is not connected for this account. Nothing was sent.' });
      }
      log.info?.(JSON.stringify({ evt: 'approval_executed', user: user.id, action: d.action, digest: d.digest }));
      return res.status(200).json({ ok: true, status: isCalendar(d.action) ? 'created' : 'sent', action: d.action });
    } catch (e) {
      log.error?.('approve-action error:', e?.message);
      return res.status(500).json({ error: 'approval is not available' });
    }
  };
}
