import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOAuthState } from '../api/lib/oauthState.js';
import { finishFlow, disconnectFlow } from '../api/lib/oauthFlow.js';
import { openToken, sealToken } from '../api/lib/tokenCrypto.js';
import { makeAdmin } from './helpers/fakeAdmin.mjs';

const T0 = 1_800_000_000_000;
const HOME = 'https://app.example';
const SCOPES = { gmail: ['g'], google_drive: ['d'] };
const KEY = Buffer.alloc(32, 7);
const silent = { error() {} };

function deps(admin, over = {}) {
  const calls = { exchange: 0 };
  return {
    calls,
    args: {
      family: 'google', admin, home: HOME, now: T0 + 1000, log: silent,
      scopesFor: (p) => SCOPES[p],
      exchangeCode: async () => { calls.exchange++; return { access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 3600 }; },
      getEmail: async () => 'user@example.com',
      ...over,
    },
  };
}
const start = (admin, userId = 'u1', provider = 'gmail', family = 'google') => createOAuthState({ admin, userId, provider, family, now: T0 });
const loc = (u) => new URL(u);

test('happy path: tokens are saved for the user bound to the state and success is redirected', async () => {
  const admin = makeAdmin();
  const state = await start(admin);
  const { args } = deps(admin);
  const to = await finishFlow({ ...args, query: { code: 'c', state } });
  assert.equal(to, `${HOME}?connected=gmail`);
  const [row] = admin.tables.connectors;
  assert.equal(row.user_id, 'u1');
  assert.equal(row.provider, 'gmail');
  assert.equal(row.account_email, 'user@example.com');
  assert.equal(row.status, 'connected');
  assert.equal(row.access_token, 'AT-new'); // no key configured here: legacy plaintext mode
  assert.equal(new Date(row.token_expires_at).getTime(), T0 + 1000 + 3_600_000);
});

test('F01/F02: a forged legacy state naming a victim writes nothing and never calls the provider', async () => {
  const admin = makeAdmin();
  const { args, calls } = deps(admin);
  const forged = Buffer.from(JSON.stringify({ userId: 'victim', provider: 'gmail', t: T0 })).toString('base64url');
  const to = await finishFlow({ ...args, query: { code: 'attacker-code', state: forged } });
  assert.equal(loc(to).searchParams.get('connector_error'), 'invalid_state');
  assert.equal(calls.exchange, 0);
  assert.equal(admin.tables.connectors.length, 0);
});

test('F02: identity comes from the row, an attacker cannot redirect tokens to another user', async () => {
  const admin = makeAdmin();
  const attackerState = await start(admin, 'attacker');
  const { args } = deps(admin);
  await finishFlow({ ...args, query: { code: 'c', state: attackerState, userId: 'victim', user_id: 'victim', provider: 'google_drive' } });
  assert.deepEqual(admin.tables.connectors.map((r) => [r.user_id, r.provider]), [['attacker', 'gmail']]);
});

test('replay of a used state is rejected and writes nothing more', async () => {
  const admin = makeAdmin();
  const state = await start(admin);
  const { args, calls } = deps(admin);
  await finishFlow({ ...args, query: { code: 'c', state } });
  const to = await finishFlow({ ...args, query: { code: 'c2', state } });
  assert.equal(loc(to).searchParams.get('connector_error'), 'invalid_state');
  assert.equal(calls.exchange, 1);
  assert.equal(admin.tables.connectors.length, 1);
});

test('expired state is rejected before any token exchange', async () => {
  const admin = makeAdmin();
  const state = await start(admin);
  const { args, calls } = deps(admin, { now: T0 + 11 * 60_000 });
  const to = await finishFlow({ ...args, query: { code: 'c', state } });
  assert.equal(loc(to).searchParams.get('connector_error'), 'invalid_state');
  assert.equal(calls.exchange, 0);
});

test('a Microsoft-family state is refused by the Google callback', async () => {
  const admin = makeAdmin();
  const state = await start(admin, 'u1', 'gmail', 'microsoft');
  const { args, calls } = deps(admin);
  const to = await finishFlow({ ...args, query: { code: 'c', state } });
  assert.equal(loc(to).searchParams.get('connector_error'), 'invalid_state');
  assert.equal(calls.exchange, 0);
});

test('provider error and missing parameters are handled without leaking raw input', async () => {
  const admin = makeAdmin();
  const { args } = deps(admin);
  const e = await finishFlow({ ...args, query: { error: 'access_denied"><script>x' } });
  assert.equal(loc(e).searchParams.get('connector_error'), 'access_deniedscriptx');
  assert.equal(loc(await finishFlow({ ...args, query: { state: 'x' } })).searchParams.get('connector_error'), 'missing_code');
  assert.equal(loc(await finishFlow({ ...args, query: { code: 'x' } })).searchParams.get('connector_error'), 'missing_code');
});

