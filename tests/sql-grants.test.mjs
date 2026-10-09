import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Static guard for the privilege model of public.connectors. The behaviour itself is checked on
// a real PostgreSQL by supabase/verify-connectors-hardening.sql; this only stops a regression
// from slipping into the script text.
const read = (f) => readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8');
const code = (s) => s.replace(/--.*$/gm, '');
const statements = (s) => code(s).split(';').map((x) => x.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);

test('hardening script: no client role is ever granted DELETE (or anything but column SELECT) on connectors', () => {
  const grants = statements(read('connectors-hardening.sql')).filter((x) => /^grant /.test(x) && /public\.connectors/.test(x));
  const toClients = grants.filter((x) => /\bto\b.*\b(authenticated|anon|public)\b/.test(x));
  assert.ok(toClients.length >= 1, 'expected the column-level SELECT grant');
  for (const g of toClients) {
    assert.ok(/^grant select \(/.test(g), `client grant must be column-level SELECT only: ${g}`);
    const privileges = /^grant (.*?)(?: \(| on )/.exec(g)?.[1];
    assert.equal(privileges, 'select', g);
  }
  assert.ok(statements(read('connectors-hardening.sql')).some((x) => /^revoke all on public\.connectors from public, anon, authenticated$/.test(x)));
});

test('verify script expects authenticated to be unable to delete connectors', () => {
  const v = read('verify-connectors-hardening.sql');
  assert.match(v, /'authenticated_cannot_delete_connectors'\s+as chk,\s*'false'\s+as expected/);
  assert.ok(!/authenticated_can_delete_connectors/.test(v));
});

test('no front-end code deletes rows from connectors directly', () => {
  for (const f of ['../src/components/Connectors.tsx', '../src/admin/pages/Connectors.tsx']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/from\('connectors'\)[\s\S]{0,80}\.delete\(/.test(src), f);
  }
});
