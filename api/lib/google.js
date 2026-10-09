/** Shared Google OAuth + token helpers for serverless functions */
import { headerValue } from './mimeHeaders.js';

// Read budgets, matched to driveRead.js so all three readers behave the same.
// Reads are paginated rather than silently cut: a truncated result always says
// so and carries the offset to continue from, because a caller that can't tell
// truncation from "end of data" will confidently report the wrong answer.
const READ_DEFAULT_MAX = 80000;
const READ_HARD_MAX = 150000;
const SHEET_MAX_ROWS = 1000;
const SHEET_DEFAULT_RANGE = 'A1:BZ2000';

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

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
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token exchange failed');
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
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token refresh failed');
  return data;
}

export async function getGoogleEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.email || null;
}

// A search result is a shortlist, not a document dump. Returning every matched
// message's full body inlines an unbounded amount of text into the model
// prompt — long forwarded chains quote their entire history, so a handful of
// hits can run to megabytes. Callers that need the whole message body ask for
// it explicitly with get_gmail_message.
const GMAIL_SEARCH_BODY_CHARS = 1200;

function previewBody(text) {
  const s = String(text || '');
  if (s.length <= GMAIL_SEARCH_BODY_CHARS) return { body: s, truncated: false };
  return {
    body: s.slice(0, GMAIL_SEARCH_BODY_CHARS),
    truncated: true,
    full_length: s.length,
  };
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
    const preview = previewBody(extractBody(msg.payload));
    out.push({
      id: msg.id,
      threadId: msg.threadId,
      snippet: msg.snippet || '',
      subject: getH('Subject'),
      from: getH('From'),
      date: getH('Date'),
      labelIds: msg.labelIds || [],
      body: preview.body,
      ...(preview.truncated
        ? {
            body_truncated: true,
            body_full_length: preview.full_length,
            note: 'Preview only. Call get_gmail_message with this id for the full body.',
          }
        : {}),
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
    from ? `From: ${headerValue(from)}` : null,
    `To: ${headerValue(to)}`,
    cc ? `Cc: ${headerValue(cc)}` : null,
    bcc ? `Bcc: ${headerValue(bcc)}` : null,
    `Subject: ${headerValue(subject)}`,
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

export async function readGoogleDoc(accessToken, documentId, opts = {}) {
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

  const full = chunks.join('');
  const start = clampInt(opts.offset, 0, Math.max(0, full.length), 0);
  const limit = clampInt(opts.max_chars, 1, READ_HARD_MAX, READ_DEFAULT_MAX);
  const end = Math.min(full.length, start + limit);
  const truncated = end < full.length;

  return {
    title: doc.title || '',
    documentId: doc.documentId,
    text: full.slice(start, end),
    total_chars: full.length,
    offset: start,
    truncated,
    ...(truncated
      ? {
          next_offset: end,
          note: `Showing characters ${start}-${end} of ${full.length}. More text follows — read again with offset=${end}. Do not treat this as the end of the document.`,
        }
      : {}),
  };
}

/**
 * Find Drive folders by name. Needs the full `drive` scope (the google_drive
 * connector) — a google_docs token only carries `drive.file`, which can't see
 * folders the app didn't create.
 */
export async function findDriveFolders(accessToken, name, maxResults = 5) {
  const safe = String(name || '').trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  if (!safe) return [];
  const params = new URLSearchParams({
    q: `mimeType = 'application/vnd.google-apps.folder' and name contains '${safe}' and trashed = false`,
    pageSize: String(Math.min(10, Math.max(1, maxResults))),
    fields: 'files(id,name,webViewLink,parents,modifiedTime)',
    orderBy: 'modifiedTime desc',
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Drive folder search failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.files || []).map((f) => ({ id: f.id, name: f.name, link: f.webViewLink }));
}

/** Move a Drive file into a folder, detaching it from its current parents. */
export async function moveFileToFolder(accessToken, fileId, folderId) {
  if (!fileId) throw new Error('fileId is required');
  if (!folderId) throw new Error('folderId is required');
  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=parents&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!metaRes.ok) throw new Error(`Drive read parents failed: ${metaRes.status} ${await metaRes.text()}`);
  const meta = await metaRes.json();
  const previous = (meta.parents || []).join(',');

  const params = new URLSearchParams({
    addParents: folderId,
    fields: 'id,name,parents,webViewLink',
    supportsAllDrives: 'true',
  });
  if (previous) params.set('removeParents', previous);

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params}`,
    { method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Drive move failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: data.id, name: data.name, parents: data.parents || [], link: data.webViewLink };
}

/**
 * Upload an arbitrary file (e.g. generated PDF) directly into Google Drive
 */
export async function uploadDriveFile(accessToken, { name, mimeType = 'application/pdf', buffer, folderId }) {
  const boundary = '-------QuantumDriveUploadBoundary' + Date.now();
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadata = {
    name: name || 'Untitled Document',
    mimeType,
  };
  if (folderId) {
    metadata.parents = [folderId];
  }

  const metaHeader = `Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`;
  const mediaHeader = `Content-Type: ${mimeType}\r\n\r\n`;

  const bodyBuffer = Buffer.concat([
    Buffer.from(delimiter + metaHeader + delimiter + mediaHeader),
    Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
    Buffer.from(closeDelimiter),
  ]);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,webContentLink,parents',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(bodyBuffer.length),
      },
      body: bodyBuffer,
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive upload failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return {
    id: data.id,
    name: data.name,
    link: data.webViewLink,
    downloadLink: data.webContentLink,
    parents: data.parents || [],
  };
}

/**
 * Parse markdown text and generate Google Docs API batchUpdate styling requests
 */
function buildDocStylingRequests(body) {
  const lines = String(body || '').split('\n');
  const requests = [];
  let plainText = '';
  let currentIndex = 1; // Google Docs body begins at index 1

  const styledSegments = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    let lineType = 'normal';
    let content = rawLine;

    if (/^#\s+/.test(content)) {
      lineType = 'h1';
      content = content.replace(/^#\s+/, '');
    } else if (/^##\s+/.test(content)) {
      lineType = 'h2';
      content = content.replace(/^##\s+/, '');
    } else if (/^###\s+/.test(content)) {
      lineType = 'h3';
      content = content.replace(/^###\s+/, '');
    } else if (/^>\s+/.test(content)) {
      lineType = 'quote';
      content = content.replace(/^>\s+/, '');
    } else if (/^[-*]\s+/.test(content)) {
      lineType = 'bullet';
      content = content.replace(/^[-*]\s+/, '');
    }

    // Process inline bold (**text**) while tracking exact string indices
    const boldRanges = [];
    const boldRegex = /\*\*(.*?)\*\*/g;
    let match;
    let cleanedContent = '';
    let lastIdx = 0;

    while ((match = boldRegex.exec(content)) !== null) {
      cleanedContent += content.slice(lastIdx, match.index);
      const boldStart = cleanedContent.length;
      cleanedContent += match[1];
      const boldEnd = cleanedContent.length;
      boldRanges.push({ start: boldStart, end: boldEnd });
      lastIdx = match.index + match[0].length;
    }
    cleanedContent += content.slice(lastIdx);

    const lineText = cleanedContent + '\n';
    const startIndex = currentIndex;
    const endIndex = currentIndex + lineText.length;

    styledSegments.push({
      type: lineType,
      startIndex,
      endIndex,
      boldRanges: boldRanges.map((r) => ({
        startIndex: startIndex + r.start,
        endIndex: startIndex + r.end,
      })),
    });

    plainText += lineText;
    currentIndex = endIndex;
  }

  // 1. Insert full text
  requests.push({
    insertText: { location: { index: 1 }, text: plainText },
  });

  // 2. Apply paragraph and text styling
  for (const seg of styledSegments) {
    if (seg.endIndex <= seg.startIndex) continue;

    if (seg.type === 'h1') {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: seg.startIndex, endIndex: seg.endIndex },
          paragraphStyle: { namedStyleType: 'HEADING_1' },
          fields: 'namedStyleType',
        },
      });
      requests.push({
        updateTextStyle: {
          range: { startIndex: seg.startIndex, endIndex: seg.endIndex - 1 },
          textStyle: {
            bold: true,
            fontSize: { magnitude: 18, unit: 'PT' },
            foregroundColor: { color: { rgbColor: { red: 0.06, green: 0.09, blue: 0.16 } } },
          },
          fields: 'bold,fontSize,foregroundColor',
        },
      });
    } else if (seg.type === 'h2') {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: seg.startIndex, endIndex: seg.endIndex },
          paragraphStyle: { namedStyleType: 'HEADING_2' },
          fields: 'namedStyleType',
        },
      });
      requests.push({
        updateTextStyle: {
          range: { startIndex: seg.startIndex, endIndex: seg.endIndex - 1 },
          textStyle: {
            bold: true,
            fontSize: { magnitude: 14, unit: 'PT' },
            foregroundColor: { color: { rgbColor: { red: 0.12, green: 0.16, blue: 0.24 } } },
          },
          fields: 'bold,fontSize,foregroundColor',
        },
      });
    } else if (seg.type === 'h3') {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: seg.startIndex, endIndex: seg.endIndex },
          paragraphStyle: { namedStyleType: 'HEADING_3' },
          fields: 'namedStyleType',
        },
      });
      requests.push({
        updateTextStyle: {
          range: { startIndex: seg.startIndex, endIndex: seg.endIndex - 1 },
          textStyle: {
            bold: true,
            fontSize: { magnitude: 12, unit: 'PT' },
            foregroundColor: { color: { rgbColor: { red: 0.15, green: 0.39, blue: 0.92 } } },
          },
          fields: 'bold,fontSize,foregroundColor',
        },
      });
    } else if (seg.type === 'bullet') {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: seg.startIndex, endIndex: seg.endIndex },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
    } else if (seg.type === 'quote') {
      requests.push({
        updateTextStyle: {
          range: { startIndex: seg.startIndex, endIndex: seg.endIndex - 1 },
          textStyle: {
            italic: true,
            foregroundColor: { color: { rgbColor: { red: 0.35, green: 0.42, blue: 0.52 } } },
          },
          fields: 'italic,foregroundColor',
        },
      });
    }

    // Inline bolding
    for (const b of seg.boldRanges) {
      if (b.endIndex > b.startIndex) {
        requests.push({
          updateTextStyle: {
            range: { startIndex: b.startIndex, endIndex: b.endIndex },
            textStyle: { bold: true },
            fields: 'bold',
          },
        });
      }
    }
  }

  return requests;
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
    try {
      // Build rich formatted styling requests
      const requests = buildDocStylingRequests(body);
      const updateRes = await fetch(
        `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests }),
        }
      );

      if (!updateRes.ok) {
        // Fallback: simple text insertion if rich batch fails
        console.warn('Rich doc formatting failed, falling back to simple text insert');
        await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [{ insertText: { location: { index: 1 }, text: String(body) } }],
          }),
        });
      }
    } catch (e) {
      console.error('Doc styling error:', e);
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

export async function readSheetRange(accessToken, spreadsheetId, range = SHEET_DEFAULT_RANGE, opts = {}) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Sheets read failed: ${res.status} ${await res.text()}`);
  const data = await res.json();

  const all = data.values || [];
  const startRow = clampInt(opts.offset, 0, Math.max(0, all.length), 0);
  const maxRows = clampInt(opts.max_rows, 1, SHEET_MAX_ROWS, SHEET_MAX_ROWS);
  const maxChars = clampInt(opts.max_chars, 1, READ_HARD_MAX, READ_DEFAULT_MAX);

  // Bound by rows *and* characters — a sheet can blow the budget with a few
  // very wide rows just as easily as with many narrow ones.
  const values = [];
  let chars = 0;
  for (let i = startRow; i < all.length && values.length < maxRows; i++) {
    const len = JSON.stringify(all[i] ?? []).length;
    if (values.length > 0 && chars + len > maxChars) break;
    values.push(all[i]);
    chars += len;
  }

  const nextRow = startRow + values.length;
  const truncated = nextRow < all.length;

  return {
    spreadsheetId,
    range: data.range || range,
    values,
    rows_returned: values.length,
    rows_available_in_range: all.length,
    offset: startRow,
    truncated,
    ...(truncated
      ? {
          next_offset: nextRow,
          note: `Showing rows ${startRow + 1}-${nextRow} of ${all.length} populated rows in this range. More rows follow — read again with offset=${nextRow}. Do not conclude the sheet ends here.`,
        }
      : {}),
  };
}

/**
 * Read a range exactly as it is stored, for journalling a write.
 *
 * Unlike readSheetRange this does not page or trim: an undo needs the whole
 * block or none of it. It reads formulas rather than results, so restoring a
 * cell restores "=SUM(B2:B40)" and not the number that formula happened to
 * produce at the moment it was overwritten.
 */
export async function readSheetGrid(accessToken, spreadsheetId, range) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}?valueRenderOption=FORMULA`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Sheets read failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.values || [];
}

