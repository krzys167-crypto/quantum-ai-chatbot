import test from 'node:test';
import assert from 'node:assert/strict';
import { getValidConnectorToken } from '../api/lib/connectorTokens.js';
import { makeAdmin } from './helpers/fakeAdmin.mjs';

const NOW = 1_800_000_000_000;
const quiet = { error() {} };
function setup(row, over = {}) {
  const admin = makeAdmin(over.admin);
  admin.tables.connectors.push({ id: 'c1', user_id: 'u1', provider: 'gmail', status: 'connected',
    access_token: 'AT-old', refresh_token: 'RT-old', token_expires_at: new Date(NOW - 1000).toISOString(), ...row });
  return admin;
}
const get = (admin, refresh) => getValidConnectorToken({ admin, userId: 'u1', provider: 'gmail', refresh, now: NOW, log: quiet });

test('a token valid for more than a minute is returned without refreshing', async () => {
  const admin = setup({ token_expires_at: new Date(NOW + 120_000).toISOString() });
  let called = false;
  assert.equal(await get(admin, async () => { called = true; }), 'AT-old');
  assert.equal(called, false);
});

test('expired token is refreshed and stored', async () => {
  const admin = setup({});
  const t = await get(admin, async (rt) => { assert.equal(rt, 'RT-old'); return { access_token: 'AT-new', expires_in: 3600 }; });
  assert.equal(t, 'AT-new');
  const row = admin.tables.connectors[0];
  assert.equal(row.access_token, 'AT-new');
  assert.equal(row.refresh_token, 'RT-old', 'refresh token untouched when the provider does not rotate it');
  assert.equal(new Date(row.token_expires_at).getTime(), NOW + 3_600_000);
});

test('rotated refresh tokens (Microsoft) are persisted', async () => {
  const admin = setup({});
  await get(admin, async () => ({ access_token: 'AT-new', refresh_token: 'RT-rotated', expires_in: 60 }));
  assert.equal(admin.tables.connectors[0].refresh_token, 'RT-rotated');
});

test('a revoked grant marks the connector and returns null instead of failing every call', async () => {
  const admin = setup({});
  const t = await get(admin, async () => { throw Object.assign(new Error('revoked'), { oauthError: 'invalid_grant' }); });
  assert.equal(t, null);
  assert.equal(admin.tables.connectors[0].status, 'revoked');
  assert.equal(await get(admin, async () => 'unused'), null, 'revoked connector is no longer served');
});

test('other refresh errors propagate and do not change the connector', async () => {
  const admin = setup({});
  await assert.rejects(get(admin, async () => { throw new Error('network down'); }), /network down/);
  assert.equal(admin.tables.connectors[0].status, 'connected');
});

test('no refresh token or refresh not configured: the stored access token is returned', async () => {
  assert.equal(await get(setup({ refresh_token: null }), async () => { throw new Error('no'); }), 'AT-old');
  assert.equal(await get(setup({}), null), 'AT-old');
});

test('unknown or disconnected connector yields null', async () => {
  assert.equal(await get(setup({ status: 'error' }), async () => ({})), null);
  assert.equal(await get(makeAdmin(), async () => ({})), null);
});

test('a failed write after refresh still returns the fresh token for this call', async () => {
  const admin = setup({}, { admin: { fail: { 'connectors.update': true } } });
  assert.equal(await get(admin, async () => ({ access_token: 'AT-new', expires_in: 60 })), 'AT-new');
});
