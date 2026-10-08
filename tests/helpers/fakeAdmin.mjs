// Tiny in-memory stand-in for the supabase-js query builder (only what the
// connector code uses). Each write is applied synchronously, so an UPDATE with a
// guard (consumed_at IS NULL) behaves like the single atomic SQL statement.
export function makeAdmin({ fail = {} } = {}) {
  const tables = { connectors: [], oauth_states: [] };
  let seq = 0;
  const calls = [];
  const matches = (row, f) =>
    f.every(([op, col, val]) => {
      const v = row[col];
      if (op === 'eq') return v === val;
      if (op === 'is') return val === null ? v == null : v === val;
      if (op === 'gt') return v != null && v > val;
      if (op === 'lt') return v != null && v < val;
      if (op === 'in') return val.includes(v);
      throw new Error('fake: unsupported ' + op);
    });
  function builder(table) {
    const q = { op: 'select', filters: [], patch: null, row: null, opts: null, ret: false, single: false };
    const run = () => {
      calls.push({ table, op: q.op });
      const failKey = `${table}.${q.op}`;
      if (fail[failKey]) return { data: null, error: { message: `injected ${failKey}` } };
      const rows = tables[table];
      if (q.op === 'insert') {
        rows.push({ id: `id${++seq}`, ...q.row });
        return { data: null, error: null };
      }
      if (q.op === 'upsert') {
        const keys = q.opts.onConflict.split(',');
        const i = rows.findIndex((r) => keys.every((k) => r[k] === q.row[k]));
        if (i >= 0) rows[i] = { ...rows[i], ...q.row };
        else rows.push({ id: `id${++seq}`, ...q.row });
        return { data: null, error: null };
      }
      if (q.op === 'update') {
        const hit = rows.filter((r) => matches(r, q.filters));
        hit.forEach((r) => Object.assign(r, q.patch));
        const data = q.ret ? hit.map((r) => ({ ...r })) : null;
        return { data: q.single ? (data?.[0] ?? null) : data, error: null };
      }
      if (q.op === 'delete') {
        tables[table] = rows.filter((r) => !matches(r, q.filters));
        return { data: null, error: null };
      }
      let hit = rows.filter((r) => matches(r, q.filters)).map((r) => ({ ...r }));
      if (q.limit) hit = hit.slice(0, q.limit);
      return { data: q.single ? (hit[0] ?? null) : hit, error: null };
    };
    const api = {
      select() { if (q.op === 'update') q.ret = true; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      upsert(row, opts) { q.op = 'upsert'; q.row = row; q.opts = opts; return api; },
      update(patch) { q.op = 'update'; q.patch = patch; return api; },
      delete() { q.op = 'delete'; return api; },
      eq(c, v) { q.filters.push(['eq', c, v]); return api; },
      is(c, v) { q.filters.push(['is', c, v]); return api; },
      gt(c, v) { q.filters.push(['gt', c, v]); return api; },
      lt(c, v) { q.filters.push(['lt', c, v]); return api; },
      in(c, v) { q.filters.push(['in', c, v]); return api; },
      order() { return api; },
      limit(n) { q.limit = n; return api; },
      maybeSingle() { q.single = true; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return { from: builder, tables, calls };
}
