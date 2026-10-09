// Server-side OAuth state: opaque, random, single-use, short-lived, bound to the
// initiating user AND to the initiating browser. The callback never trusts identity
// from the URL: user and provider come from the row that this module created
// (F01/F02). The browser binding closes login-CSRF: an attacker who starts a flow
// with their own session and sends the provider URL to a victim cannot finish it,
// because the victim's browser does not hold the HttpOnly nonce cookie that is
// part of the lookup key (the row is not even found, so it is not burned either).
import { createHash, randomBytes } from 'node:crypto';

export const STATE_TTL_MS = 10 * 60 * 1000;
export const STATE_BYTES = 32;
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 bytes, no padding
const STATE_RE = B64URL_43;
const NONCE_RE = B64URL_43;

/** Lookup key = sha256(state "." browserNonce). Neither value is stored. */
export function hashState(state, nonce) {
  return createHash('sha256').update(`${state}.${nonce}`, 'utf8').digest('hex');
}

// --- browser-binding cookie -------------------------------------------------
// One cookie per flow (name derived from the state) so two tabs can connect
// different providers at the same time. HttpOnly + SameSite=Lax: it is sent on the
// top-level redirect back from the provider but not on cross-site subrequests.
const COOKIE_PATH = '/api/connectors';
export const nonceCookieName = (state) => `qn_${String(state).slice(0, 12)}`;

export function setNonceCookie(state, nonce, { secure = true } = {}) {
  return `${nonceCookieName(state)}=${nonce}; Max-Age=${STATE_TTL_MS / 1000}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Set-Cookie value that deletes the cookie, or null when the state is not well formed. */
export function clearNonceCookie(state, { secure = true } = {}) {
  if (typeof state !== 'string' || !STATE_RE.test(state)) return null;
  return `${nonceCookieName(state)}=; Max-Age=0; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Extract this flow's nonce from a Cookie request header; null if absent or malformed. */
export function readNonce(cookieHeader, state) {
  if (typeof cookieHeader !== 'string' || typeof state !== 'string' || !STATE_RE.test(state)) return null;
  const name = nonceCookieName(state);
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const value = part.slice(i + 1).trim();
    return NONCE_RE.test(value) ? value : null;
  }
  return null;
}

/**
 * Persist a fresh state for (user, provider). Fails closed: no row, no state.
 * Returns { state, nonce }: `state` goes into the provider URL, `nonce` into the
 * HttpOnly cookie of the browser that started the flow.
 */
export async function createOAuthState({ admin, userId, provider, family, now = Date.now() }) {
  if (!userId || !provider || !family) throw new Error('state_params_missing');
  const state = randomBytes(STATE_BYTES).toString('base64url');
  const nonce = randomBytes(STATE_BYTES).toString('base64url');
  const { error } = await admin.from('oauth_states').insert({
    state_hash: hashState(state, nonce),
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
  return { state, nonce };
}

/**
 * Atomically consume a state. One UPDATE ... WHERE consumed_at IS NULL AND
 * expires_at > now RETURNING: of two concurrent callbacks at most one wins.
 * Returns { ok: true, userId, provider } or { ok: false, reason }.
 */
export async function consumeOAuthState({ admin, state, nonce, family, now = Date.now() }) {
  if (typeof state !== 'string' || !STATE_RE.test(state)) return { ok: false, reason: 'invalid_state' };
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { ok: false, reason: 'invalid_state' };
  const nowIso = new Date(now).toISOString();
  const { data, error } = await admin
    .from('oauth_states')
    .update({ consumed_at: nowIso })
    .eq('state_hash', hashState(state, nonce))
    .eq('family', family)
    .is('consumed_at', null)
    .gt('expires_at', nowIso)
    .select('user_id, provider')
    .maybeSingle();
  if (error) return { ok: false, reason: 'state_store_unavailable' };
  if (!data) return { ok: false, reason: 'invalid_state' };
  return { ok: true, userId: data.user_id, provider: data.provider };
}