test('exchange failure reports a fixed code (no provider message) and burns the state', async () => {
  const admin = makeAdmin();
  const state = await start(admin);
  const { args } = deps(admin, { exchangeCode: async () => { throw new Error('secret detail from provider'); } });
  const to = await finishFlow({ ...args, query: { code: 'c', state } });
  assert.equal(loc(to).searchParams.get('connector_error'), 'exchange_failed');
  assert.ok(!to.includes('secret'));
  assert.equal(admin.tables.connectors.length, 0);
  const retry = await finishFlow({ ...deps(admin).args, query: { code: 'c', state } });
  assert.equal(loc(retry).searchParams.get('connector_error'), 'invalid_state');
});

test('F06: a failed write is never reported as success', async () => {
  const admin = makeAdmin({ fail: { 'connectors.upsert': true } });
  const state = await start(admin);
  const { args } = deps(admin);
  const to = await finishFlow({ ...args, query: { code: 'c', state } });
  assert.equal(loc(to).searchParams.get('connector_error'), 'save_failed');
  assert.equal(loc(to).searchParams.get('connected'), null);
});

test('F06: a failed read of the existing connector also fails closed', async () => {
  const admin = makeAdmin({ fail: { 'connectors.select': true } });
  const state = await start(admin);
  const to = await finishFlow({ ...deps(admin).args, query: { code: 'c', state } });
  assert.equal(loc(to).searchParams.get('connector_error'), 'save_failed');
});

async function reconnect({ existingEmail, newEmail, newRefresh }) {
  const admin = makeAdmin();
  admin.tables.connectors.push({ id: 'c1', user_id: 'u1', provider: 'gmail', account_email: existingEmail, access_token: 'AT-old', refresh_token: 'RT-old' });
  const state = await start(admin);
  const { args } = deps(admin, {
    getEmail: async () => newEmail,
    exchangeCode: async () => ({ access_token: 'AT-new', refresh_token: newRefresh, expires_in: 60 }),
  });
  await finishFlow({ ...args, query: { code: 'c', state } });
  return admin.tables.connectors[0];
}

test('F05: old refresh token is kept only when the same Google account reconnects', async () => {
  assert.equal((await reconnect({ existingEmail: 'a@x.com', newEmail: 'A@X.com', newRefresh: undefined })).refresh_token, 'RT-old');
  assert.equal((await reconnect({ existingEmail: 'a@x.com', newEmail: 'other@x.com', newRefresh: undefined })).refresh_token, null);
  assert.equal((await reconnect({ existingEmail: 'a@x.com', newEmail: null, newRefresh: undefined })).refresh_token, null);
  assert.equal((await reconnect({ existingEmail: null, newEmail: 'a@x.com', newRefresh: undefined })).refresh_token, null);
});

test('F05: a refresh token returned by the provider always replaces the old one', async () => {
  assert.equal((await reconnect({ existingEmail: 'a@x.com', newEmail: 'other@x.com', newRefresh: 'RT-fresh' })).refresh_token, 'RT-fresh');
});

test('F03: with a key configured, stored tokens are encrypted and bound to the row', async () => {
  process.env.CONNECTOR_TOKEN_KEY = KEY.toString('base64');
  try {
    const admin = makeAdmin();
    const state = await start(admin);
    await finishFlow({ ...deps(admin).args, query: { code: 'c', state } });
    const [row] = admin.tables.connectors;
    assert.match(row.access_token, /^enc:v1:/);
    assert.match(row.refresh_token, /^enc:v1:/);
    assert.ok(!JSON.stringify(row).includes('AT-new') && !JSON.stringify(row).includes('RT-new'));
    assert.equal(openToken(row.access_token, { userId: 'u1', provider: 'gmail', column: 'access_token' }), 'AT-new');
    assert.throws(() => openToken(row.access_token, { userId: 'u2', provider: 'gmail', column: 'access_token' }), /token_auth_failed/);
  } finally { delete process.env.CONNECTOR_TOKEN_KEY; }
});

test('a malformed encryption key fails closed instead of silently storing plaintext', async () => {
  process.env.CONNECTOR_TOKEN_KEY = 'not-32-bytes';
  try {
    const admin = makeAdmin();
    const state = await start(admin);
    const to = await finishFlow({ ...deps(admin).args, query: { code: 'c', state } });
    assert.equal(loc(to).searchParams.get('connector_error'), 'token_key_invalid');
    assert.equal(admin.tables.connectors.length, 0);
  } finally { delete process.env.CONNECTOR_TOKEN_KEY; }
});

