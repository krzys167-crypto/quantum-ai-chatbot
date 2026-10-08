/** Shared Google OAuth + token helpers for serverless functions */

export const PROVIDER_SCOPES = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  google_drive: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  google_docs: [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  google_sheets: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  google_calendar: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
};

export function getGoogleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
  };
}

export function buildAuthUrl({ clientId, redirectUri, scopes, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
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
  if (!res.ok) throw Object.assign(new Error(data.error_description || data.error || 'Token exchange failed'), { oauthError: data.error });
  return data;
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
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
  if (!res.ok) throw Object.assign(new Error(data.error_description || data.error || 'Token refresh failed'), { oauthError: data.error });
  return data;
}

/** Revoke a Google token (token in the body, never in the URL). true = revoked or already invalid. */
export async function revokeGoogleToken(token) {
  const res = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
  if (res.ok) return true;
  const data = await res.json().catch(() => ({}));
  return data.error === 'invalid_token';
}

export async function getGoogleEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.email || null;
}

export async function searchGmail(accessToken, query, maxResults = 10) {
  const q = encodeURIComponent(query || 'in:inbox');
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listRes.ok) {
    const t = await listRes.text();
    throw new Error(`Gmail search failed: ${listRes.status} ${t}`);
  }
  const list = await listRes.json();
  const messages = list.messages || [];
  const out = [];
  for (const m of messages.slice(0, maxResults)) {
    const detail = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!detail.ok) continue;
    const msg = await detail.json();
    const headers = msg.payload?.headers || [];
    const getH = (n) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || '';
    out.push({
      id: msg.id,
      threadId: msg.threadId,
      snippet: msg.snippet || '',
      subject: getH('Subject'),
      from: getH('From'),
      date: getH('Date'),
      labelIds: msg.labelIds || [],
      body: extractBody(msg.payload),
    });
  }
  return out;
}

function extractBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) return decodeB64(payload.body.data);
  const parts = payload.parts || [];
  for (const p of parts) {
    if (p.mimeType === 'text/plain' && p.body?.data) return decodeB64(p.body.data);
  }
  for (const p of parts) {
    if (p.mimeType === 'text/html' && p.body?.data) {
      return decodeB64(p.body.data).replace(/<[^>]+>/g, ' ');
    }
    if (p.parts) {
      const inner = extractBody(p);
      if (inner) return inner;
    }
  }
  return '';
}

function decodeB64(data) {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function encodeRawMessage({ to, subject, body, cc, bcc, from }) {
  const headers = [
    from ? `From: ${from}` : null,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter(Boolean);
  const raw = `${headers.join('\r\n')}\r\n\r\n${body || ''}`;
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sendGmail(accessToken, { to, subject, body, cc, bcc }) {
  if (!to || !subject) throw new Error('to and subject are required');
  const raw = encodeRawMessage({ to, subject, body, cc, bcc });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: data.id, threadId: data.threadId, labelIds: data.labelIds || [] };
}

export async function createGmailDraft(accessToken, { to, subject, body, cc, bcc }) {
  if (!to || !subject) throw new Error('to and subject are required');
  const raw = encodeRawMessage({ to, subject, body, cc, bcc });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw } }),
  });
  if (!res.ok) throw new Error(`Gmail draft failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: data.id, messageId: data.message?.id };
}

export async function modifyGmailMessage(accessToken, messageId, { addLabelIds = [], removeLabelIds = [] } = {}) {
  if (!messageId) throw new Error('messageId is required');
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    }
  );
  if (!res.ok) throw new Error(`Gmail modify failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: data.id, labelIds: data.labelIds || [] };
}