/** Move a spreadsheet to the bin, or take it back out. Undo for create_spreadsheet. */
export async function setFileTrashed(accessToken, fileId, trashed) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: !!trashed }),
    },
  );
  if (!res.ok) throw new Error(`Drive trash failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { id: fileId, trashed: !!trashed };
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

/**
 * In-cell notes — the plain yellow-corner note on a cell.
 *
 * Nothing to do with comments: notes live in the Sheets API as a field on the
 * cell itself, have no author and no thread, and are invisible to the Drive
 * comments endpoints. A sheet can carry both, and they are read and written
 * through entirely different APIs.
 */
const MAX_NOTE_CHARS = 2000;
const MAX_NOTES_RETURNED = 200;

/** 'A' -> 0, 'Z' -> 25, 'AA' -> 26. */
export function colToIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) {
    const v = ch.charCodeAt(0) - 64;
    if (v < 1 || v > 26) throw new Error(`Not a column reference: ${letters}`);
    n = n * 26 + v;
  }
  return n - 1;
}

/** 0 -> 'A', 26 -> 'AA'. */
export function indexToCol(index) {
  let n = Number(index) + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Split "Positions!B12" or "B12" into its parts. Sheet names may be quoted and may contain '!'. */
export function parseA1Cell(ref) {
  const raw = String(ref || '').trim();
  if (!raw) throw new Error('A cell reference is required, e.g. B12 or Positions!B12');
  let sheet = null;
  let cell = raw;
  const bang = raw.lastIndexOf('!');
  if (bang > 0) {
    sheet = raw.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
    cell = raw.slice(bang + 1);
  }
  const m = /^([A-Za-z]+)(\d+)$/.exec(cell.trim());
  if (!m) throw new Error(`Could not read "${ref}" as a single cell. Use a form like B12 or Positions!B12.`);
  return { sheet, col: colToIndex(m[1]), row: Number(m[2]) - 1 };
}

export async function readSheetNotes(accessToken, spreadsheetId, { range, maxResults } = {}) {
  if (!spreadsheetId) throw new Error('spreadsheet_id is required');
  const params = new URLSearchParams({
    fields: 'sheets(properties(title,sheetId),data(startRow,startColumn,rowData(values(note,formattedValue))))',
  });
  if (range) params.append('ranges', range);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (res.status === 404) throw new Error(`No spreadsheet found with id ${spreadsheetId}.`);
  if (!res.ok) throw new Error(`Notes read failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();

  const cap = Math.min(Math.max(Number(maxResults) || 100, 1), MAX_NOTES_RETURNED);
  const notes = [];
  let truncated = false;
  for (const sheet of data.sheets || []) {
    const title = sheet.properties?.title || '';
    for (const grid of sheet.data || []) {
      // startRow/startColumn are omitted rather than sent as 0, so a missing
      // value means the block begins at the top-left of the requested range.
      const baseRow = grid.startRow || 0;
      const baseCol = grid.startColumn || 0;
      (grid.rowData || []).forEach((row, r) => {
        (row.values || []).forEach((cell, c) => {
          if (!cell?.note) return;
          if (notes.length >= cap) { truncated = true; return; }
          notes.push({
            cell: `${title}!${indexToCol(baseCol + c)}${baseRow + r + 1}`,
            note: String(cell.note).slice(0, MAX_NOTE_CHARS),
            value: cell.formattedValue ?? null,
          });
        });
      });
    }
  }
  return { count: notes.length, truncated, notes };
}

