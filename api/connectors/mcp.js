/**
 * Manage a user's MCP servers.
 *
 * Writes go through here rather than straight from the browser because the
 * auth token is a bearer credential for somebody's Slack or Linear. The
 * mcp_servers table does not grant the token column to the client at all, so
 * this endpoint is the only way it is ever written, and it is never sent back.
 *
 * GET    - list the user's servers, without tokens
 * POST   - add or update one { url, label?, name?, token?, enabled? }
 * DELETE - remove one by id
 */
import { getUserFromAuthHeader, getAdminClient } from '../lib/supabaseAdmin.js';
import { allowRequest } from '../lib/rateLimit.js';
import { allowedOrigin } from '../lib/cors.js';
import {
  validateUrl,
  validateToken,
  parseAllowedTools,
  slugName,
  nameFromUrl,
  MAX_SERVERS_PER_USER,
} from '../lib/mcpServers.js';
import { GENERIC, fail, dbDetail } from '../lib/publicError.js';

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

/** Columns safe to return. auth_token is deliberately absent. */
const SAFE = 'id,name,label,url,enabled,allowed_tools,last_error,last_used_at,created_at,updated_at';

function tableMissing(error) {
  return /relation .*mcp_servers.* does not exist|schema cache/i.test(error?.message || '');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin());
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUserFromAuthHeader(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  if (!allowRequest(`mcp:${user.id}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  }

  const admin = getAdminClient();

  try {
    if (req.method === 'GET') {
      const { data, error } = await admin
        .from('mcp_servers')
        .select(SAFE)
        .eq('user_id', user.id)
        .order('created_at', { ascending: true });
      if (error) {
        // Before the migration is run this should read as "none connected",
        // not as a broken settings page.
        if (tableMissing(error)) return res.status(200).json({ servers: [], not_installed: true });
        return fail(res, GENERIC.db, 'mcp_servers list failed:', dbDetail(error));
      }
      return res.status(200).json({ servers: data || [] });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

      // Toggling on and off does not touch the url or the token, so it is
      // handled before the validation that would demand them.
      if (body.id && typeof body.enabled === 'boolean' && !body.url) {
        const { error } = await admin
          .from('mcp_servers')
          .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
          .eq('id', body.id)
          .eq('user_id', user.id);
        if (error) return fail(res, GENERIC.db, 'mcp_servers toggle failed:', dbDetail(error));
        return res.status(200).json({ ok: true, id: body.id, enabled: body.enabled });
      }

      const urlCheck = validateUrl(body.url);
      if (!urlCheck.ok) return res.status(400).json({ error: urlCheck.error });
      const tokenCheck = validateToken(body.token);
      if (!tokenCheck.ok) return res.status(400).json({ error: tokenCheck.error });
      const toolsCheck = parseAllowedTools(body.allowed_tools);
      if (!toolsCheck.ok) return res.status(400).json({ error: toolsCheck.error });

      const label = String(body.label || '').trim().slice(0, 120) || null;
      const name = slugName(body.name || label || nameFromUrl(urlCheck.url));

      // Counted before inserting, and only for a genuinely new name, so
      // editing an existing server never trips the ceiling.
      const { data: existing } = await admin
        .from('mcp_servers')
        .select('id,name')
        .eq('user_id', user.id);
      const isNew = !(existing || []).some((s) => s.name === name);
      if (isNew && (existing || []).length >= MAX_SERVERS_PER_USER) {
        return res.status(400).json({
          error: `You can connect up to ${MAX_SERVERS_PER_USER} MCP servers. Remove one first.`,
        });
      }

      const row = {
        user_id: user.id,
        name,
        label,
        url: urlCheck.url,
        enabled: body.enabled === false ? false : true,
        allowed_tools: toolsCheck.tools,
        last_error: null,
        updated_at: new Date().toISOString(),
      };
      // An absent token on an edit leaves the stored one alone, so someone
      // changing a label does not have to paste their credential again.
      if (tokenCheck.token !== null) row.auth_token = tokenCheck.token;
      else if (body.clear_token === true) row.auth_token = null;

      const { data, error } = await admin
        .from('mcp_servers')
        .upsert(row, { onConflict: 'user_id,name' })
        .select(SAFE)
        .single();
      if (error) {
        if (tableMissing(error)) {
          return res.status(400).json({
            error: 'MCP servers are not set up on this database yet. Run supabase/mcp-servers.sql.',
          });
        }
        return fail(res, GENERIC.db, 'mcp_servers upsert failed:', dbDetail(error));
      }
      return res.status(200).json({ server: data });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id || (typeof req.body === 'object' ? req.body?.id : null);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const { error } = await admin.from('mcp_servers').delete().eq('id', String(id)).eq('user_id', user.id);
      if (error) return fail(res, GENERIC.db, 'mcp_servers delete failed:', dbDetail(error));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return fail(res, GENERIC.server, 'mcp connector error:', err);
  }
}
