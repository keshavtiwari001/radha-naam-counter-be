import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createAccountStore } from '../src/services/accountStore.js';
import { createCounterService } from '../src/services/counterService.js';
import { createLeaderboardService } from '../src/services/leaderboardService.js';
import { createApp } from '../src/app.js';
import { memoryDatabase } from './helpers/memoryDatabase.js';

const identity = { googleSub: 'delete-test', email: 'private@example.test', displayName: 'Devotee', photoUrl: null };
const config = { origin: 'https://counter.test', secure: true, googleClientId: 'client', sessionSecret: 'x'.repeat(64) };

test('deletion removes all account collections and ranks; retries and fresh Google sign-in never restore progress', async () => {
  const database = memoryDatabase();
  const connect = async () => database;
  const store = createAccountStore(connect);
  const counter = createCounterService(connect);
  const account = await store.signIn(identity, null, false);
  const other = await store.signIn({ ...identity, googleSub: 'other' }, null, false);
  await counter.sync(account.session, { counterEpoch: account.profile.counterEpoch,
    operationId: 'operation', sequence: 1, totalChants: 216 });
  await store.deleteAccount(account.session);
  // Retry with the original signed cookie after losing the committed response.
  await store.deleteAccount(account.session);
  for (const name of ['counter_states', 'period_totals', 'sync_operations']) {
    assert.equal(await database.db.collection(name).countDocuments({ userId: new ObjectId(account.profile.id) }), 0);
  }
  assert.equal(await database.db.collection('users').findOne({ _id: new ObjectId(account.profile.id) }), null);
  assert.equal((await store.profile(other.session)).id, other.profile.id);
  await assert.rejects(counter.sync(account.session, { counterEpoch: account.profile.counterEpoch,
    operationId: 'late', sequence: 2, totalChants: 324 }), { status: 401 });
  assert.equal((await createLeaderboardService(connect).current('day')).entries.length, 0);
  const fresh = await store.signIn(identity, null, false);
  assert.notEqual(fresh.profile.id, account.profile.id);
  assert.equal(fresh.profile.totalChants, 0);
});

test('revoked device cannot delete and transaction failure rolls back every deletion', async () => {
  const database = memoryDatabase();
  const store = createAccountStore(async () => database);
  const first = await store.signIn(identity, null, false);
  const active = await store.signIn(identity, null, true);
  await assert.rejects(store.deleteAccount(first.session), { status: 401 });
  const original = database.db.collection.bind(database.db);
  database.db.collection = (name) => {
    const collection = original(name);
    if (name === 'sync_operations') collection.deleteMany = async () => { throw new Error('Database interrupted'); };
    return collection;
  };
  await assert.rejects(store.deleteAccount(active.session), /Database interrupted/);
  database.db.collection = original;
  assert.equal((await store.profile(active.session)).id, active.profile.id);
  assert.ok(await original('counter_states').findOne({ userId: new ObjectId(active.profile.id) }));
});

test('DELETE /me requires session, matching account, explicit confirmation and same origin', async (t) => {
  const database = memoryDatabase();
  const app = createApp({ store: createAccountStore(async () => database), authConfig: () => config,
    verifyIdentity: async () => identity });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const login = await fetch(`${base}/auth/google`, { method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: 'token' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { profile } = await login.json();
  const body = { accountId: profile.id, confirmation: 'DELETE' };
  const remove = (value = body, origin = config.origin, sessionCookie = cookie) => fetch(`${base}/me`, {
    method: 'DELETE', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: sessionCookie }, body: JSON.stringify(value),
  });
  assert.equal((await remove({ accountId: profile.id })).status, 400);
  assert.equal((await remove({ ...body, extra: true })).status, 400);
  assert.equal((await remove(body, 'https://foreign.test')).status, 403);
  assert.equal((await remove(body, config.origin, '')).status, 401);
  assert.equal((await remove({ ...body, accountId: '0123456789abcdef01234567' })).status, 409);
  const response = await remove();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await remove()).status, 204);
  assert.equal((await fetch(`${base}/me`, { headers: { Cookie: cookie } })).status, 401);
});