export async function setSheetNote(accessToken, spreadsheetId, { cell, note } = {}) {
  if (!spreadsheetId) throw new Error('spreadsheet_id is required');
  const target = parseA1Cell(cell);

  // batchUpdate addresses cells by numeric grid position, not by name, so the
  // sheet has to be resolved to its id first.
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(title,sheetId))`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!metaRes.ok) throw new Error(`Could not open spreadsheet: ${metaRes.status} ${(await metaRes.text()).slice(0, 160)}`);
  const meta = await metaRes.json();
  const sheets = meta.sheets || [];
  const match = target.sheet
    ? sheets.find((s) => (s.properties?.title || '').toLowerCase() === target.sheet.toLowerCase())
    : sheets[0];
  if (!match) {
    const names = sheets.map((s) => s.properties?.title).filter(Boolean).join(', ');
    throw new Error(`No tab named "${target.sheet}" in that spreadsheet. Tabs are: ${names || 'none'}.`);
  }

  const text = String(note ?? '');
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          updateCells: {
            range: {
              sheetId: match.properties.sheetId,
              startRowIndex: target.row,
              endRowIndex: target.row + 1,
              startColumnIndex: target.col,
              endColumnIndex: target.col + 1,
            },
            // Only the note field is in the mask, so the cell's value and
            // formatting are untouched. An empty string clears the note.
            rows: [{ values: [{ note: text.slice(0, MAX_NOTE_CHARS) }] }],
            fields: 'note',
          },
        }],
      }),
    },
  );
  if (!res.ok) throw new Error(`Note write failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const label = `${match.properties.title}!${indexToCol(target.col)}${target.row + 1}`;
  return { cell: label, note: text ? text.slice(0, MAX_NOTE_CHARS) : null, cleared: !text };
}

