import {
  MS_PROVIDER_SCOPES,
  getMicrosoftConfig,
  exchangeMicrosoftCode,
  getMicrosoftEmail,
} from '../lib/microsoft.js';
import { getAdminClient } from '../lib/supabaseAdmin.js';
import { finishFlow } from '../lib/oauthFlow.js';

export default async function handler(req, res) {
  const home = (process.env.APP_URL || '').replace(/\/$/, '') || '/';
  try {
    const { clientId, clientSecret, appUrl, tenant } = getMicrosoftConfig();
    const redirectUri = `${appUrl}/api/connectors/microsoft-callback`;
    const location = await finishFlow({
      family: 'microsoft',
      query: req.query || {},
      admin: getAdminClient(),
      scopesFor: (p) => MS_PROVIDER_SCOPES[p],
      exchangeCode: (code) => exchangeMicrosoftCode({ clientId, clientSecret, code, redirectUri, tenant }),
      getEmail: getMicrosoftEmail,
      home,
    });
    return res.redirect(location);
  } catch (e) {
    console.error('microsoft-callback error:', e);
    return res.redirect(`${home}?connector_error=callback_failed`);
  }
}
