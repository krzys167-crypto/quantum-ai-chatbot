import { PROVIDER_SCOPES, getGoogleConfig, buildAuthUrl } from '../lib/google.js';
import { getUserFromAuthHeader, getAdminClient } from '../lib/supabaseAdmin.js';
import { beginFlow } from '../lib/oauthFlow.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const user = await getUserFromAuthHeader(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const provider = (req.query?.provider || 'gmail').toString();

    const { clientId, clientSecret, appUrl } = getGoogleConfig();
    if (!clientId || !clientSecret) {
      return res.status(500).json({
        error: 'Google OAuth not configured',
        hint: 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel env vars',
      });
    }
    if (!appUrl) {
      return res.status(500).json({
        error: 'APP_URL not set',
        hint: 'Set APP_URL to your deployed site, e.g. https://quantumy-ai.vercel.app',
      });
    }

    const redirectUri = `${appUrl}/api/connectors/google-callback`;
    const { status, body } = await beginFlow({
      family: 'google',
      provider,
      user,
      admin: getAdminClient(),
      scopesFor: (p) => PROVIDER_SCOPES[p],
      buildUrl: (state) => buildAuthUrl({ clientId, redirectUri, scopes: PROVIDER_SCOPES[provider], state }),
    });
    return res.status(status).json(body);
  } catch (err) {
    console.error('google-start error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
