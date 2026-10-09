import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeStartHandler, makeCallbackHandler, makeDisconnectHandler } from '../api/lib/connectorHandlers.js';
import { openToken } from '../api/lib/tokenCrypto.js';
import { readNonce } from '../api/lib/oauthState.js';
import { makeAdmin } from './helpers/fakeAdmin.mjs';

// Wiring tests: the HTTP layer with fake req/res and injected dependencies.
const G = { gmail: ['g-mail'], google_drive: ['g-drive'] };
const M = { outlook: ['m-mail'] };
const quiet = { error() {}, warn() {} };
const APP = 'https://app.example';

function res() {
  const r = {
    headers: {}, statusCode: 200, body: undefined, redirected: null, ended: false,
    setHeader(k, v) { r.headers[k] = v; },
    status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; return r; },
    send(b) { r.body = b; return r; },
    end() { r.ended = true; return r; },
    redirect(u) { r.redirected = u; return r; },
  };
  return r;
}
const user = (id) => async (req) => (req.headers?.authorization === `Bearer ${id}` ? { id } : null);

function startHandler(admin, over = {}) {
  return makeStartHandler({
    family: 'google', defaultProvider: 'gmail', scopes: G, withCors: true, log: quiet,
    getUser: async (req) => (req.headers?.authorization ? { id: req.headers.authorization.replace('Bearer ', '') } : null),
    getAdmin: () => admin,
    configure: () => ({ config: { appUrl: APP, redirectUri: `${APP}/cb` } }),
    buildUrl: (_c, scopes, state) => `https://accounts.example/auth?scope=${scopes.join(',')}&state=${state}`,
    ...over,
  });
}
function callbackHandler(admin, over = {}) {
  const calls = { exchange: 0 };
  const h = makeCallbackHandler({
    family: 'google', scopes: G, getAdmin: () => admin, log: quiet,
    configure: () => ({ appUrl: APP, home: APP }),
    exchange: async () => { calls.exchange++; return { access_token: 'AT', refresh_token: 'RT', expires_in: 60 }; },
    getEmail: async () => 'a@x.com',
    ...over,
  });
  return { h, calls };
}
const cookieFrom = (setCookie) => setCookie.split(';')[0];
async function startFlow(admin, uid, provider = 'gmail', over = {}) {
  const r = res();
  await startHandler(admin, over)({ method: 'GET', headers: { authorization: `Bearer ${uid}` }, query: { provider } }, r);
  return r;
}
const stateOf = (r) => new URL(r.body.url).searchParams.get('state');