/**
 * Comments on a Drive file — Sheets, Docs, anything.
 *
 * Comments are not part of the Sheets API. They belong to Drive, because a
 * comment attaches to a file rather than to a cell, which is also why a comment
 * cannot be created against a specific cell through the public API: the anchor
 * format Sheets uses is internal and undocumented. Reading returns whatever
 * anchor an existing comment carries, so a comment made in the UI can still be
 * reported against its cell.
 */
const COMMENT_FIELDS =
  'comments(id,content,author(displayName,me),createdTime,modifiedTime,resolved,' +
  'quotedFileContent(value),anchor,replies(id,content,author(displayName),createdTime,action))';

const MAX_COMMENT_CHARS = 4000;

/** Pull a cell reference out of a Sheets anchor when one is recognisable. */
function anchorCell(anchor) {
  if (!anchor) return null;
  try {
    const parsed = typeof anchor === 'string' ? JSON.parse(anchor) : anchor;
    // Shapes vary by file type and none is contractual, so only obvious
    // range-like values are surfaced and anything else is left alone.
    const range = parsed?.range || parsed?.a?.[0]?.range || parsed?.a?.[0]?.txt?.range;
    return typeof range === 'string' ? range : null;
  } catch {
    return null;
  }
}

function shapeComment(c) {
  return {
    id: c.id,
    author: c.author?.displayName || (c.author?.me ? 'You' : 'Unknown'),
    content: String(c.content || '').slice(0, MAX_COMMENT_CHARS),
    created: c.createdTime,
    modified: c.modifiedTime,
    resolved: !!c.resolved,
    cell: anchorCell(c.anchor),
    quoted: c.quotedFileContent?.value || null,
    replies: (c.replies || []).map((r) => ({
      id: r.id,
      author: r.author?.displayName || 'Unknown',
      content: String(r.content || '').slice(0, MAX_COMMENT_CHARS),
      created: r.createdTime,
      // 'resolve' / 'reopen' arrive as replies with no text of their own.
      action: r.action || null,
    })),
  };
}

