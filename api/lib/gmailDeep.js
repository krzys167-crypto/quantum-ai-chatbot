/** Deeper Gmail helpers: reply, forward, labels, bulk modify */
import { headerValue } from './mimeHeaders.js';
import { isPlainAddress } from './approvals.js';

function decodeB64(data) {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
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

function getHeader(headers, name) {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

/** Parse email address from "Name <email@x.com>" or bare email. */
function extractEmail(fromHeader) {
  if (!fromHeader) return '';
  const m = fromHeader.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  if (fromHeader.includes('@')) return fromHeader.trim();
  return '';
}

function encodeRawMime({ to, subject, body, cc, bcc, from, inReplyTo, references }) {
  const headers = [
    from ? `From: ${headerValue(from)}` : null,
    `To: ${headerValue(to)}`,
    cc ? `Cc: ${headerValue(cc)}` : null,
    bcc ? `Bcc: ${headerValue(bcc)}` : null,
    `Subject: ${headerValue(subject)}`,
    inReplyTo ? `In-Reply-To: ${headerValue(inReplyTo)}` : null,
    references ? `References: ${headerValue(references)}` : null,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter(Boolean);
  const raw = `${headers.join('\r\n')}\r\n\r\n${body || ''}`;
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function getGmailMessage(accessToken, messageId) {
  if (!messageId) throw new Error('messageId is required');
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Gmail get message failed: ${res.status} ${await res.text()}`);
  const msg = await res.json();
  const headers = msg.payload?.headers || [];
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds || [],
    snippet: msg.snippet || '',
    subject: getHeader(headers, 'Subject'),
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc'),
    date: getHeader(headers, 'Date'),
    messageIdHeader: getHeader(headers, 'Message-ID') || getHeader(headers, 'Message-Id'),
    references: getHeader(headers, 'References'),
    body: extractBody(msg.payload),
  };
}

/**
 * Who a reply goes to, from the received message: the single sender address plus, for reply-all, everyone on its
 * To / Cc lines. Used both for the Confirm card and for the send, so the card shows exactly the recipients that get it.
 * Throws when the From header does not yield exactly one plain address (a header such as "a@x.com, b@y.com").
 */
export function replyRecipients(orig, { replyAll = false, cc } = {}) {
  const to = extractEmail(orig.from);
  if (!isPlainAddress(to)) throw new Error('Could not determine a single reply recipient from the original From header');
  const list = cc ? String(cc).split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (replyAll) {
    for (const part of `${orig.to || ''},${orig.cc || ''}`.split(',')) {
      const e = extractEmail(part.trim());
      if (e && isPlainAddress(e) && e.toLowerCase() !== to.toLowerCase()) list.push(e);
    }
  }
  const seen = new Set();
  const unique = list.filter((a) => (seen.has(a.toLowerCase()) ? false : seen.add(a.toLowerCase())));
  return { to, cc: unique.join(', ') };
}

export async function replyGmail(accessToken, { messageId, body, replyAll, cc, bcc }) {
  if (!messageId) throw new Error('messageId is required');
  if (!body) throw new Error('body is required');
  const orig = await getGmailMessage(accessToken, messageId);
  const { to, cc: ccFinal } = replyRecipients(orig, { replyAll: !!replyAll, cc });

  let subject = orig.subject || '';
  if (!/^re:\s/i.test(subject)) subject = `Re: ${subject}`;

  const inReplyTo = orig.messageIdHeader || undefined;
  const references = [orig.references, orig.messageIdHeader].filter(Boolean).join(' ').trim() || undefined;

  const raw = encodeRawMime({
    to,
    subject,
    body: String(body),
    cc: ccFinal || undefined,
    bcc: bcc ? String(bcc) : undefined,
    inReplyTo,
    references,
  });

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, threadId: orig.threadId }),
  });
  if (!res.ok) throw new Error(`Gmail reply failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    id: data.id,
    threadId: data.threadId,
    repliedTo: messageId,
    to,
    subject,
  };
}

export async function forwardGmail(accessToken, { messageId, to, body, cc, bcc }) {
  if (!messageId) throw new Error('messageId is required');
  if (!to) throw new Error('to is required');
  const orig = await getGmailMessage(accessToken, messageId);
  let subject = orig.subject || '';
  if (!/^fwd:\s/i.test(subject) && !/^fw:\s/i.test(subject)) subject = `Fwd: ${subject}`;

  const quoted = [
    body ? String(body).trim() : '',
    '',
    '---------- Forwarded message ----------',
    `From: ${orig.from}`,
    `Date: ${orig.date}`,
    `Subject: ${orig.subject}`,
    `To: ${orig.to}`,
    '',
    orig.body || orig.snippet || '',
  ]
    .filter((line, i, arr) => !(i === 0 && !line))
    .join('\n');

  const raw = encodeRawMime({
    to: String(to),
    subject,
    body: quoted,
    cc: cc ? String(cc) : undefined,
    bcc: bcc ? String(bcc) : undefined,
  });

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail forward failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: data.id, threadId: data.threadId, forwardedFrom: messageId, to: String(to), subject };
}

export async function listGmailLabels(accessToken) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail labels failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.labels || []).map((l) => ({
    id: l.id,
    name: l.name,
    type: l.type,
    messagesTotal: l.messagesTotal,
    messagesUnread: l.messagesUnread,
  }));
}

export async function batchModifyGmail(accessToken, messageIds, { addLabelIds = [], removeLabelIds = [] } = {}) {
  const ids = (messageIds || []).map(String).filter(Boolean).slice(0, 50);
  if (!ids.length) throw new Error('message_ids required (max 50)');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, addLabelIds, removeLabelIds }),
  });
  if (!res.ok) throw new Error(`Gmail batchModify failed: ${res.status} ${await res.text()}`);
  // batchModify returns empty 204
  return { ok: true, count: ids.length, addLabelIds, removeLabelIds };
}
