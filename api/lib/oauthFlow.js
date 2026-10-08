// Provider-agnostic OAuth connector flow. Handlers stay thin; everything that
// decides identity, state, token storage and revocation lives here so it can be
// tested with injected fakes (no network, no database).
import { createOAuthState, consumeOAuthState } from './oauthState.js';
import { sealToken } from './tokenCrypto.js';

const enc = encodeURIComponent;
const safeCode = (v) => String(v ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'oauth_error';
const ctx = (userId, provider, column) => ({ userId, provider, column });

/** Start: create a server-side state bound to the authenticated user. */
export async function beginFlow({ family, provider, user, admin, scopesFor, buildUrl, now }) {
  if (!scopesFor(provider)) return { status: 400, body: { error: `Unknown provider: ${provider}` } };
  let state;
  try {
    state = await createOAuthState({ admin, userId: user.id, provider, family, now });
  } catch {
    return {
      status: 503,
      body: { error: 'OAuth state store unavailable', hint: 'Apply supabase/connectors-hardening.sql' },
    };
  }
  return { status: 200, body: { url: buildUrl(state) } };
}

/**
 * Callback: returns the redirect location. Identity and provider come only from
 * the consumed server-side state row, never from the URL.
 */
export async function finishFlow({ family, query, admin, scopesFor, exchangeCode, getEmail, home, now, log = console }) {
  const to = (qs) => `${home}?${qs}`;
  if (query?.error) return to(`connector_error=${enc(safeCode(query.error))}`);
  if (!query?.code || !query?.state) return to('connector_error=missing_code');

  const consumed = await consumeOAuthState({ admin, state: String(query.state), family, now });
  if (!consumed.ok) return to(`connector_error=${consumed.reason}`);
  const { userId, provider } = consumed;
  const scopes = scopesFor(provider);
  if (!scopes) return to('connector_error=invalid_state');

  let tokens;
  let email;
  try {
    tokens = await exchangeCode(String(query.code));
    if (!tokens?.access_token) throw new Error('no access_token');
    email = await getEmail(tokens.access_token);
  } catch (e) {
    log.error?.(`${family}-callback exchange failed:`, e?.message);
    return to('connector_error=exchange_failed');
  }

  const { data: existing, error: readError } = await admin
    .from('connectors')
    .select('account_email, refresh_token')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (readError) return to('connector_error=save_failed');

  // F05: an old refresh token may only be kept when the same account reconnects.
  let refresh = tokens.refresh_token || null;
  if (!refresh && existing?.refresh_token) {
    const same =
      email && existing.account_email && String(email).toLowerCase() === String(existing.account_email).toLowerCase();
    if (same) refresh = existing.refresh_token;
  }

  let row;
  try {
    row = {
      user_id: userId,
      provider,
      account_email: email,
      access_token: sealToken(tokens.access_token, ctx(userId, provider, 'access_token')),
      refresh_token: sealToken(refresh, ctx(userId, provider, 'refresh_token')),
      token_expires_at: tokens.expires_in ? new Date((now ?? Date.now()) + tokens.expires_in * 1000).toISOString() : null,
      scopes,
      status: 'connected',
      updated_at: new Date(now ?? Date.now()).toISOString(),
    };
  } catch (e) {
    log.error?.('token sealing failed:', e?.message);
    return to('connector_error=token_key_invalid');
  }

  // F06: never report success without a confirmed write.
  const { error } = await admin.from('connectors').upsert(row, { onConflict: 'user_id,provider' });
  if (error) {
    log.error?.(`${family} upsert connector error:`, error.message);
    return to('connector_error=save_failed');
  }
  return to(`connected=${enc(provider)}`);
}

/**
 * Disconnect (F07): read the tokens, delete the local row first (user intent
 * must always succeed), then revoke at the provider with the in-memory token.
 * A Google grant is shared by every Google connector of the same account, so it
 * is only revoked when no other connector of that account remains.
 */
export async function disconnectFlow({ admin, userId, provider, familyOf, googleProviders, revokeGoogle, openToken }) {
  const family = familyOf(provider);
  if (!family) return { status: 400, body: { error: `Unknown provider: ${provider}` } };

  const { data: row, error: readError } = await admin
    .from('connectors')
    .select('id, account_email, access_token, refresh_token')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (readError) return { status: 500, body: { error: 'Could not read connector' } };
  if (!row) return { status: 200, body: { ok: true, revoked: 'none' } };

  const { error: delError } = await admin.from('connectors').delete().eq('user_id', userId).eq('provider', provider);
  if (delError) return { status: 500, body: { error: delError.message } };

  if (family !== 'google') return { status: 200, body: { ok: true, revoked: 'unsupported_provider' } };
  if (!row.account_email) return { status: 200, body: { ok: true, revoked: 'skipped_unknown_account' } };

  const { data: others, error: othersError } = await admin
    .from('connectors')
    .select('id')
    .eq('user_id', userId)
    .eq('account_email', row.account_email)
    .in('provider', googleProviders);
  if (othersError || (others && others.length > 0)) {
    return { status: 200, body: { ok: true, revoked: 'skipped_shared_grant' } };
  }

  let token;
  try {
    token = openToken(row.refresh_token, ctx(userId, provider, 'refresh_token')) ||
      openToken(row.access_token, ctx(userId, provider, 'access_token'));
  } catch {
    return { status: 200, body: { ok: true, revoked: 'failed' } };
  }
  if (!token) return { status: 200, body: { ok: true, revoked: 'no_token' } };
  let revoked = false;
  try {
    revoked = await revokeGoogle(token);
  } catch { /* best effort */ }
  return { status: 200, body: { ok: true, revoked: revoked ? 'revoked' : 'failed' } };
}