test('callbacks no longer decode identity from the URL state', () => {
  for (const f of ['google-callback.js', 'microsoft-callback.js']) {
    const src = readFileSync(new URL(`../api/connectors/${f}`, import.meta.url), 'utf8');
    assert.ok(!/JSON\.parse\(\s*Buffer\.from/.test(src), `${f} must not parse state as base64 JSON`);
    assert.ok(!/userId\s*[,}]\s*=\s*state|const\s*\{\s*userId/.test(src), `${f} must not read userId from state`);
  }
  for (const f of ['google-start.js', 'microsoft-start.js']) {
    const src = readFileSync(new URL(`../api/connectors/${f}`, import.meta.url), 'utf8');
    assert.ok(!/base64url/.test(src), `${f} must not build a client-decodable state`);
  }
});

// ---- disconnect (F07)
function seed(admin, rows) { rows.forEach((r, i) => admin.tables.connectors.push({ id: `c${i}`, ...r })); }
const dflow = (admin, over = {}) => {
  const revoked = [];
  return {
    revoked,
    run: (provider, userId = 'u1') => disconnectFlow({
      admin, userId, provider,
      familyOf: (p) => (['gmail', 'google_drive'].includes(p) ? 'google' : p === 'outlook' ? 'microsoft' : null),
      googleProviders: ['gmail', 'google_drive'],
      revokeGoogle: async (t) => { revoked.push(t); return true; },
      openToken,
      ...over,
    }),
  };
};

test('F07: disconnecting the last Google connector of an account revokes its refresh token', async () => {
  const admin = makeAdmin();
  seed(admin, [{ user_id: 'u1', provider: 'gmail', account_email: 'a@x.com', access_token: 'AT', refresh_token: 'RT' }]);
  const d = dflow(admin);
  const out = await d.run('gmail');
  assert.deepEqual(out, { status: 200, body: { ok: true, revoked: 'revoked' } });
  assert.deepEqual(d.revoked, ['RT']);
  assert.equal(admin.tables.connectors.length, 0);
});

test('F07: encrypted tokens are decrypted in memory for revocation', async () => {
  process.env.CONNECTOR_TOKEN_KEY = KEY.toString('base64');
  try {
    const admin = makeAdmin();
    seed(admin, [{ user_id: 'u1', provider: 'gmail', account_email: 'a@x.com',
      access_token: sealToken('AT', { userId: 'u1', provider: 'gmail', column: 'access_token' }),
      refresh_token: sealToken('RT-secret', { userId: 'u1', provider: 'gmail', column: 'refresh_token' }) }]);
    const d = dflow(admin);
    await d.run('gmail');
    assert.deepEqual(d.revoked, ['RT-secret']);
  } finally { delete process.env.CONNECTOR_TOKEN_KEY; }
});

test('F07: a Google grant shared with another connector of the same account is not revoked', async () => {
  const admin = makeAdmin();
  seed(admin, [
    { user_id: 'u1', provider: 'gmail', account_email: 'a@x.com', access_token: 'AT1', refresh_token: 'RT1' },
    { user_id: 'u1', provider: 'google_drive', account_email: 'a@x.com', access_token: 'AT2', refresh_token: 'RT2' },
  ]);
  const d = dflow(admin);
  const out = await d.run('gmail');
  assert.equal(out.body.revoked, 'skipped_shared_grant');
  assert.deepEqual(d.revoked, []);
  assert.deepEqual(admin.tables.connectors.map((r) => r.provider), ['google_drive']);
});

test('F07: only the caller\'s own row is touched; unknown providers are rejected', async () => {
  const admin = makeAdmin();
  seed(admin, [
    { user_id: 'u1', provider: 'gmail', account_email: 'a@x.com', access_token: 'A', refresh_token: 'R' },
    { user_id: 'u2', provider: 'gmail', account_email: 'b@x.com', access_token: 'A2', refresh_token: 'R2' },
  ]);
  const d = dflow(admin);
  assert.equal((await d.run('bogus')).status, 400);
  await d.run('gmail', 'u1');
  assert.deepEqual(admin.tables.connectors.map((r) => r.user_id), ['u2']);
  assert.deepEqual(d.revoked, ['R']);
});

test('F07: local delete failure stops before revoking; revoke failure never blocks the disconnect', async () => {
  const a1 = makeAdmin({ fail: { 'connectors.delete': true } });
  seed(a1, [{ user_id: 'u1', provider: 'gmail', account_email: 'a@x.com', access_token: 'A', refresh_token: 'R' }]);
  const d1 = dflow(a1);
  assert.equal((await d1.run('gmail')).status, 500);
  assert.deepEqual(d1.revoked, []);

  const a2 = makeAdmin();
  seed(a2, [{ user_id: 'u1', provider: 'gmail', account_email: 'a@x.com', access_token: 'A', refresh_token: 'R' }]);
  const d2 = dflow(a2, { revokeGoogle: async () => { throw new Error('network'); } });
  assert.deepEqual(await d2.run('gmail'), { status: 200, body: { ok: true, revoked: 'failed' } });
  assert.equal(a2.tables.connectors.length, 0);
});

test('F07: Microsoft has no token revocation endpoint: disconnect says so explicitly', async () => {
  const admin = makeAdmin();
  seed(admin, [{ user_id: 'u1', provider: 'outlook', account_email: 'a@x.com', access_token: 'A', refresh_token: 'R' }]);
  const d = dflow(admin);
  assert.equal((await d.run('outlook')).body.revoked, 'unsupported_provider');
  assert.deepEqual(d.revoked, []);
});

test('disconnecting a connector that does not exist is a no-op success', async () => {
  const d = dflow(makeAdmin());
  assert.deepEqual(await d.run('gmail'), { status: 200, body: { ok: true, revoked: 'none' } });
});
