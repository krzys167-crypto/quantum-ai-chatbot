// In-memory stand-in for the supabase-js calls used by the approval store. Every statement is applied
// synchronously, so `delete ... where ... returning` is atomic exactly like the single SQL statement it maps to.
export function makeApprovalDb({ fail = {} } = {}) {
  const tables = { approval_requests: [] };
  const calls = [];
  const test = (row, f) =>
    f.every(([op, col, val]) => {
      const v = row[col];
      if (op === 'eq') return v === val;
      if (op === 'gt') return v != null && v > val;
      if (op === 'lt') return v != null && v < val;
      throw new Error('fake: unsupported ' + op);
    });
  function builder(table) {
    const q = { op: 'select', filters: [], row: null, returning: false, single: false };
    const run = () => {
      calls.push({ table, op: q.op });
      if (fail[`${table}.${q.op}`]) return { data: null, error: { message: `injected ${table}.${q.op}` } };
      const rows = tables[table];
      if (q.op === 'insert') {
        if (rows.some((r) => r.id === q.row.id)) return { data: null, error: { message: 'duplicate key' } };
        rows.push(structuredClone(q.row));
        return { data: null, error: null };
      }
      if (q.op === 'delete') {
        const hit = rows.filter((r) => test(r, q.filters));
        tables[table] = rows.filter((r) => !hit.includes(r));
        const data = q.returning ? hit.map((r) => structuredClone(r)) : null;
        return { data: q.single ? (data?.[0] ?? null) : data, error: null };
      }
      const hit = rows.filter((r) => test(r, q.filters)).map((r) => structuredClone(r));
      return { data: q.single ? (hit[0] ?? null) : hit, error: null };
    };
    const api = {
      select() { if (q.op === 'delete') q.returning = true; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      delete() { q.op = 'delete'; return api; },
      eq(c, v) { q.filters.push(['eq', c, v]); return api; },
      gt(c, v) { q.filters.push(['gt', c, v]); return api; },
      lt(c, v) { q.filters.push(['lt', c, v]); return api; },
      maybeSingle() { q.single = true; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return { from: builder, tables, calls };
}
