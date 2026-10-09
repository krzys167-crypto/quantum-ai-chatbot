import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteTokens } from '../api/lib/tokenMigration.js';
import { openToken, sealToken, isEncrypted } from '../api/lib/tokenCrypto.js';
import { makeAdmin } from './helpers/fakeAdmin.mjs';

const KEY = Buffer.alloc(32, 5);
const rows = () => [
  { id: 'a', user_id: 'u1', provider: 'gmail', access_token: 'AT1', refresh_token: 'RT1' },
  { id: 'b', user_id: 'u2', provider: 'outlook', access_token: 'AT2', refresh_token: null },
  { id: 'c', user_id: 'u3', provider: 'gmail', access_token: sealToken('AT3', { userId: 'u3', provider: 'gmail', column: 'access_token' }, KEY), refresh_token: 'RT3' },
];
const withRows = () => { const a = makeAdmin(); a.tables.connectors.push(...rows()); return a; };

test('dry run changes nothing and reports counts only', async () => {
  const admin = withRows();
  const before = JSON.stringify(admin.tables.connectors);
  const s = await rewriteTokens({ admin, mode: 'seal', apply: false, key: KEY });
  assert.deepEqual(s, { scanned: 3, would_change: 3, changed: 0, conflicts: 0, failed: 0 });
  assert.equal(JSON.stringify(admin.tables.connectors), before);
});

test('seal encrypts every plaintext token, keeps existing ciphertext, is idempotent', async () => {
  const admin = withRows();
  const s = await rewriteTokens({ admin, mode: 'seal', apply: true, key: KEY });
  assert.equal(s.changed, 3);
  for (const r of admin.tables.connectors) {
    for (const col of ['access_token', 'refresh_token']) if (r[col]) assert.ok(isEncrypted(r[col]), `${r.id}.${col}`);
  }
  assert.equal(openToken(admin.tables.connectors[0].refresh_token, { userId: 'u1', provider: 'gmail', column: 'refresh_token' }, KEY), 'RT1');
  assert.equal(admin.tables.connectors[1].refresh_token, null);
  const again = await rewriteTokens({ admin, mode: 'seal', apply: true, key: KEY });
  assert.deepEqual(again, { scanned: 3, would_change: 0, changed: 0, conflicts: 0, failed: 0 });
});

test('unseal is the exact inverse (rollback)', async () => {
  const admin = withRows();
  await rewriteTokens({ admin, mode: 'seal', apply: true, key: KEY });
  await rewriteTokens({ admin, mode: 'unseal', apply: true, key: KEY });
  const plain = admin.tables.connectors.map((r) => [r.id, r.access_token, r.refresh_token]);
  assert.deepEqual(plain, [['a', 'AT1', 'RT1'], ['b', 'AT2', null], ['c', 'AT3', 'RT3']]);
});

test('a row changed concurrently is not overwritten (compare-and-set) and is reported', async () => {
  const admin = withRows();
  const realFrom = admin.from;
  let raced = false;
  admin.from = (t) => {
    const b = realFrom(t);
    const upd = b.update;
    b.update = (patch) => {
      if (!raced) { raced = true; admin.tables.connectors[0].access_token = 'AT1-refreshed-meanwhile'; }
      return upd(patch);
    };
    return b;
  };
  const s = await rewriteTokens({ admin, mode: 'seal', apply: true, key: KEY });
  assert.equal(s.conflicts, 1);
  assert.equal(admin.tables.connectors[0].access_token, 'AT1-refreshed-meanwhile');
});

test('a wrong key on unseal counts a failure and leaves the row alone', async () => {
  const admin = withRows();
  await rewriteTokens({ admin, mode: 'seal', apply: true, key: KEY });
  const before = JSON.stringify(admin.tables.connectors);
  const s = await rewriteTokens({ admin, mode: 'unseal', apply: true, key: Buffer.alloc(32, 1) });
  assert.equal(s.failed, 3);
  assert.equal(JSON.stringify(admin.tables.connectors), before);
});

test('requires a key and a valid mode', async () => {
  await assert.rejects(rewriteTokens({ admin: makeAdmin(), mode: 'seal', key: null }), /CONNECTOR_TOKEN_KEY/);
  await assert.rejects(rewriteTokens({ admin: makeAdmin(), mode: 'zip', key: KEY }), /mode/);
});
