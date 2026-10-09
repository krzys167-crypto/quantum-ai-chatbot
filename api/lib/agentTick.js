import { getAdminClient } from './supabaseAdmin.js';
import { runSchedule } from './agentDigest.js';

const CLAIM_LIMIT = 10;

export async function tickDueSchedules() {
  const admin = getAdminClient();
  const now = new Date().toISOString();

  const { data: due, error } = await admin
    .from('agent_schedules')
    .select('*')
    .eq('enabled', true)
    .lte('next_run_at', now)
    .order('next_run_at', { ascending: true })
    .limit(CLAIM_LIMIT);

  if (error) throw new Error(error.message);
  if (!due?.length) return { ran: 0, results: [] };

  const results = [];
  for (const schedule of due) {
    const next = new Date(Date.now() + (Number(schedule.interval_hours) || 24) * 3600 * 1000).toISOString();
    const { data: runRow, error: runErr } = await admin
      .from('agent_runs')
      .insert({ schedule_id: schedule.id, user_id: schedule.user_id, status: 'running' })
      .select('id')
      .single();
    if (runErr) {
      console.error('agent-tick: could not record run for schedule', schedule.id, runErr.message);
      results.push({ id: schedule.id, error: 'could not record run' });
      continue;
    }

    try {
      const result = await runSchedule(schedule);
      await admin
        .from('agent_runs')
        .update({ status: 'done', finished_at: new Date().toISOString(), result })
        .eq('id', runRow.id);
      await admin
        .from('agent_schedules')
        .update({
          last_run_at: now,
          next_run_at: next,
          last_status: 'done',
          last_error: null,
          updated_at: now,
        })
        .eq('id', schedule.id);
      results.push({ id: schedule.id, status: 'done', result });
    } catch (err) {
      const message = err?.message || String(err);
      await admin
        .from('agent_runs')
        .update({ status: 'failed', finished_at: new Date().toISOString(), error: message })
        .eq('id', runRow.id);
      await admin
        .from('agent_schedules')
        .update({
          last_run_at: now,
          next_run_at: next,
          last_status: 'failed',
          last_error: message,
          updated_at: now,
        })
        .eq('id', schedule.id);
      // The owner sees the full message in agent_runs / last_error; the HTTP response of the cron call does not repeat it.
      console.error('agent-tick: schedule', schedule.id, 'failed:', message);
      results.push({ id: schedule.id, status: 'failed', error: 'run failed' });
    }
  }

  return { ran: results.length, results };
}
