import { tickDueSchedules } from '../lib/agentTick.js';

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!expected || auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const out = await tickDueSchedules();
    return res.status(200).json(out);
  } catch (err) {
    console.error('agent-tick', err);
    // The detail stays in the server log; the response body only says that it failed.
    return res.status(500).json({ error: 'tick failed' });
  }
}