export async function listFileComments(accessToken, fileId, { maxResults = 30, includeResolved = false } = {}) {
  if (!fileId) throw new Error('file_id is required');
  const params = new URLSearchParams({
    fields: `nextPageToken,${COMMENT_FIELDS}`,
    pageSize: String(Math.min(Math.max(Number(maxResults) || 30, 1), 100)),
    includeDeleted: 'false',
  });
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/comments?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (res.status === 404) {
    throw new Error(`No file found with id ${fileId}, or this account cannot open it.`);
  }
  if (!res.ok) throw new Error(`Comments list failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const all = (data.comments || []).map(shapeComment);
  const comments = includeResolved ? all : all.filter((c) => !c.resolved);
  return {
    count: comments.length,
    hidden_resolved: includeResolved ? 0 : all.length - comments.length,
    comments,
  };
}

export async function createFileComment(accessToken, fileId, { content, cell } = {}) {
  if (!fileId) throw new Error('file_id is required');
  const text = String(content || '').trim();
  if (!text) throw new Error('comment text is required');
  // The cell goes in the text rather than an anchor. An anchor built from a
  // guessed format would either be rejected or, worse, silently attach the
  // comment to the wrong place — naming the cell is honest and readable.
  const body = { content: cell ? `[${String(cell).trim()}] ${text}` : text };
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/comments?fields=id,content,createdTime`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`Comment create failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const c = await res.json();
  return {
    id: c.id,
    content: c.content,
    created: c.createdTime,
    anchored_to_cell: false,
    note: cell
      ? `Posted as a file-level comment naming ${cell}. Google's API cannot attach a comment to a specific cell; only the Sheets UI can.`
      : undefined,
  };
}

