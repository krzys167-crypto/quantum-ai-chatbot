// Read a usable access token for a connector, refreshing it when needed (P6).
// Tokens are opened/sealed with row-bound AAD; refresh-token rotation is stored;
// a revoked grant (invalid_grant) marks the connector instead of failing every call.
import { openToken, sealToken } from './tokenCrypto.js';

const ctx = (userId, provider, column) => ({ userId, provider, column });

export async function getValidConnectorToken({ admin, userId, provider, refresh, now = Date.now(), log = console }) {
  const { data: c } = await admin
    .from('connectors')
    .select('id, access_token, refresh_token, token_expires_at')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('status', 'connected')
    .maybeSingle();
  if (!c?.access_token) return null;

  const access = openToken(c.access_token, ctx(userId, provider, 'access_token'));
  const expires = c.token_expires_at ? new Date(c.token_expires_at).getTime() : 0;
  if (expires && expires >= now + 60_000) return access;
  if (!c.refresh_token || !refresh) return access;

  let refreshed;
  try {
    refreshed = await refresh(openToken(c.refresh_token, ctx(userId, provider, 'refresh_token')));
  } catch (e) {
    if (e?.oauthError === 'invalid_grant') {
      await admin.from('connectors').update({ status: 'revoked', updated_at: new Date(now).toISOString() }).eq('id', c.id);
      return null;
    }
    throw e;
  }

  const update = {
    access_token: sealToken(refreshed.access_token, ctx(userId, provider, 'access_token')),
    token_expires_at: refreshed.expires_in ? new Date(now + refreshed.expires_in * 1000).toISOString() : null,
    updated_at: new Date(now).toISOString(),
  };
  // Providers may rotate the refresh token (Microsoft always does): keep the newest one.
  if (refreshed.refresh_token) update.refresh_token = sealToken(refreshed.refresh_token, ctx(userId, provider, 'refresh_token'));
  const { error } = await admin.from('connectors').update(update).eq('id', c.id);
  if (error) log.error?.('connector token update failed:', error.message);
  return refreshed.access_token;
}
