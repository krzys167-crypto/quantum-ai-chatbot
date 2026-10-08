import { MS_PROVIDER_SCOPES, getMicrosoftConfig, buildMicrosoftAuthUrl } from '../lib/microsoft.js';
import { getUserFromAuthHeader, getAdminClient } from '../lib/supabaseAdmin.js';
import { beginFlow } from '../lib/oauthFlow.js';

export default async function handler(req, res) {
  try {
    const user = await getUserFromAuthHeader(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const provider = (req.query?.provider || 'outlook').toString();

    const { clientId, appUrl, tenant } = getMicrosoftConfig();
    if (!clientId || !appUrl) {
      return res.status(500).json({
        error: 'Microsoft connector is not configured. Add MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET (and APP_URL) in Vercel env.',
      });
    }

    const redirectUri = `${appUrl}/api/connectors/microsoft-callback`;
    const { status, body } = await beginFlow({
      family: 'microsoft',
      provider,
      user,
      admin: getAdminClient(),
      scopesFor: (p) => MS_PROVIDER_SCOPES[p],
      buildUrl: (state) =>
        buildMicrosoftAuthUrl({ clientId, redirectUri, scopes: MS_PROVIDER_SCOPES[provider], state, tenant }),
    });
    return res.status(status).json(body);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to start Microsoft OAuth' });
  }
}
