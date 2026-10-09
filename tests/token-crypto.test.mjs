import test from 'node:test';
import assert from 'node:assert/strict';
import { sealToken, openToken, getTokenKey, isEncrypted } from '../api/lib/tokenCrypto.js';

const KEY = Buffer.alloc(32, 9);
const ctx = { userId: 'u1', provider: 'gmail', column: 'refresh_token' };

test('round trip; ciphertext differs every time and hides the plaintext', () => {
  const a = sealToken('RT-secret', ctx, KEY);
  const b = sealToken('RT-secret', ctx, KEY);
  assert.ok(isEncrypted(a));
  assert.notEqual(a, b);
  assert.ok(!a.includes('RT-secret'));
  assert.equal(openToken(a, ctx, KEY), 'RT-secret');
});

test('ciphertext is bound to user, provider and column (cannot be moved between rows)', () => {
  const sealed = sealToken('RT', ctx, KEY);
  for (const other of [{ ...ctx, userId: 'u2' }, { ...ctx, provider: 'google_drive' }, { ...ctx, column: 'access_token' }]) {
    assert.throws(() => openToken(sealed, other, KEY), /token_auth_failed/);
  }
});

test('tampering, truncation and a wrong key are detected', () => {
  const sealed = sealToken('RT', ctx, KEY);
  const flipped = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
  assert.throws(() => openToken(flipped, ctx, KEY), /token_auth_failed|token_malformed/);
  assert.throws(() => openToken('enc:v1:AAAA', ctx, KEY), /token_malformed/);
  assert.throws(() => openToken(sealed, ctx, Buffer.alloc(32, 1)), /token_auth_failed/);
});

test('legacy plaintext stays readable; empty values pass through; sealing is idempotent', () => {
  assert.equal(openToken('plain', ctx, KEY), 'plain');
  assert.equal(openToken('plain', ctx, null), 'plain');
  assert.equal(sealToken(null, ctx, KEY), null);
  assert.equal(openToken(null, ctx, KEY), null);
  const sealed = sealToken('RT', ctx, KEY);
  assert.equal(sealToken(sealed, ctx, KEY), sealed);
});

test('without a key new values stay plaintext (legacy mode) but encrypted values cannot be read', () => {
  assert.equal(sealToken('RT', ctx, null), 'RT');
  const sealed = sealToken('RT', ctx, KEY);
  assert.throws(() => openToken(sealed, ctx, null), /token_key_missing/);
});

test('key parsing: unset is legacy mode, wrong length is an error', () => {
  assert.equal(getTokenKey({}), null);
  assert.equal(getTokenKey({ CONNECTOR_TOKEN_KEY: KEY.toString('base64') }).length, 32);
  assert.throws(() => getTokenKey({ CONNECTOR_TOKEN_KEY: Buffer.alloc(16).toString('base64') }), /32 bytes/);
});

// ---- review follow-ups: lazy key, rollback switch, required key
import { assertTokenConfig, sealingDisabled } from '../api/lib/tokenCrypto.js';
const withEnv = (env, fn) => {
  const old = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};
const CTX2 = { userId: 'u1', provider: 'gmail', column: 'access_token' };
const GOOD = Buffer.alloc(32, 9).toString('base64');

test('a malformed key never breaks reading legacy plaintext rows (key is resolved lazily)', () => {
  withEnv({ CONNECTOR_TOKEN_KEY: 'garbage' }, () => {
    assert.equal(openToken('plain-token', CTX2), 'plain-token');
    assert.equal(openToken(null, CTX2), null);
    assert.equal(sealToken(null, CTX2), null);
    assert.throws(() => sealToken('x', CTX2), /32 bytes/);
    assert.throws(() => openToken('enc:v1:AAAA', CTX2), /32 bytes/);
  });
});

test('CONNECTOR_TOKEN_SEAL=off stops writing sealed values but still reads them (rollback step)', () => {
  const sealed = withEnv({ CONNECTOR_TOKEN_KEY: GOOD }, () => sealToken('AT', CTX2));
  assert.match(sealed, /^enc:v1:/);
  withEnv({ CONNECTOR_TOKEN_KEY: GOOD, CONNECTOR_TOKEN_SEAL: 'off' }, () => {
    assert.equal(sealingDisabled(), true);
    assert.equal(sealToken('AT-2', CTX2), 'AT-2', 'new values stay plaintext');
    assert.equal(openToken(sealed, CTX2), 'AT', 'existing sealed values stay readable');
    assert.equal(assertTokenConfig().sealing, false);
  });
  withEnv({ CONNECTOR_TOKEN_KEY: GOOD }, () => assert.equal(sealingDisabled(), false));
  for (const v of ['0', 'false', 'No', 'OFF']) withEnv({ CONNECTOR_TOKEN_SEAL: v }, () => assert.equal(sealingDisabled(), true, v));
  for (const v of ['', 'on', '1', 'yes', undefined]) withEnv({ CONNECTOR_TOKEN_SEAL: v ?? '' }, () => assert.equal(sealingDisabled(), false, String(v)));
});

test('explicitly passing a key always seals (migration script), whatever the runtime switch says', () => {
  withEnv({ CONNECTOR_TOKEN_SEAL: 'off' }, () => {
    assert.match(sealToken('AT', CTX2, Buffer.alloc(32, 9)), /^enc:v1:/);
  });
});

test('CONNECTOR_TOKEN_REQUIRE_KEY=1: a missing key is an error instead of silent plaintext', () => {
  withEnv({ CONNECTOR_TOKEN_REQUIRE_KEY: '1' }, () => {
    assert.throws(() => assertTokenConfig(), /token_key_required/);
    assert.throws(() => sealToken('AT', CTX2), /token_key_required/);
    assert.equal(openToken('legacy', CTX2), 'legacy', 'reading legacy rows still works');
  });
  withEnv({ CONNECTOR_TOKEN_REQUIRE_KEY: '1', CONNECTOR_TOKEN_KEY: GOOD }, () => {
    assert.deepEqual(assertTokenConfig(), { sealing: true });
  });
  assert.deepEqual(assertTokenConfig({}), { sealing: false }, 'default stays legacy-compatible');
});
