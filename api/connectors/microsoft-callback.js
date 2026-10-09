import { MS_PROVIDER_SCOPES, getMicrosoftConfig, exchangeMicrosoftCode, getMicrosoftEmail } from '../lib/microsoft.js';
import { getAdminClient } from '../lib/supabaseAdmin.js';
import { makeCallbackHandler } from '../lib/connectorHandlers.js';

export default makeCallbackHandler({
  family: 'microsoft',
  scopes: MS_PROVIDER_SCOPES,
  getAdmin: getAdminClient,
  getEmail: getMicrosoftEmail,
  configure: () => {
    const { clientId, clientSecret, appUrl, tenant } = getMicrosoftConfig();
    return {
      clientId, clientSecret, appUrl, tenant,
      home: (process.env.APP_URL || '').replace(/\/$/, '') || '/',
      redirectUri: `${appUrl}/api/connectors/microsoft-callback`,
    };
  },
  exchange: ({ clientId, clientSecret, redirectUri, tenant }, code) =>
    exchangeMicrosoftCode({ clientId, clientSecret, code, redirectUri, tenant }),
});
