import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createApp } from '../src/app.js';
import { createAccountStore } from '../src/services/accountStore.js';
import { decodeSession } from '../src/services/session.js';
import { HttpError } from '../src/utils/httpError.js';
import { memoryDatabase } from './helpers/memoryDatabase.js';

const config = { origin: 'https://counter.test', secure: true,
  googleClientId: 'client', sessionSecret: 'a'.repeat(64) };
const identity = { googleSub: 'google-sub', email: 'private@example.test',
  displayName: 'Radha Devotee', photoUrl: 'https://lh3.googleusercontent.com/photo' };

async function setup(t, overrides = {}) {
  const database = memoryDatabase();
  const store = createAccountStore(async () => database);
  const app = createApp({ store, authConfig: () => config,
    verifyIdentity: async (credential) => {
      if (credential !== 'valid-google-token') throw new HttpError(401, 'Invalid token', 'GOOGLE_TOKEN_INVALID');
      return identity;
    }, ...overrides });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function request(path, { method = 'GET', body, cookie, origin = config.origin, headers = {} } = {}) {
    return fetch(`${base}${path}`, { method,
      headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  const login = (cookie, replaceSession) => request('/auth/google', { method: 'POST', cookie,
    body: { credential: 'valid-google-token', ...(replaceSession !== undefined ? { replaceSession } : {}) } });
  return { request, login, database, store };
}
const cookieOf = (response) => response.headers.get('set-cookie')?.split(';')[0];

test('rankings allow guests, validate active own-rank sessions and remain uncached', async (t) => {
  const calls = [];
  const { request, login } = await setup(t, { leaderboardService: {
    async current(period, userId) { calls.push({ period, userId }); return { entries: [], ownEntry: null }; },
  } });
  const guest = await request('/leaderboard?period=week');
  assert.equal(guest.status, 200);
  assert.equal(guest.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls[0], { period: 'week', userId: undefined });
  const cookie = cookieOf(await login());
  assert.equal((await request('/leaderboard', { cookie })).status, 200);
  assert.equal(calls[1].period, 'day');
  assert.match(calls[1].userId, /^[a-f0-9]{24}$/);
  await request('/auth/logout', { method: 'POST', cookie, body: {} });
  assert.equal((await request('/leaderboard', { cookie })).status, 401);
  assert.equal(calls.length, 2);
});

test('sign-in, private profile, rename and logout use a secure cookie without exposing session state', async (t) => {
  const { login, request, database } = await setup(t);
  const response = await login();
  assert.equal(response.status, 200);
  const cookie = cookieOf(response);
  const header = response.headers.get('set-cookie');
  for (const flag of ['__Host-rnjc_session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(header.includes(flag));
  assert.ok(!header.includes('Domain='));
  const { profile } = await response.json();
  assert.equal(profile.email, identity.email);
  assert.equal(profile.totalChants, 0);
  for (const key of ['googleSub', 'activeSessionId', 'sessionId']) assert.ok(!(key in profile));
  assert.equal((await request('/me')).status, 401);
  const privateResponse = await request('/me', { cookie });
  assert.equal(privateResponse.headers.get('cache-control'), 'no-store');
  assert.equal((await privateResponse.json()).profile.email, identity.email);
  const rename = await request('/me', { cookie, method: 'PATCH', body: { displayName: '  New name  ' } });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json()).profile.displayName, 'New name');
  const savedUser = await database.db.collection('users').findOne({ googleSub: identity.googleSub });
  assert.notEqual(savedUser.activeSessionId, decodeSession(cookie.split('=')[1], config.sessionSecret).sessionId);
  const logout = await request('/auth/logout', { cookie, method: 'POST', body: {} });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await request('/me', { cookie })).status, 401);
  assert.equal((await request('/auth/logout', { method: 'POST', body: {} })).status, 204);
});

test('second device is rejected until explicit replacement; old cookies cannot edit or revoke the new session', async (t) => {
  const { login, request } = await setup(t);
  const original = cookieOf(await login());
  const conflict = await login();
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'ACTIVE_DEVICE_EXISTS');
  assert.equal(conflict.headers.get('set-cookie'), null);
  const replacement = await login(undefined, true);
  assert.equal(replacement.status, 200);
  const current = cookieOf(replacement);
  assert.equal((await request('/me', { cookie: original })).status, 401);
  assert.equal((await request('/me', { cookie: original, method: 'PATCH', body: { displayName: 'Old device' } })).status, 401);
  await request('/auth/logout', { cookie: original, method: 'POST', body: {} });
  assert.equal((await request('/me', { cookie: current })).status, 200);
  assert.equal((await login(current)).status, 200);
});

