import { getUserFromAuthHeader, getAdminClient } from '../lib/supabaseAdmin.js';
import { PROVIDER_SCOPES, revokeGoogleToken } from '../lib/google.js';
import { MS_PROVIDER_SCOPES } from '../lib/microsoft.js';
import { openToken } from '../lib/tokenCrypto.js';
import { makeDisconnectHandler } from '../lib/connectorHandlers.js';

export default makeDisconnectHandler({
  getUser: getUserFromAuthHeader,
  getAdmin: getAdminClient,
  scopesByFamily: { google: PROVIDER_SCOPES, microsoft: MS_PROVIDER_SCOPES },
  googleProviders: Object.keys(PROVIDER_SCOPES),
  revokeGoogle: revokeGoogleToken,
  openToken,
});
