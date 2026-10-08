/** Microsoft OAuth + Graph helpers for Outlook & Excel */

export const MS_PROVIDER_SCOPES = {
  outlook: [
    'offline_access',
    'openid',
    'profile',
    'email',
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/User.Read',
  ],
  excel: [
    'offline_access',
    'openid',
    'profile',
    'email',
    'https://graph.microsoft.com/Files.Read',
    'https://graph.microsoft.com/Sites.Read.All',
    'https://graph.microsoft.com/User.Read',
  ],
};

export function getMicrosoftConfig() {
  return {
    clientId: process.env.MICROSOFT_CLIENT_ID || process.env.AZURE_CLIENT_ID || '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET || '',
    appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
    tenant: process.env.MICROSOFT_TENANT || 'common',
  };
}

export function buildMicrosoftAuthUrl({ clientId, redirectUri, scopes, state, tenant }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: scopes.join(' '),
    state,
  });
  return `https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/authorize?${params}`;
}

export async function exchangeMicrosoftCode({ clientId, clientSecret, code, redirectUri, tenant }) {
  const res = await fetch(`https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'MS token exchange failed');
  return data;
}

export async function refreshMicrosoftToken({ clientId, clientSecret, refreshToken, tenant }) {
  const res = await fetch(`https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error_description || data.error || 'MS token refresh failed'), { oauthError: data.error });
  return data;
}

export async function getMicrosoftEmail(accessToken) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.mail || data.userPrincipalName || null;
}

export async function searchOutlook(accessToken, query, maxResults = 10) {
  const top = Math.min(15, Math.max(1, maxResults));
  const url = new URL('https://graph.microsoft.com/v1.0/me/messages');
  url.searchParams.set('$top', String(top));
  url.searchParams.set('$select', 'id,subject,from,receivedDateTime,bodyPreview,webLink');
  // Graph forbids $search + $orderby together → 400. Only order when not searching.
  const q = String(query || '').trim().replace(/"/g, '');
  if (q) {
    url.searchParams.set('$search', `"${q}"`);
  } else {
    url.searchParams.set('$orderby', 'receivedDateTime desc');
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ConsistencyLevel: 'eventual',
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Outlook search failed: ${res.status} ${t}`);
  }
  const data = await res.json();
  return (data.value || []).map((m) => ({
    id: m.id,
    subject: m.subject || '',
    from: m.from?.emailAddress?.address || '',
    date: m.receivedDateTime || '',
    snippet: m.bodyPreview || '',
    link: m.webLink || '',
  }));
}

export async function searchExcelFiles(accessToken, query, maxResults = 10) {
  const top = Math.min(15, Math.max(1, maxResults));
  // OData: escape single quotes by doubling; keep the rest URL-safe
  const raw = String(query || 'xlsx').trim().slice(0, 120) || 'xlsx';
  const term = raw.replace(/'/g, "''");
  const searchUrl =
    `https://graph.microsoft.com/v1.0/me/drive/root/search(q='${encodeURIComponent(term)}')` +
    `?$top=${top}&$select=id,name,webUrl,lastModifiedDateTime,size,file`;
  const res = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Excel/OneDrive search failed: ${res.status} ${t}`);
  }
  const data = await res.json();
  return (data.value || [])
    .filter((f) => /\.xlsx?$/i.test(f.name || '') || (f.file && /spreadsheet|excel/i.test(f.file.mimeType || '')))
    .slice(0, top)
    .map((f) => ({
      id: f.id,
      name: f.name,
      webUrl: f.webUrl,
      modified: f.lastModifiedDateTime,
      size: f.size,
    }));
}
