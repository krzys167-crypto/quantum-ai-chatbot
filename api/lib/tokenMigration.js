// One-off, reversible migration of existing connector rows (F03 rollout).
//   seal:   plaintext -> enc:v1 (needs CONNECTOR_TOKEN_KEY)
//   unseal: enc:v1 -> plaintext (rollback; needs the same key)
// Dry-run unless apply === true. Only counts are returned/logged, never token values.
// Each write is compare-and-set on the old column value, so a concurrent refresh is
// never overwritten (the row is counted as a conflict and a re-run picks it up).
import { getTokenKey, openToken, sealToken, isEncrypted } from './tokenCrypto.js';

const COLS = ['access_token', 'refresh_token'];

export async function rewriteTokens({ admin, mode, apply = false, key = getTokenKey(), pageSize = 200 }) {
  if (mode !== 'seal' && mode !== 'unseal') throw new Error('mode must be seal or unseal');
  if (!key) throw new Error('CONNECTOR_TOKEN_KEY is required');
  const stats = { scanned: 0, would_change: 0, changed: 0, conflicts: 0, failed: 0 };
  let after = null;
  for (;;) {
    let q = admin.from('connectors').select('id, user_id, provider, access_token, refresh_token').order('id').limit(pageSize);
    if (after) q = q.gt('id', after);
    const { data, error } = await q;
    if (error) throw new Error('read_failed');
    if (!data?.length) break;
    for (const row of data) {
      stats.scanned++;
      const patch = {};
      try {
        for (const col of COLS) {
          const v = row[col];
          if (!v) continue;
          const ctx = { userId: row.user_id, provider: row.provider, column: col };
          if (mode === 'seal' && !isEncrypted(v)) patch[col] = sealToken(v, ctx, key);
          if (mode === 'unseal' && isEncrypted(v)) patch[col] = openToken(v, ctx, key);
        }
      } catch {
        stats.failed++;
        continue;
      }
      if (!Object.keys(patch).length) continue;
      stats.would_change++;
      if (!apply) continue;
      let u = admin.from('connectors').update(patch).eq('id', row.id);
      for (const col of Object.keys(patch)) u = u.eq(col, row[col]);
      const { data: done, error: werr } = await u.select('id');
      if (werr) stats.failed++;
      else if (!done?.length) stats.conflicts++;
      else stats.changed++;
    }
    after = data[data.length - 1].id;
    if (data.length < pageSize) break;
  }
  return stats;
}