test('start: identity is the authenticated user only; query parameters naming other users are ignored', async () => {
  const admin = makeAdmin();
  const r = res();
  await startHandler(admin)({ method: 'GET', headers: { authorization: 'Bearer alice' }, query: { provider: 'gmail', userId: 'victim', user_id: 'victim', uid: 'victim' } }, r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(admin.tables.oauth_states.map((x) => x.user_id), ['alice']);
});

test('start: 401 without a valid user, 405 for other methods, nothing is stored', async () => {
  const admin = makeAdmin();
  const noUser = res();
  await startHandler(admin, { getUser: async () => null })({ method: 'GET', headers: {}, query: {} }, noUser);
  assert.equal(noUser.statusCode, 401);
  const post = res();
  await startHandler(admin)({ method: 'POST', headers: { authorization: 'Bearer a' }, query: {} }, post);
  assert.equal(post.statusCode, 405);
  assert.equal(admin.tables.oauth_states.length, 0);
});

test('start: sets the browser-binding cookie (HttpOnly, Lax, Secure on https) and never puts the nonce in the body', async () => {
  const admin = makeAdmin();
  const r = await startFlow(admin, 'alice');
  const sc = r.headers['Set-Cookie'];
  assert.ok(/HttpOnly/.test(sc) && /SameSite=Lax/.test(sc) && /Secure/.test(sc) && /Path=\/api\/connectors/.test(sc));
  const nonce = readNonce(cookieFrom(sc), stateOf(r));
  assert.ok(nonce && !JSON.stringify(r.body).includes(nonce));
  const http = await startFlow(makeAdmin(), 'alice', 'gmail', { configure: () => ({ config: { appUrl: 'http://localhost:3000' } }) });
  assert.ok(!/Secure/.test(http.headers['Set-Cookie']));
});

test('start: rate limited, unknown / prototype providers rejected, misconfiguration reported, no state minted', async () => {
  const admin = makeAdmin();
  const limited = res();
  await startHandler(admin, { allow: () => false })({ method: 'GET', headers: { authorization: 'Bearer a' }, query: {} }, limited);
  assert.equal(limited.statusCode, 429);
  for (const p of ['nope', 'constructor', '__proto__']) assert.equal((await startFlow(admin, 'a', p)).statusCode, 400, p);
  const bad = res();
  await startHandler(admin, { configure: () => ({ status: 500, body: { error: 'Google OAuth not configured' } }) })({ method: 'GET', headers: { authorization: 'Bearer a' }, query: {} }, bad);
  assert.equal(bad.statusCode, 500);
  assert.equal(admin.tables.oauth_states.length, 0);
});

test('start: the provider URL uses the scopes of the requested provider', async () => {
  const r = await startFlow(makeAdmin(), 'alice', 'google_drive');
  assert.equal(new URL(r.body.url).searchParams.get('scope'), 'g-drive');
});

test('start: CORS preflight is answered without touching the database', async () => {
  const admin = makeAdmin();
  const r = res();
  await startHandler(admin)({ method: 'OPTIONS', headers: {}, query: {} }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.ended, true);
  assert.equal(admin.calls.length, 0);
});

test('callback: end to end start -> callback stores the tokens for the user who started, and clears the cookie', async () => {
  const admin = makeAdmin();
  const s = await startFlow(admin, 'alice');
  const { h } = callbackHandler(admin);
  const r = res();
  await h({ method: 'GET', headers: { cookie: cookieFrom(s.headers['Set-Cookie']) }, query: { code: 'c', state: stateOf(s) } }, r);
  assert.equal(r.redirected, `${APP}?connected=gmail`);
  assert.deepEqual(admin.tables.connectors.map((x) => [x.user_id, x.provider, x.scopes]), [['alice', 'gmail', ['g-mail']]]);
  assert.match(r.headers['Set-Cookie'], /Max-Age=0/);
});

test('callback: login-CSRF through the real handlers - a victim\'s browser cannot complete the attacker\'s flow', async () => {
  const admin = makeAdmin();
  const attacker = await startFlow(admin, 'attacker');
  const { h, calls } = callbackHandler(admin);
  const r = res();
  await h({ method: 'GET', headers: { cookie: 'victim_session=1' }, query: { code: 'victim-code', state: stateOf(attacker) } }, r);
  assert.match(r.redirected, /connector_error=invalid_state/);
  assert.equal(calls.exchange, 0);
  assert.equal(admin.tables.connectors.length, 0);
});

test('callback: a state minted for the Microsoft family is refused by the Google callback (and vice versa)', async () => {
  const admin = makeAdmin();
  const ms = await startFlow(admin, 'alice', 'outlook', { family: 'microsoft', scopes: M, defaultProvider: 'outlook' });
  const { h, calls } = callbackHandler(admin);
  const r = res();
  await h({ method: 'GET', headers: { cookie: cookieFrom(ms.headers['Set-Cookie']) }, query: { code: 'c', state: stateOf(ms) } }, r);
  assert.match(r.redirected, /connector_error=invalid_state/);
  assert.equal(calls.exchange, 0);
  // and the right callback still accepts it afterwards (the wrong-family attempt did not burn it)
  const { h: hm } = callbackHandler(admin, { family: 'microsoft', scopes: M });
  const r2 = res();
  await hm({ method: 'GET', headers: { cookie: cookieFrom(ms.headers['Set-Cookie']) }, query: { code: 'c', state: stateOf(ms) } }, r2);
  assert.equal(r2.redirected, `${APP}?connected=outlook`);
  assert.deepEqual(admin.tables.connectors[0].scopes, ['m-mail'], 'Microsoft scopes, not Google\'s');
});

test('callback: only GET, and an unexpected failure redirects to a fixed error code', async () => {
  const admin = makeAdmin();
  const { h } = callbackHandler(admin);
  const post = res();
  await h({ method: 'POST', headers: {}, query: {} }, post);
  assert.equal(post.statusCode, 405);
  const boom = callbackHandler(admin, { getAdmin: () => { throw new Error('db password in message'); } }).h;
  const r = res();
  await boom({ method: 'GET', headers: {}, query: { code: 'c', state: 'x' } }, r);
  assert.equal(r.redirected, `${APP}?connector_error=callback_failed`);
  assert.ok(!r.redirected.includes('password'));
});

function disc(admin, over = {}) {
  const revoked = [];
  const h = makeDisconnectHandler({
    getUser: user('u1'), getAdmin: () => admin, log: quiet,
    scopesByFamily: { google: G, microsoft: M }, googleProviders: Object.keys(G),
    revokeGoogle: async (t) => { revoked.push(t); return true; }, openToken, ...over,
  });
  return { h, revoked };
}
const seedRows = (admin) => {
  admin.tables.connectors.push(
    { id: 'c1', user_id: 'u1', provider: 'gmail', account_email: 'a@x.com', access_token: 'A1', refresh_token: 'R1' },
    { id: 'c2', user_id: 'u2', provider: 'gmail', account_email: 'b@x.com', access_token: 'A2', refresh_token: 'R2' },
  );
};

test('disconnect: acts only on the authenticated user, whatever the body says (no IDOR)', async () => {
  const admin = makeAdmin();
  seedRows(admin);
  const { h, revoked } = disc(admin);
  const r = res();
  await h({ method: 'POST', headers: { authorization: 'Bearer u1' }, body: { provider: 'gmail', userId: 'u2', user_id: 'u2' } }, r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(admin.tables.connectors.map((x) => x.user_id), ['u2'], 'u2\'s row survives');
  assert.deepEqual(revoked, ['R1'], 'only the caller\'s token was revoked');
});

test('disconnect: 401 unauthenticated, 400 without provider or with a prototype key, string bodies are parsed', async () => {
  const admin = makeAdmin();
  seedRows(admin);
  const { h } = disc(admin);
  const a = res(); await h({ method: 'POST', headers: {}, body: { provider: 'gmail' } }, a);
  assert.equal(a.statusCode, 401);
  const b = res(); await h({ method: 'POST', headers: { authorization: 'Bearer u1' }, body: {} }, b);
  assert.equal(b.statusCode, 400);
  for (const p of ['constructor', '__proto__', 'toString']) {
    const c = res(); await h({ method: 'POST', headers: { authorization: 'Bearer u1' }, body: { provider: p } }, c);
    assert.equal(c.statusCode, 400, p);
  }
  const d = res(); await h({ method: 'POST', headers: { authorization: 'Bearer u1' }, body: JSON.stringify({ provider: 'gmail' }) }, d);
  assert.equal(d.statusCode, 200);
  assert.equal(admin.tables.connectors.length, 1);
  const e = res(); await h({ method: 'GET', headers: { authorization: 'Bearer u1' } }, e);
  assert.equal(e.statusCode, 405);
});

// Static check of the thin bindings in api/connectors/ (they are not importable here without the
// Supabase client): each endpoint must be wired to its own provider family and scope map.
test('static wiring: every endpoint is bound to its own family and scope map', () => {
  const src = (f) => readFileSync(new URL(`../api/connectors/${f}`, import.meta.url), 'utf8');
  for (const f of ['google-start.js', 'google-callback.js']) {
    assert.match(src(f), /family: 'google'/, f);
    assert.match(src(f), /scopes: PROVIDER_SCOPES\b/, f);
    assert.doesNotMatch(src(f), /MS_PROVIDER_SCOPES|family: 'microsoft'/, f);
  }
  for (const f of ['microsoft-start.js', 'microsoft-callback.js']) {
    assert.match(src(f), /family: 'microsoft'/, f);
    assert.match(src(f), /scopes: MS_PROVIDER_SCOPES\b/, f);
    assert.doesNotMatch(src(f), /\bPROVIDER_SCOPES\b(?<!MS_PROVIDER_SCOPES)[^_]|family: 'google'/, f);
  }
  const d = src('disconnect.js');
  assert.match(d, /scopesByFamily: \{ google: PROVIDER_SCOPES, microsoft: MS_PROVIDER_SCOPES \}/);
  assert.match(d, /getUser: getUserFromAuthHeader/);
});
