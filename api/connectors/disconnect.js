import { getUserFromAuthHeader, getAdminClient } from '../lib/supabaseAdmin.js';
import { PROVIDER_SCOPES, revokeGoogleToken } from '../lib/google.js';
import { MS_PROVIDER_SCOPES } from '../lib/microsoft.js';
import { disconnectFlow } from '../lib/oauthFlow.js';
import { openToken } from '../lib/tokenCrypto.js';

const googleProviders = Object.keys(PROVIDER_SCOPES);
const familyOf = (p) => (PROVIDER_SCOPES[p] ? 'google' : MS_PROVIDER_SCOPES[p] ? 'microsoft' : null);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const user = await getUserFromAuthHeader(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const provider = body?.provider;
    if (!provider) return res.status(400).json({ error: 'provider required' });

    const { status, body: out } = await disconnectFlow({
      admin: getAdminClient(),
      userId: user.id,
      provider: String(provider),
      familyOf,
      googleProviders,
      revokeGoogle: revokeGoogleToken,
      openToken,
    });
    return res.status(status).json(out);
  } catch (err) {
    console.error('disconnect error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