test('returning sign-in retains saved total and chosen display name; expired active device can sign in again', async (t) => {
  const { login, request, database } = await setup(t);
  const first = await login();
  const cookie = cookieOf(first);
  const { profile } = await first.json();
  await request('/me', { cookie, method: 'PATCH', body: { displayName: 'Chosen name' } });
  await database.db.collection('counter_states').updateOne({ userId: new ObjectId(profile.id) }, { $set: { totalChants: 250 } });
  await database.db.collection('users').updateOne({ _id: new ObjectId(profile.id) }, { $set: { activeSessionExpiresAt: new Date(0) } });
  const returning = await login();
  const saved = (await returning.json()).profile;
  assert.equal(returning.status, 200);
  assert.equal(saved.id, profile.id);
  assert.equal(saved.totalChants, 250);
  assert.equal(saved.completedLifetimeMalas, 2);
  assert.equal(saved.displayName, 'Chosen name');
});

test('mutations reject missing/foreign origins and non-JSON requests before Google verification', async (t) => {
  let verifications = 0;
  const { request } = await setup(t, { verifyIdentity: () => { verifications++; return identity; } });
  for (const origin of ['', 'null', 'https://attacker.test', 'https://counter.test.attacker.test']) {
    const response = await request('/auth/google', { method: 'POST', origin, body: { credential: 'token' } });
    assert.equal(response.status, 403);
  }
  assert.equal((await request('/auth/google', { method: 'POST', body: { credential: 'token' }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request('/auth/google', { method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(verifications, 0);
});

test('token failures and invalid inputs cannot modify private fields', async (t) => {
  const { login, request } = await setup(t);
  assert.equal((await request('/auth/google', { method: 'POST', body: { credential: 'invalid' } })).status, 401);
  for (const body of [{}, { credential: 42 }, { credential: 'token', replaceSession: 'yes' }, { credential: 'token', userId: 'someone' }]) {
    assert.equal((await request('/auth/google', { method: 'POST', body })).status, 400);
  }
  const cookie = cookieOf(await login());
  for (const body of [{ displayName: '' }, { displayName: ' ' }, { displayName: 'a'.repeat(81) },
    { displayName: 'a\u0000b' }, { displayName: 'a\u202Eb' }, { displayName: 'Name', email: 'other@test' }, { photoUrl: 'https://attacker.test/photo' }]) {
    assert.equal((await request('/me', { method: 'PATCH', body, cookie })).status, 400);
  }
  const profile = (await (await request('/me', { cookie })).json()).profile;
  assert.equal(profile.email, identity.email);
  assert.equal(profile.photoUrl, identity.photoUrl);
});

test('tampered cookies are rejected and backend failures do not leak secrets', async (t) => {
  const { login, request } = await setup(t);
  const cookie = cookieOf(await login());
  assert.equal((await request('/me', { cookie: `${cookie}x` })).status, 401);
  const broken = await setup(t, { store: { signIn: async () => { throw new Error('mongodb://user:secret@db'); } } });
  const response = await broken.login();
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('secret'));
  const missingConfig = await setup(t, { authConfig: () => { throw new Error('SESSION_SECRET missing'); } });
  assert.equal((await missingConfig.request('/me')).status, 503);
});

test('repeated sign-in attempts are rate limited', async (t) => {
  const { login } = await setup(t, { rateLimitMax: 2 });
  await login();
  await login();
  const limited = await login();
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, 'RATE_LIMITED');
});

test('failed counter initialization rolls back account creation and no cookie is issued', async (t) => {
  const database = memoryDatabase();
  const collection = database.db.collection;
  database.db.collection = (name) => {
    const result = collection(name);
    if (name === 'counter_states') result.updateOne = async () => { throw new Error('Database error'); };
    return result;
  };
  const { login } = await setup(t, { store: createAccountStore(async () => database) });
  const response = await login();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await database.db.collection('users').findOne({ googleSub: identity.googleSub }), null);
});
