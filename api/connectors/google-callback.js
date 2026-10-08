import { PROVIDER_SCOPES, getGoogleConfig, exchangeCode, getGoogleEmail } from '../lib/google.js';
import { getAdminClient } from '../lib/supabaseAdmin.js';
import { finishFlow } from '../lib/oauthFlow.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  const { clientId, clientSecret, appUrl } = getGoogleConfig();
  const redirectUri = `${appUrl}/api/connectors/google-callback`;
  const home = appUrl || '/';

  try {
    const location = await finishFlow({
      family: 'google',
      query: req.query || {},
      admin: getAdminClient(),
      scopesFor: (p) => PROVIDER_SCOPES[p],
      exchangeCode: (code) => exchangeCode({ clientId, clientSecret, code, redirectUri }),
      getEmail: getGoogleEmail,
      home,
    });
    return res.redirect(location);
  } catch (err) {
    console.error('google-callback error:', err);
    return res.redirect(`${home}?connector_error=callback_failed`);
  }
}
