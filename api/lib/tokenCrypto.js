// Application-layer encryption for connector tokens (F03).
// AES-256-GCM, versioned envelope "enc:v1:<base64url(iv|tag|ciphertext)>", with the
// row identity (user, provider, column) bound as AAD so a ciphertext cannot be
// moved to another row or column. Enabled by CONNECTOR_TOKEN_KEY (32 random bytes,
// base64). Without a key values stay plaintext (legacy mode); legacy plaintext is
// always readable so rollout and rollback are gradual.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Returns a 32-byte Buffer, null if unset. A set-but-malformed key throws (fail closed). */
export function getTokenKey(env = process.env) {
  const raw = env.CONNECTOR_TOKEN_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('CONNECTOR_TOKEN_KEY must be 32 bytes, base64-encoded');
  return key;
}

const aad = (ctx) => Buffer.from(`${ctx.userId}|${ctx.provider}|${ctx.column}`, 'utf8');

export function sealToken(plain, ctx, key = getTokenKey()) {
  if (plain == null || plain === '') return plain ?? null;
  if (isEncrypted(plain)) return plain;
  if (!key) return plain; // legacy mode
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(ctx));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

export function openToken(value, ctx, key = getTokenKey()) {
  if (value == null || value === '') return value ?? null;
  if (!isEncrypted(value)) return value; // legacy plaintext
  if (!key) throw new Error('token_key_missing');
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64url');
  if (buf.length < 12 + 16 + 1) throw new Error('token_malformed');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAAD(aad(ctx));
  decipher.setAuthTag(buf.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('token_auth_failed');
  }
}
