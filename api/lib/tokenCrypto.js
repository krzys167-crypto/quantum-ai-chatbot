// Application-layer encryption for connector tokens (F03).
// AES-256-GCM, versioned envelope "enc:v1:<base64url(iv|tag|ciphertext)>", with the
// row identity (user, provider, column) bound as AAD so a ciphertext cannot be
// moved to another row or column. Enabled by CONNECTOR_TOKEN_KEY (32 random bytes,
// base64). Without a key values stay plaintext (legacy mode); legacy plaintext is
// always readable so rollout and rollback are gradual.
//
// Switches (all optional):
//   CONNECTOR_TOKEN_SEAL=off          stop WRITING sealed values (reads still work). First step of a
//                                     rollback: it lets `unseal` converge while the new code is live.
//   CONNECTOR_TOKEN_REQUIRE_KEY=1     refuse to start a connect flow / store a token without a valid
//                                     key, so a variable missing in one environment cannot silently
//                                     produce plaintext rows.
// The key is resolved lazily: a malformed key never affects reading plaintext rows.
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

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const falsy = (v) => /^(0|off|false|no)$/i.test(String(v ?? '').trim());

/** True when new values must NOT be sealed (rollback step). */
export function sealingDisabled(env = process.env) {
  return falsy(env.CONNECTOR_TOKEN_SEAL);
}

/**
 * Validate the configuration before any user consent is spent. Throws
 * `token_key_required` / the malformed-key error; otherwise reports whether new
 * tokens will be sealed.
 */
export function assertTokenConfig(env = process.env) {
  const key = getTokenKey(env);
  if (!key && truthy(env.CONNECTOR_TOKEN_REQUIRE_KEY) && !sealingDisabled(env)) throw new Error('token_key_required');
  return { sealing: !!key && !sealingDisabled(env) };
}

const aad = (ctx) => Buffer.from(`${ctx.userId}|${ctx.provider}|${ctx.column}`, 'utf8');

/** `key` omitted => runtime behaviour driven by the environment; passed explicitly (migration, tests) => always seals. */
export function sealToken(plain, ctx, key) {
  if (plain == null || plain === '') return plain ?? null;
  if (isEncrypted(plain)) return plain;
  if (key === undefined) {
    if (sealingDisabled()) return plain; // rollback step: write plaintext, keep reading sealed
    key = getTokenKey();
    if (!key && truthy(process.env.CONNECTOR_TOKEN_REQUIRE_KEY)) throw new Error('token_key_required');
  }
  if (!key) return plain; // legacy mode
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(ctx));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

export function openToken(value, ctx, key) {
  if (value == null || value === '') return value ?? null;
  if (!isEncrypted(value)) return value; // legacy plaintext: never needs (or validates) the key
  if (key === undefined) key = getTokenKey();
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