export async function trashGmailMessage(accessToken, messageId) {
  if (!messageId) throw new Error('messageId is required');
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/trash`,
    { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Gmail trash failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: data.id, labelIds: data.labelIds || [], trashed: true };
}

function buildDriveQuery(raw) {
  const q = String(raw || '').trim();
  if (!q) return 'trashed = false';
  if (/\b(contains|mimeType|trashed|parents|fullText|modifiedTime|createdTime|name\s*=)\b/i.test(q) || /\s(and|or)\s/i.test(q)) {
    if (!/trashed/i.test(q)) return `(${q}) and trashed = false`;
    return q;
  }
  const safe = q.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `(name contains '${safe}' or fullText contains '${safe}') and trashed = false`;
}

export async function searchDrive(accessToken, query, maxResults = 10) {
  const q = buildDriveQuery(query);
  const params = new URLSearchParams({
    q,
    pageSize: String(Math.min(25, Math.max(1, maxResults || 10))),
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink,parents)',
    orderBy: 'modifiedTime desc',
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive search failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    link: f.webViewLink,
    parents: f.parents || [],
  }));
}

export async function readGoogleDoc(accessToken, documentId) {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Docs read failed: ${res.status} ${await res.text()}`);
  const doc = await res.json();
  const chunks = [];
  const walk = (content) => {
    if (!content) return;
    for (const el of content) {
      if (el.paragraph?.elements) {
        for (const e of el.paragraph.elements) {
          if (e.textRun?.content) chunks.push(e.textRun.content);
        }
      }
      if (el.table?.tableRows) {
        for (const row of el.table.tableRows) {
          for (const cell of row.tableCells || []) walk(cell.content);
        }
      }
    }
  };
  walk(doc.body?.content);
  return { title: doc.title || '', documentId: doc.documentId, text: chunks.join('').slice(0, 12000) };
}

export async function createGoogleDoc(accessToken, { title, body }) {
  const createRes = await fetch('https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title || 'Untitled' }),
  });
  if (!createRes.ok) throw new Error(`Docs create failed: ${createRes.status} ${await createRes.text()}`);
  const doc = await createRes.json();
  const documentId = doc.documentId;
  if (body && String(body).trim()) {
    const text = String(body);
    const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ insertText: { location: { index: 1 }, text } }],
      }),
    });
    if (!updateRes.ok) {
      const t = await updateRes.text();
      return {
        documentId,
        title: doc.title,
        link: `https://docs.google.com/document/d/${documentId}/edit`,
        bodyError: t.slice(0, 200),
      };
    }
  }
  return {
    documentId,
    title: doc.title || title,
    link: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

export async function appendGoogleDocText(accessToken, documentId, text) {
  if (!documentId) throw new Error('documentId is required');
  if (!text) throw new Error('text is required');
  const getRes = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}?fields=body(content)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!getRes.ok) throw new Error(`Docs get failed: ${getRes.status} ${await getRes.text()}`);
  const doc = await getRes.json();
  let endIndex = 1;
  const content = doc.body?.content || [];
  for (const el of content) {
    if (typeof el.endIndex === 'number') endIndex = Math.max(endIndex, el.endIndex);
  }
  const insertAt = Math.max(1, endIndex - 1);
  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: insertAt }, text: String(text) } }],
    }),
  });
  if (!updateRes.ok) throw new Error(`Docs append failed: ${updateRes.status} ${await updateRes.text()}`);
  return {
    documentId,
    link: `https://docs.google.com/document/d/${documentId}/edit`,
    appended: true,
  };
}

export async function searchSheets(accessToken, query, maxResults = 8) {
  const qParts = ["mimeType = 'application/vnd.google-apps.spreadsheet'", 'trashed = false'];
  if (query && String(query).trim()) {
    const safe = String(query).trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    qParts.push(`name contains '${safe}'`);
  }
  const params = new URLSearchParams({
    q: qParts.join(' and '),
    pageSize: String(Math.min(15, Math.max(1, maxResults || 8))),
    fields: 'files(id,name,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Sheets search failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    modifiedTime: f.modifiedTime,
    link: f.webViewLink,
  }));
}

export async function readSheetRange(accessToken, spreadsheetId, range = 'A1:Z30') {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Sheets read failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { spreadsheetId, range: data.range || range, values: (data.values || []).slice(0, 40) };
}

