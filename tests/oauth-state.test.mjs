import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOAuthState, consumeOAuthState, hashState, STATE_TTL_MS,
  nonceCookieName, setNonceCookie, clearNonceCookie, readNonce,
} from '../api/lib/oauthState.js';
import { beginFlow } from '../api/lib/oauthFlow.js';
import { makeAdmin } from './helpers/fakeAdmin.mjs';

const T0 = 1_800_000_000_000;
const mk = (admin, over = {}) => createOAuthState({ admin, userId: 'u1', provider: 'gmail', family: 'google', now: T0, ...over });
const consume = (admin, s, over = {}) => consumeOAuthState({ admin, state: s.state, nonce: s.nonce, family: 'google', now: T0 + 1000, ...over });

test('state and nonce are 32 random bytes each, stored only as one hash, bound to user and provider', async () => {
  const admin = makeAdmin();
  const s = await mk(admin);
  assert.match(s.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(s.nonce, /^[A-Za-z0-9_-]{43}$/);
  const [row] = admin.tables.oauth_states;
  assert.equal(row.state_hash, hashState(s.state, s.nonce));
  assert.ok(!JSON.stringify(row).includes(s.state) && !JSON.stringify(row).includes(s.nonce), 'raw values must not be stored');
  assert.equal(row.user_id, 'u1');
  assert.equal(row.provider, 'gmail');
  assert.equal(new Date(row.expires_at).getTime(), T0 + STATE_TTL_MS);
  const other = await mk(admin);
  assert.notEqual(s.state, other.state, 'states are unpredictable / unique');
  assert.notEqual(s.nonce, other.nonce);
});

test('consume returns identity from the server row and is single-use (replay rejected)', async () => {
  const admin = makeAdmin();
  const s = await mk(admin);
  assert.deepEqual(await consume(admin, s), { ok: true, userId: 'u1', provider: 'gmail' });
  assert.deepEqual(await consume(admin, s, { now: T0 + 2000 }), { ok: false, reason: 'invalid_state' });
});

test('login-CSRF: the right state without this browser\'s nonce is useless and does not burn the flow', async () => {
  const admin = makeAdmin();
  const attackerFlow = await mk(admin, { userId: 'attacker' });
  // The victim opens the attacker's provider URL: has the state, but not the attacker's cookie.
  const callsBefore = admin.calls.length;
  for (const nonce of [undefined, null, '', 'x', 'A'.repeat(44)]) {
    assert.deepEqual(await consumeOAuthState({ admin, state: attackerFlow.state, nonce, family: 'google', now: T0 + 5 }),
      { ok: false, reason: 'invalid_state' });
  }
  assert.equal(admin.calls.length, callsBefore, 'a malformed or missing nonce is rejected before any database call');
  assert.deepEqual(await consumeOAuthState({ admin, state: attackerFlow.state, nonce: 'A'.repeat(43), family: 'google', now: T0 + 5 }),
    { ok: false, reason: 'invalid_state' }, 'a well-formed but wrong nonce finds no row');
  assert.equal(admin.tables.oauth_states[0].consumed_at, undefined, 'a failed cross-browser attempt must not consume the row');
  assert.deepEqual(await consume(admin, attackerFlow), { ok: true, userId: 'attacker', provider: 'gmail' }, 'the real browser still succeeds');
});

test('a nonce from another flow does not unlock this state', async () => {
  const admin = makeAdmin();
  const a = await mk(admin, { userId: 'u1' });
  const b = await mk(admin, { userId: 'u2' });
  assert.equal((await consumeOAuthState({ admin, state: a.state, nonce: b.nonce, family: 'google', now: T0 + 1 })).ok, false);
  assert.equal((await consumeOAuthState({ admin, state: b.state, nonce: a.nonce, family: 'google', now: T0 + 1 })).ok, false);
});

test('two concurrent consumes of one state: exactly one wins', async () => {
  const admin = makeAdmin();
  const s = await mk(admin);
  const r = await Promise.all([1, 2, 3, 4].map(() => consume(admin, s, { now: T0 + 5 })));
  assert.equal(r.filter((x) => x.ok).length, 1);
});

test('expired state is rejected, state just inside the TTL is accepted', async () => {
  const admin = makeAdmin();
  const s1 = await mk(admin);
  assert.equal((await consume(admin, s1, { now: T0 + STATE_TTL_MS })).ok, false);
  const s2 = await mk(admin);
  assert.equal((await consume(admin, s2, { now: T0 + STATE_TTL_MS - 1 })).ok, true);
});

test('a state minted for one provider family cannot be used on the other callback', async () => {
  const admin = makeAdmin();
  const s = await mk(admin);
  assert.equal((await consume(admin, s, { family: 'microsoft' })).ok, false);
  assert.equal((await consume(admin, s)).ok, true, 'wrong-family attempt must not burn it');
});

test('forged and malformed states never reach the database', async () => {
  const admin = makeAdmin();
  const nonce = 'B'.repeat(43);
  const legacy = Buffer.from(JSON.stringify({ userId: 'victim', provider: 'gmail', t: T0 })).toString('base64url');
  for (const bad of [legacy, '', 'x', 'A'.repeat(42), 'A'.repeat(44), undefined, null, 123, ['a'], { s: 1 }]) {
    assert.deepEqual(await consumeOAuthState({ admin, state: bad, nonce, family: 'google', now: T0 }), { ok: false, reason: 'invalid_state' });
  }
  assert.equal(admin.calls.length, 0);
});

test('unknown but well-formed state is rejected', async () => {
  const admin = makeAdmin();
  const r = await consumeOAuthState({ admin, state: 'A'.repeat(43), nonce: 'B'.repeat(43), family: 'google', now: T0 });
  assert.deepEqual(r, { ok: false, reason: 'invalid_state' });
});

test('state store failure on consume is reported, not treated as valid', async () => {
  const admin = makeAdmin({ fail: { 'oauth_states.update': true } });
  const r = await consumeOAuthState({ admin, state: 'A'.repeat(43), nonce: 'B'.repeat(43), family: 'google', now: T0 });
  assert.deepEqual(r, { ok: false, reason: 'state_store_unavailable' });
});

// ---- the browser-binding cookie
test('nonce cookie: HttpOnly, SameSite=Lax, scoped to the connector endpoints, short-lived', () => {
  const s = 'S'.repeat(43);
  const c = setNonceCookie(s, 'N'.repeat(43), { secure: true });
  assert.ok(c.startsWith(`${nonceCookieName(s)}=${'N'.repeat(43)};`));
  for (const attr of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/api/connectors', `Max-Age=${STATE_TTL_MS / 1000}`]) {
    assert.ok(c.includes(attr), `missing ${attr}`);
  }
  assert.ok(!setNonceCookie(s, 'N'.repeat(43), { secure: false }).includes('Secure'), 'http (local dev) cookies cannot be Secure');
  assert.ok(!/Domain=/.test(c), 'no Domain attribute: host-only cookie');
});

test('nonce cookie: read picks this flow\'s cookie among others and rejects malformed values', () => {
  const s1 = 'S'.repeat(43);
  const s2 = 'T'.repeat(43);
  const n1 = 'N'.repeat(43);
  const n2 = 'M'.repeat(43);
  const header = `a=1; ${nonceCookieName(s1)}=${n1}; ${nonceCookieName(s2)}=${n2}; z=9`;
  assert.equal(readNonce(header, s1), n1);
  assert.equal(readNonce(header, s2), n2);
  assert.equal(readNonce(header, 'U'.repeat(43)), null);
  assert.equal(readNonce(`${nonceCookieName(s1)}=short`, s1), null);
  assert.equal(readNonce(undefined, s1), null);
  assert.equal(readNonce(header, 'not-a-state'), null);
});

test('nonce cookie: clearing expires it and refuses malformed states', () => {
  const s = 'S'.repeat(43);
  const c = clearNonceCookie(s, { secure: true });
  assert.ok(c.startsWith(`${nonceCookieName(s)}=;`) && c.includes('Max-Age=0') && c.includes('Path=/api/connectors'));
  assert.equal(clearNonceCookie('nope'), null);
  assert.equal(clearNonceCookie(undefined), null);
});

// ---- start
test('fail closed on start: no state store, no authorization URL, no cookie', async () => {
  const admin = makeAdmin({ fail: { 'oauth_states.insert': true } });
  let built = false;
  const out = await beginFlow({
    family: 'google', provider: 'gmail', user: { id: 'u1' }, admin, now: T0,
    scopesFor: () => ['s'], buildUrl: () => { built = true; return 'https://x'; },
  });
  assert.equal(out.status, 503);
  assert.equal(built, false);
  assert.equal(out.body.url, undefined);
  assert.equal(out.cookie, undefined);
});

test('start rejects unknown providers without creating a state', async () => {
  const admin = makeAdmin();
  const out = await beginFlow({ family: 'google', provider: 'nope', user: { id: 'u1' }, admin, scopesFor: () => undefined, buildUrl: () => 'x' });
  assert.equal(out.status, 400);
  assert.equal(admin.tables.oauth_states.length, 0);
});

test('start puts the opaque state (not user data, not the nonce) into the URL and the nonce into the cookie', async () => {
  const admin = makeAdmin();
  const out = await beginFlow({
    family: 'google', provider: 'gmail', user: { id: 'u-secret-uuid' }, admin, now: T0,
    scopesFor: () => ['s'], buildUrl: (state) => `https://accounts.example/auth?state=${state}`,
  });
  assert.equal(out.status, 200);
  const state = new URL(out.body.url).searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!out.body.url.includes('u-secret-uuid'));
  assert.ok(!Buffer.from(state, 'base64url').toString('utf8').includes('userId'));
  const nonce = readNonce(out.cookie.split(';')[0], state);
  assert.ok(nonce, 'cookie carries a nonce for exactly this state');
  assert.ok(!out.body.url.includes(nonce), 'the nonce never appears in the URL');
  assert.equal(admin.tables.oauth_states[0].state_hash, hashState(state, nonce));
});
