import { getAdminClient, getUserFromAuthHeader } from '../lib/supabaseAdmin.js';
import { applyCors } from '../lib/cors.js';
import { GENERIC, fail, dbDetail } from '../lib/publicError.js';

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET, POST, PATCH, DELETE, OPTIONS')) return;
  const user = await getUserFromAuthHeader(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const admin = getAdminClient();

  if (req.method === 'GET') {
    const { data, error } = await admin
      .from('agent_schedules')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) return fail(res, GENERIC.db, 'agent_schedules list failed:', dbDetail(error));
    return res.status(200).json({ schedules: data || [] });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  if (req.method === 'POST') {
    const interval = Math.min(168, Math.max(1, Number(body.interval_hours) || 24));
    const row = {
      user_id: user.id,
      kind: body.kind || 'daily_gmail_digest',
      title: body.title || 'Daily email summary',
      enabled: body.enabled !== false,
      interval_hours: interval,
      next_run_at: body.run_now ? new Date().toISOString() : new Date(Date.now() + interval * 3600 * 1000).toISOString(),
      config: body.config || { query: 'in:inbox newer_than:1d', max_messages: 20 },
    };
    const { data, error } = await admin.from('agent_schedules').insert(row).select('*').single();
    if (error) return fail(res, GENERIC.db, 'agent_schedules insert failed:', dbDetail(error));
    return res.status(201).json({ schedule: data });
  }

  const id = (req.query?.id || body.id || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });

  if (req.method === 'PATCH') {
    const patch = { updated_at: new Date().toISOString() };
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (body.title) patch.title = body.title;
    if (body.interval_hours) patch.interval_hours = Math.min(168, Math.max(1, Number(body.interval_hours)));
    if (body.config) patch.config = body.config;
    if (body.run_now) patch.next_run_at = new Date().toISOString();
    const { data, error } = await admin
      .from('agent_schedules')
      .update(patch)
      .eq('id', id)
      .eq('user_id', user.id)
      .select('*')
      .single();
    if (error) return fail(res, GENERIC.db, 'agent_schedules update failed:', dbDetail(error));
    return res.status(200).json({ schedule: data });
  }

  if (req.method === 'DELETE') {
    const { error } = await admin.from('agent_schedules').delete().eq('id', id).eq('user_id', user.id);
    if (error) return fail(res, GENERIC.db, 'agent_schedules delete failed:', dbDetail(error));
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