export async function replyToFileComment(accessToken, fileId, commentId, { content, resolve } = {}) {
  if (!fileId) throw new Error('file_id is required');
  if (!commentId) throw new Error('comment_id is required');
  const text = String(content || '').trim();
  // Resolving is itself a reply carrying an action, and Drive rejects a reply
  // with no content at all, so a bare resolve still needs something to say.
  if (!text && !resolve) throw new Error('reply text is required');
  const body = { content: text || 'Resolved.' };
  if (resolve) body.action = 'resolve';
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}/replies?fields=id,content,createdTime,action`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (res.status === 404) {
    throw new Error(`No comment ${commentId} on that file. List comments first to get a valid id.`);
  }
  if (!res.ok) throw new Error(`Reply failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const r = await res.json();
  return { id: r.id, content: r.content, created: r.createdTime, resolved: r.action === 'resolve' };
}

/**
 * Name and type of a Drive file, for the Confirm card of a comment. Best effort: returns null on any failure, because
 * the card also shows the exact stored fields and the file id, and the comment is never posted without the user's Confirm.
 */
export async function getDriveFileInfo(accessToken, fileId) {
  if (!fileId) return null;
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,mimeType&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return null;
    const f = await res.json();
    return { name: String(f.name || '').slice(0, 200), type: String(f.mimeType || '').slice(0, 100) };
  } catch {
    return null;
  }
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

