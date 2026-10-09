/**
 * Vercel Cron: daily digest of overdue notes, emailed via each user's own
 * connected Gmail. Re-reminds at most every 3 days per note to avoid spam.
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on cron-triggered
 * requests — verify it so this endpoint can't be triggered by anyone else.
 */
import { getAdminClient } from '../lib/supabaseAdmin.js';
import { getValidToken } from '../lib/claudeTools.js';
import { sendGmail } from '../lib/google.js';

const REMIND_EVERY_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_NOTES = 500;

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!expected || auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const admin = getAdminClient();
  const nowIso = new Date().toISOString();
  const remindCutoff = new Date(Date.now() - REMIND_EVERY_MS).toISOString();

  const { data: overdue, error } = await admin
    .from('notes')
    .select('id, user_id, note, project, due_date, priority, last_reminded_at')
    .eq('status', 'open')
    .lt('due_date', nowIso)
    .or(`last_reminded_at.is.null,last_reminded_at.lt.${remindCutoff}`)
    .order('due_date', { ascending: true })
    .limit(MAX_NOTES);

  if (error) {
    console.error('notes-reminders query failed:', error);
    return res.status(500).json({ error: 'query failed' });
  }
  if (!overdue?.length) return res.status(200).json({ sent: 0, reason: 'nothing overdue' });

  const byUser = new Map();
  for (const n of overdue) {
    if (!byUser.has(n.user_id)) byUser.set(n.user_id, []);
    byUser.get(n.user_id).push(n);
  }

  let sent = 0;
  const remindedIds = [];
  for (const [userId, notes] of byUser) {
    try {
      const token = await getValidToken(userId, 'gmail');
      if (!token) continue;
      const { data: authUser } = await admin.auth.admin.getUserById(userId);
      const email = authUser?.user?.email;
      if (!email) continue;

      const lines = notes.map((n) => {
        const days = Math.max(0, Math.floor((Date.now() - new Date(n.due_date).getTime()) / 86400000));
        const project = n.project ? ` [${n.project}]` : '';
        return `- ${n.note}${project} — ${days}d overdue, ${n.priority} priority`;
      });
      const body = `You have ${notes.length} overdue note${notes.length > 1 ? 's' : ''} in Quantumy:\n\n${lines.join('\n')}\n\nOpen Quantumy to mark these done, dismiss them, or escalate.`;

      await sendGmail(token, {
        to: email,
        subject: `Quantumy: ${notes.length} overdue note${notes.length > 1 ? 's' : ''}`,
        body,
      });
      sent += 1;
      for (const n of notes) remindedIds.push(n.id);
    } catch (e) {
      console.error(`notes-reminders failed for user ${userId}:`, e?.message || e);
    }
  }

  if (remindedIds.length) {
    await admin.from('notes').update({ last_reminded_at: new Date().toISOString() }).in('id', remindedIds);
  }

  return res.status(200).json({ sent, notesReminded: remindedIds.length });
}
