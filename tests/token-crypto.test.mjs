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
