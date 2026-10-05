// POST /api/approve-action  { action, args }  (Authorization: Bearer <supabase access token>)
// Called by the front end AFTER the signed-in user clicked Confirm on the exact content. Returns a short-lived
// approval token for that user, action and arguments; the assistant passes it as `approval_token` to the tool.
import { getUserFromAuthHeader } from './lib/supabaseAdmin.js';
import { allowRequest } from './lib/rateLimit.js';
import { createApproval, APPROVABLE_ACTIONS } from './lib/approval.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const user = await getUserFromAuthHeader(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    if (!allowRequest(`approve:${user.id}`, 30, 60_000)) return res.status(429).json({ error: 'Too many requests' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || !APPROVABLE_ACTIONS.includes(body.action)) return res.status(400).json({ error: 'unknown action' });
    const a = createApproval({ secret: process.env.APPROVAL_SECRET, userId: user.id, action: body.action, args: body.args });
    return res.status(200).json({ approval_token: a.token, expires_at: a.expires_at, digest: a.digest });
  } catch (e) {
    return res.status(500).json({ error: 'approval is not available' });
  }
}
