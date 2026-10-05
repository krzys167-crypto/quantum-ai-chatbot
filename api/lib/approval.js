// Server-side approval for irreversible actions (audit finding F09).
//
// Problem: `user_confirmed` is an argument the MODEL supplies, so checking it proves nothing about the user.
// Here the approval is a token the SERVER signs after an authenticated user action (POST /api/approve-action);
// the model cannot produce one. A token is bound to: the user, the action name, a digest of the exact arguments
// (recipient, subject, body, ...), an expiry and a random nonce. Changing any argument invalidates it.
//
// Honest limits
// - Stateless: a token can be replayed for the SAME user, action and arguments until it expires (default 120 s).
//   Single use needs a nonce store (e.g. a Supabase table); the nonce is already in the token for that.
// - Nothing here makes the UI show the confirmation. Until the front end calls /api/approve-action after the
//   user clicked Confirm on the exact content, the guard in claudeTools.js stays in legacy mode.
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const DEFAULT_TTL_MS = 120_000;
const MAX_TTL_MS = 600_000;

// The arguments that define "what the user approved", per action. Anything else the model adds is ignored
// for the digest, so it can neither be smuggled in after approval nor invalidate it.
const FIELDS = {
  send_email: ['to', 'cc', 'bcc', 'subject', 'body'],
  reply_email: ['message_id', 'reply_all', 'cc', 'bcc', 'body'],
  forward_email: ['message_id', 'to', 'cc', 'bcc', 'body'],
};

export const APPROVABLE_ACTIONS = Object.keys(FIELDS);

function canonical(action, args) {
  const fields = FIELDS[action];
  if (!fields) throw new Error(`action is not approvable: ${String(action)}`);
  const a = args && typeof args === 'object' ? args : {};
  const out = {};
  for (const f of fields) {
    out[f] = f === 'reply_all' ? a[f] === true : String(a[f] ?? '');
  }
  return JSON.stringify(out);
}

export function digestArgs(action, args) {
  return createHash('sha256').update(canonical(action, args)).digest('hex');
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(secret, payloadB64) {
  return createHmac('sha256', secret).update(`${VERSION}.${payloadB64}`).digest();
}

export function approvalSecretProblem(secret) {
  if (typeof secret !== 'string' || secret.length < 32) return 'APPROVAL_SECRET must be set to a random string of at least 32 characters';
  return null;
}

export function createApproval({ secret, userId, action, args, ttlMs = DEFAULT_TTL_MS, now = Date.now() }) {
  const problem = approvalSecretProblem(secret);
  if (problem) throw new Error(problem);
  if (typeof userId !== 'string' || !userId) throw new Error('userId is required');
  if (!(ttlMs > 0 && ttlMs <= MAX_TTL_MS)) throw new Error('ttlMs out of range');
  const payload = { uid: userId, act: action, dig: digestArgs(action, args), exp: now + ttlMs, nonce: randomBytes(12).toString('hex') };
  const payloadB64 = b64u(JSON.stringify(payload));
  return {
    token: `${VERSION}.${payloadB64}.${b64u(sign(secret, payloadB64))}`,
    expires_at: payload.exp,
    digest: payload.dig,
    nonce: payload.nonce,
  };
}

export function verifyApproval({ secret, token, userId, action, args, now = Date.now() }) {
  const problem = approvalSecretProblem(secret);
  if (problem) return { ok: false, reason: 'approval is not configured on the server' };
  if (typeof token !== 'string') return { ok: false, reason: 'approval_token is required' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed approval token' };
  let given;
  try {
    given = Buffer.from(parts[2], 'base64url');
  } catch {
    return { ok: false, reason: 'malformed approval token' };
  }
  const expected = sign(secret, parts[1]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'approval signature is invalid' };
  let p;
  try {
    p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed approval token' };
  }
  if (!p || typeof p !== 'object') return { ok: false, reason: 'malformed approval token' };
  if (typeof userId !== 'string' || !userId || p.uid !== userId) return { ok: false, reason: 'approval belongs to another user' };
  if (p.act !== action) return { ok: false, reason: 'approval is for another action' };
  if (typeof p.exp !== 'number' || now > p.exp) return { ok: false, reason: 'approval expired' };
  let digest;
  try {
    digest = digestArgs(action, args);
  } catch {
    return { ok: false, reason: 'action is not approvable' };
  }
  if (p.dig !== digest) return { ok: false, reason: 'the content differs from what was approved' };
  return { ok: true, nonce: p.nonce, expires_at: p.exp };
}
