import { PROVIDER_SCOPES, getGoogleConfig, exchangeCode, getGoogleEmail } from '../lib/google.js';
import { getAdminClient } from '../lib/supabaseAdmin.js';
import { makeCallbackHandler } from '../lib/connectorHandlers.js';

export default makeCallbackHandler({
  family: 'google',
  scopes: PROVIDER_SCOPES,
  getAdmin: getAdminClient,
  getEmail: getGoogleEmail,
  configure: () => {
    const { clientId, clientSecret, appUrl } = getGoogleConfig();
    return { clientId, clientSecret, appUrl, home: appUrl || '/', redirectUri: `${appUrl}/api/connectors/google-callback` };
  },
  exchange: ({ clientId, clientSecret, redirectUri }, code) => exchangeCode({ clientId, clientSecret, code, redirectUri }),
});