export async function createSpreadsheet(accessToken, { title, headers, rows }) {
  const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title: title || 'Untitled spreadsheet' },
    }),
  });
  if (!createRes.ok) throw new Error(`Sheets create failed: ${createRes.status} ${await createRes.text()}`);
  const sheet = await createRes.json();
  const spreadsheetId = sheet.spreadsheetId;
  const values = [];
  if (Array.isArray(headers) && headers.length) values.push(headers.map(String));
  if (Array.isArray(rows)) {
    for (const row of rows.slice(0, 500)) {
      values.push((Array.isArray(row) ? row : [row]).map((c) => (c == null ? '' : String(c))));
    }
  }
  if (values.length) {
    const writeRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/A1:append?valueInputOption=USER_ENTERED`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      }
    );
    if (!writeRes.ok) {
      return {
        spreadsheetId,
        title: sheet.properties?.title,
        link: sheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        writeError: (await writeRes.text()).slice(0, 200),
      };
    }
  }
  return {
    spreadsheetId,
    title: sheet.properties?.title || title,
    link: sheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

export async function updateSheetValues(accessToken, { spreadsheetId, range, values, append }) {
  if (!spreadsheetId) throw new Error('spreadsheetId is required');
  if (!Array.isArray(values) || !values.length) throw new Error('values array is required');
  const normalized = values.map((row) =>
    (Array.isArray(row) ? row : [row]).map((c) => (c == null ? '' : String(c)))
  );
  const r = range || 'A1';
  if (append) {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(r)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: normalized }),
      }
    );
    if (!res.ok) throw new Error(`Sheets append failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return {
      spreadsheetId,
      updatedRange: data.updates?.updatedRange,
      updatedRows: data.updates?.updatedRows,
      link: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      appended: true,
    };
  }
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(r)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: normalized }),
    }
  );
  if (!res.ok) throw new Error(`Sheets update failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    spreadsheetId,
    updatedRange: data.updatedRange,
    updatedRows: data.updatedRows,
    link: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

export async function listCalendarEvents(accessToken, { timeMin, timeMax, maxResults = 15, query } = {}) {
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(Math.min(Math.max(maxResults || 15, 1), 25)),
  });
  if (timeMin) params.set('timeMin', timeMin);
  else params.set('timeMin', new Date().toISOString());
  if (timeMax) params.set('timeMax', timeMax);
  if (query) params.set('q', query);
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Calendar list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.items || []).map((ev) => ({
    id: ev.id,
    summary: ev.summary || '(No title)',
    description: (ev.description || '').slice(0, 400),
    location: ev.location || '',
    start: ev.start?.dateTime || ev.start?.date || '',
    end: ev.end?.dateTime || ev.end?.date || '',
    htmlLink: ev.htmlLink || '',
    status: ev.status || '',
  }));
}

export async function createCalendarEvent(accessToken, {
  summary,
  description,
  location,
  start,
  end,
  attendees,
  allDay,
  timeZone,
}) {
  if (!summary) throw new Error('summary is required');
  if (!start) throw new Error('start is required (ISO date or datetime)');
  const tz = timeZone || 'UTC';
  let startObj;
  let endObj;
  if (allDay) {
    const startDate = String(start).slice(0, 10);
    const endDate = end ? String(end).slice(0, 10) : startDate;
    startObj = { date: startDate };
    endObj = { date: endDate };
  } else {
    startObj = { dateTime: start, timeZone: tz };
    endObj = {
      dateTime: end || new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString(),
      timeZone: tz,
    };
  }
  const body = {
    summary: String(summary),
    description: description ? String(description) : undefined,
    location: location ? String(location) : undefined,
    start: startObj,
    end: endObj,
  };
  if (Array.isArray(attendees) && attendees.length) {
    body.attendees = attendees
      .map((a) => (typeof a === 'string' ? { email: a } : a))
      .filter((a) => a?.email);
  }
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Calendar create failed: ${res.status} ${await res.text()}`);
  const ev = await res.json();
  return {
    id: ev.id,
    summary: ev.summary,
    start: ev.start?.dateTime || ev.start?.date,
    end: ev.end?.dateTime || ev.end?.date,
    htmlLink: ev.htmlLink,
    status: ev.status,
  };
}

export { readDriveFile } from './driveRead.js';