export async function getCalendarEvent(accessToken, eventId) {
  if (!eventId) throw new Error('event_id is required');
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (res.status === 404) throw new Error(`No event found with id ${eventId}. List events first to get a valid id.`);
  if (!res.ok) throw new Error(`Calendar get failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const emailOf = (a) => String((typeof a === 'string' ? a : a?.email) || '').trim();

/** Merge an attendee edit into the event's existing list, matching case-insensitively on address. */
function resolveAttendees(existing, { attendees, addAttendees, removeAttendees }) {
  const current = Array.isArray(existing) ? existing : [];
  if (Array.isArray(attendees)) {
    return attendees.map((a) => ({ email: emailOf(a) })).filter((a) => a.email);
  }
  if (!Array.isArray(addAttendees) && !Array.isArray(removeAttendees)) return undefined;

  const drop = new Set((removeAttendees || []).map((a) => emailOf(a).toLowerCase()).filter(Boolean));
  // Existing entries are kept whole, not rebuilt from the address: they carry
  // each attendee's RSVP status, and replacing them would reset every reply.
  const out = current.filter((a) => !drop.has(emailOf(a).toLowerCase()));
  const have = new Set(out.map((a) => emailOf(a).toLowerCase()));
  for (const a of addAttendees || []) {
    const email = emailOf(a);
    if (!email || have.has(email.toLowerCase())) continue;
    out.push({ email });
    have.add(email.toLowerCase());
  }
  return out;
}

const dayMs = 86_400_000;
const asDate = (v) => String(v || '').slice(0, 10);
const shiftDays = (isoDate, days) =>
  new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * dayMs).toISOString().slice(0, 10);

/**
 * Move or amend an existing event.
 *
 * PATCH, never PUT: the caller supplies only what changed, and a full replace
 * would silently blank every field it left out. Anything not named here is
 * untouched.
 *
 * Times are the subtle part. Shifting only the start of an event would leave
 * the old end behind it, which Google rejects outright, so a start-only move
 * carries the original duration with it — the behaviour someone means by "push
 * the loading window back two days".
 */
export async function updateCalendarEvent(accessToken, eventId, {
  summary,
  description,
  location,
  start,
  end,
  allDay,
  timeZone,
  attendees,
  addAttendees,
  removeAttendees,
  notify,
} = {}) {
  const existing = await getCalendarEvent(accessToken, eventId);
  if (existing.status === 'cancelled') {
    throw new Error('That event is already cancelled and cannot be edited.');
  }

  const wasAllDay = !!existing.start?.date && !existing.start?.dateTime;
  const isAllDay = allDay === undefined ? wasAllDay : !!allDay;
  const body = {};
  const changed = [];

  if (summary !== undefined) { body.summary = String(summary); changed.push('summary'); }
  if (description !== undefined) { body.description = String(description); changed.push('description'); }
  if (location !== undefined) { body.location = String(location); changed.push('location'); }

  const oldStartRaw = existing.start?.dateTime || existing.start?.date || '';
  const oldEndRaw = existing.end?.dateTime || existing.end?.date || '';

  if (start !== undefined || end !== undefined || allDay !== undefined) {
    if (isAllDay) {
      const oldStartDate = asDate(oldStartRaw);
      const oldEndDate = asDate(oldEndRaw) || oldStartDate;
      const newStartDate = start !== undefined ? asDate(start) : oldStartDate;
      let newEndDate;
      if (end !== undefined) {
        newEndDate = asDate(end);
      } else if (start !== undefined && wasAllDay && oldStartDate && oldEndDate) {
        // Carry the span across, so a 3-day window stays 3 days long.
        const span = Math.round(
          (new Date(`${oldEndDate}T00:00:00Z`) - new Date(`${oldStartDate}T00:00:00Z`)) / dayMs,
        );
        newEndDate = shiftDays(newStartDate, Math.max(1, span || 1));
      } else {
        newEndDate = shiftDays(newStartDate, 1);
      }
      // Google treats an all-day end as exclusive, so it must be at least the
      // next day or the event has no length and the API rejects it.
      if (new Date(`${newEndDate}T00:00:00Z`) <= new Date(`${newStartDate}T00:00:00Z`)) {
        newEndDate = shiftDays(newStartDate, 1);
      }
      body.start = { date: newStartDate };
      body.end = { date: newEndDate };
    } else {
      const tz = timeZone || existing.start?.timeZone || 'UTC';
      const oldStart = oldStartRaw ? new Date(wasAllDay ? `${asDate(oldStartRaw)}T00:00:00Z` : oldStartRaw) : null;
      const oldEnd = oldEndRaw ? new Date(wasAllDay ? `${asDate(oldEndRaw)}T00:00:00Z` : oldEndRaw) : null;
      const durationMs =
        oldStart && oldEnd && oldEnd > oldStart ? oldEnd.getTime() - oldStart.getTime() : 60 * 60 * 1000;

      const newStart = start !== undefined ? new Date(start) : oldStart;
      if (!newStart || Number.isNaN(newStart.getTime())) {
        throw new Error(`Could not read "${start}" as a date/time. Use ISO 8601, e.g. 2026-09-01T14:00:00Z.`);
      }
      let newEnd;
      if (end !== undefined) {
        newEnd = new Date(end);
        if (Number.isNaN(newEnd.getTime())) {
          throw new Error(`Could not read "${end}" as a date/time. Use ISO 8601, e.g. 2026-09-01T15:00:00Z.`);
        }
      } else {
        newEnd = new Date(newStart.getTime() + durationMs);
      }
      if (newEnd <= newStart) {
        throw new Error(
          `The end (${newEnd.toISOString()}) is not after the start (${newStart.toISOString()}). ` +
            'Give both times when moving an event across a boundary.',
        );
      }
      body.start = { dateTime: newStart.toISOString(), timeZone: tz };
      body.end = { dateTime: newEnd.toISOString(), timeZone: tz };
    }
    changed.push('time');
  }

  const resolved = resolveAttendees(existing.attendees, { attendees, addAttendees, removeAttendees });
  if (resolved !== undefined) {
    body.attendees = resolved;
    changed.push('attendees');
  }

  if (changed.length === 0) throw new Error('Nothing to update — no fields were provided.');

  // Anyone on the invite is told by default: a moved deadline that reaches
  // nobody is worse than a redundant notification.
  const guestCount = (resolved ?? existing.attendees ?? []).length;
  const sendUpdates = notify === undefined ? (guestCount > 0 ? 'all' : 'none') : notify ? 'all' : 'none';

  const params = new URLSearchParams({ sendUpdates });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?${params}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`Calendar update failed: ${res.status} ${await res.text()}`);
  const ev = await res.json();
  return {
    id: ev.id,
    summary: ev.summary,
    start: ev.start?.dateTime || ev.start?.date,
    end: ev.end?.dateTime || ev.end?.date,
    location: ev.location || '',
    htmlLink: ev.htmlLink,
    status: ev.status,
    changed,
    previous: { start: oldStartRaw, end: oldEndRaw, summary: existing.summary || '' },
    attendees: (ev.attendees || []).map((a) => a.email).filter(Boolean),
    guests_notified: sendUpdates === 'all' && guestCount > 0,
    recurring_instance: !!ev.recurringEventId,
  };
}

/** Cancel an event. Returns cleanly if it was already gone, so a repeat call is not an error. */
export async function deleteCalendarEvent(accessToken, eventId, { notify } = {}) {
  if (!eventId) throw new Error('event_id is required');
  let existing = null;
  try {
    existing = await getCalendarEvent(accessToken, eventId);
  } catch (_) {
    // Fall through: the delete below reports the real outcome.
  }
  const guestCount = (existing?.attendees || []).length;
  const sendUpdates = notify === undefined ? (guestCount > 0 ? 'all' : 'none') : notify ? 'all' : 'none';
  const params = new URLSearchParams({ sendUpdates });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?${params}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
  );
  // 410 means it was already deleted — the caller's intent is satisfied either way.
  if (!res.ok && res.status !== 410) {
    throw new Error(`Calendar delete failed: ${res.status} ${await res.text()}`);
  }
  return {
    deleted: true,
    id: eventId,
    summary: existing?.summary || '',
    start: existing?.start?.dateTime || existing?.start?.date || '',
    already_gone: res.status === 410,
    guests_notified: sendUpdates === 'all' && guestCount > 0,
  };
}

export { readDriveFile } from './driveRead.js';
