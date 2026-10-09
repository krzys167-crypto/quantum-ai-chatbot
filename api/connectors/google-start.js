import { PROVIDER_SCOPES, getGoogleConfig, buildAuthUrl } from '../lib/google.js';
import { getUserFromAuthHeader, getAdminClient } from '../lib/supabaseAdmin.js';
import { allowRequest } from '../lib/rateLimit.js';
import { makeStartHandler } from '../lib/connectorHandlers.js';

export default makeStartHandler({
  family: 'google',
  defaultProvider: 'gmail',
  scopes: PROVIDER_SCOPES,
  withCors: true,
  getUser: getUserFromAuthHeader,
  getAdmin: getAdminClient,
  allow: allowRequest,
  configure: () => {
    const { clientId, clientSecret, appUrl } = getGoogleConfig();
    if (!clientId || !clientSecret) {
      return {
        status: 500,
        body: { error: 'Google OAuth not configured', hint: 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel env vars' },
      };
    }
    if (!appUrl) {
      return {
        status: 500,
        body: { error: 'APP_URL not set', hint: 'Set APP_URL to your deployed site, e.g. https://quantumy-ai.vercel.app' },
      };
    }
    return { config: { clientId, appUrl, redirectUri: `${appUrl}/api/connectors/google-callback` } };
  },
  buildUrl: ({ clientId, redirectUri }, scopes, state) => buildAuthUrl({ clientId, redirectUri, scopes, state }),
});
