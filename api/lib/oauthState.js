// Server-side OAuth state: opaque, random, single-use, short-lived, bound to the
// initiating user. The callback never trusts identity from the URL: user and
// provider come from the row that this module created (F01/F02).
import { createHash, randomBytes } from 'node:crypto';

export const STATE_TTL_MS = 10 * 60 * 1000;
export const STATE_BYTES = 32;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 bytes, no padding

export function hashState(state) {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

/** Persist a fresh state for (user, provider). Fails closed: no row, no state. */
export async function createOAuthState({ admin, userId, provider, family, now = Date.now() }) {
  if (!userId || !provider || !family) throw new Error('state_params_missing');
  const state = randomBytes(STATE_BYTES).toString('base64url');
  const { error } = await admin.from('oauth_states').insert({
    state_hash: hashState(state),
    user_id: userId,
    provider,
    family,
    expires_at: new Date(now + STATE_TTL_MS).toISOString(),
  });
  if (error) throw new Error('state_store_unavailable');
  // Best-effort housekeeping; never blocks the flow.
  try {
    await admin.from('oauth_states').delete().lt('expires_at', new Date(now - 24 * 3600 * 1000).toISOString());
  } catch { /* ignore */ }
  return state;
}

/**
 * Atomically consume a state. One UPDATE ... WHERE consumed_at IS NULL AND
 * expires_at > now RETURNING: of two concurrent callbacks at most one wins.
 * Returns { ok: true, userId, provider } or { ok: false, reason }.
 */
export async function consumeOAuthState({ admin, state, family, now = Date.now() }) {
  if (typeof state !== 'string' || !STATE_RE.test(state)) return { ok: false, reason: 'invalid_state' };
  const nowIso = new Date(now).toISOString();
  const { data, error } = await admin
    .from('oauth_states')
    .update({ consumed_at: nowIso })
    .eq('state_hash', hashState(state))
    .eq('family', family)
    .is('consumed_at', null)
    .gt('expires_at', nowIso)
    .select('user_id, provider')
    .maybeSingle();
  if (error) return { ok: false, reason: 'state_store_unavailable' };
  if (!data) return { ok: false, reason: 'invalid_state' };
  return { ok: true, userId: data.user_id, provider: data.provider };
}
