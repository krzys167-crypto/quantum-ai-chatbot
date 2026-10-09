// HTTP wrappers for the connector endpoints, built from injected dependencies so
// the wiring (who is the user, which state is used, which family a callback accepts)
// can be exercised in tests with a fake req/res. The files in api/connectors/ only
// bind the real dependencies.
import { beginFlow, finishFlow, disconnectFlow, lookup } from './oauthFlow.js';
import { clearNonceCookie } from './oauthState.js';

const isHttps = (url) => /^https:/i.test(String(url || ''));
const cors = (res, methods) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
};

/**
 * GET /api/connectors/<family>-start?provider=...  (Authorization: Bearer)
 * `configure()` returns { config } or { status, body } for a misconfigured server.
 */
export function makeStartHandler({
  family, defaultProvider, scopes, getUser, getAdmin, configure, buildUrl, allow = () => true, withCors = false, log = console,
}) {
  return async function handler(req, res) {
    if (withCors) {
      cors(res, 'GET, OPTIONS');
      if (req.method === 'OPTIONS') return res.status(200).end();
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const user = await getUser(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      if (!allow(`oauth-start:${user.id}`, 20, 60_000)) return res.status(429).json({ error: 'Too many requests' });

      const provider = String(req.query?.provider || defaultProvider);
      const cfg = configure();
      if (!cfg.config) return res.status(cfg.status).json(cfg.body);

      const { status, body, cookie } = await beginFlow({
        family,
        provider,
        user,
        admin: getAdmin(),
        scopesFor: (p) => lookup(scopes, p),
        buildUrl: (state) => buildUrl(cfg.config, lookup(scopes, provider), state),
        secureCookie: isHttps(cfg.config.appUrl),
      });
      if (cookie) res.setHeader('Set-Cookie', cookie);
      return res.status(status).json(body);
    } catch (err) {
      log.error?.(`${family}-start error:`, err);
      return res.status(500).json({ error: err.message || 'Internal error' });
    }
  };
}

/** GET /api/connectors/<family>-callback?code&state (top-level redirect from the provider). */
export function makeCallbackHandler({ family, scopes, getAdmin, configure, exchange, getEmail, log = console }) {
  return async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).send('Method not allowed');
    const cfg = configure();
    const home = cfg.home || '/';
    try {
      const location = await finishFlow({
        family,
        query: req.query || {},
        cookieHeader: req.headers?.cookie,
        admin: getAdmin(),
        scopesFor: (p) => lookup(scopes, p),
        exchangeCode: (code) => exchange(cfg, code),
        getEmail,
        home,
      });
      const clear = clearNonceCookie(req.query?.state, { secure: isHttps(cfg.appUrl) });
      if (clear) res.setHeader('Set-Cookie', clear);
      return res.redirect(location);
    } catch (err) {
      log.error?.(`${family}-callback error:`, err);
      return res.redirect(`${home}?connector_error=callback_failed`);
    }
  };
}

/** POST /api/connectors/disconnect {provider}: the user is always the authenticated one, never from the body. */
export function makeDisconnectHandler({ getUser, getAdmin, scopesByFamily, googleProviders, revokeGoogle, openToken, log = console }) {
  const familyOf = (p) => (lookup(scopesByFamily.google, p) ? 'google' : lookup(scopesByFamily.microsoft, p) ? 'microsoft' : null);
  return async function handler(req, res) {
    cors(res, 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const user = await getUser(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const provider = body?.provider;
      if (!provider) return res.status(400).json({ error: 'provider required' });
      const { status, body: out } = await disconnectFlow({
        admin: getAdmin(),
        userId: user.id,
        provider: String(provider),
        familyOf,
        googleProviders,
        revokeGoogle,
        openToken,
      });
      return res.status(status).json(out);
    } catch (err) {
      log.error?.('disconnect error:', err);
      return res.status(500).json({ error: err.message || 'Internal error' });
    }
  };
}
