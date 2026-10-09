import { MS_PROVIDER_SCOPES, getMicrosoftConfig, buildMicrosoftAuthUrl } from '../lib/microsoft.js';
import { getUserFromAuthHeader, getAdminClient } from '../lib/supabaseAdmin.js';
import { allowRequest } from '../lib/rateLimit.js';
import { makeStartHandler } from '../lib/connectorHandlers.js';

export default makeStartHandler({
  family: 'microsoft',
  defaultProvider: 'outlook',
  scopes: MS_PROVIDER_SCOPES,
  getUser: getUserFromAuthHeader,
  getAdmin: getAdminClient,
  allow: allowRequest,
  configure: () => {
    const { clientId, appUrl, tenant } = getMicrosoftConfig();
    if (!clientId || !appUrl) {
      return {
        status: 500,
        body: { error: 'Microsoft connector is not configured. Add MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET (and APP_URL) in Vercel env.' },
      };
    }
    return { config: { clientId, appUrl, tenant, redirectUri: `${appUrl}/api/connectors/microsoft-callback` } };
  },
  buildUrl: ({ clientId, redirectUri, tenant }, scopes, state) =>
    buildMicrosoftAuthUrl({ clientId, redirectUri, scopes, state, tenant }),
});
