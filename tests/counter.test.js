import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { createAccountStore } from '../src/services/accountStore.js';
import { createCounterService } from '../src/services/counterService.js';
import { createApp } from '../src/app.js';
import { memoryDatabase } from './helpers/memoryDatabase.js';

async function setup() {
  const database = memoryDatabase();
  const connect = async () => database;
  const accounts = createAccountStore(connect);
  const identity = { googleSub: 'google-sub', displayName: 'Devotee', email: 'private@test', photoUrl: null };
  const login = await accounts.signIn(identity, null, false);
  const service = createCounterService(connect, () => new Date('2026-10-26T18:30:00Z'));
  const epoch = login.profile.counterEpoch;
  const userId = new ObjectId(login.profile.id);
  const snapshot = (totalChants, sequence = 1) => ({ operationId: randomUUID(), sequence,
    totalChants, reason: 'mala_completed', counterEpoch: epoch });
  const importGuest = (totalChants = 250) => ({ importId: randomUUID(), totalChants, counterEpoch: epoch });
  return { database, accounts, identity, service, cookie: login.session, epoch, userId, snapshot, importGuest };
}

test('guest import is lifetime-only; 250 plus 74 credits just one mala to current IST periods', async () => {
  const { service, cookie, userId, database, importGuest, snapshot } = await setup();
  const input = importGuest();
  const imported = await service.importGuest(cookie, input);
  assert.equal(imported.savedTotalChants, 250);
  assert.equal(imported.importedBaseTotal, 250);
  assert.equal(await database.db.collection('period_totals').findOne({ userId }), null);
  const replay = await service.importGuest(cookie, input);
  assert.equal(replay.savedTotalChants, 250);
  assert.equal(replay.alreadyApplied, true);
  const synced = await service.sync(cookie, snapshot(324));
  assert.equal(synced.newLeaderboardMalas, 1);
  assert.equal(synced.creditedPeriod, '2026-10-27');
  for (const [periodType, periodKey] of [['day', '2026-10-27'], ['week', '2026-10-26'], ['month', '2026-10']]) {
    assert.equal((await database.db.collection('period_totals').findOne({ userId, periodType, periodKey })).malas, 1);
  }
  assert.equal((await service.sync(cookie, snapshot(358, 2))).newLeaderboardMalas, 0);
  assert.equal((await service.sync(cookie, snapshot(432, 3))).newLeaderboardMalas, 1);
});

test('lost replies, repeated operations and stale totals never add twice, including after TTL cleanup', async () => {
  const { service, cookie, database, userId, snapshot } = await setup();
  const first = snapshot(108);
  assert.equal((await service.sync(cookie, first)).newLeaderboardMalas, 1);
  assert.equal((await service.sync(cookie, first)).alreadyApplied, true);
  await service.sync(cookie, snapshot(324, 3));
  await service.sync(cookie, snapshot(216, 2));
  assert.equal((await service.counter(cookie)).savedTotalChants, 324);
  await database.db.collection('sync_operations').deleteMany({ userId });
  assert.equal((await service.sync(cookie, first)).newLeaderboardMalas, 0);
  assert.equal((await database.db.collection('period_totals').findOne({ userId, periodType: 'day' })).malas, 3);
});

test('durable guest receipt survives TTL expiry and rejects a changed count for the same ID', async () => {
  const { service, cookie, database, userId, importGuest, snapshot } = await setup();
  const input = importGuest();
  await service.importGuest(cookie, input);
  await service.sync(cookie, snapshot(324));
  await database.db.collection('sync_operations').deleteMany({ userId });
  const reply = await service.importGuest(cookie, input);
  assert.equal(reply.savedTotalChants, 324);
  assert.equal(reply.importedBaseTotal, 250);
  assert.equal(reply.alreadyApplied, true);
  await assert.rejects(service.importGuest(cookie, { ...input, totalChants: 251 }), { code: 'OPERATION_CONFLICT' });
  assert.equal((await service.counter(cookie)).savedTotalChants, 324);
});

test('operation IDs cannot be reused for different cumulative totals', async () => {
  const { service, cookie, snapshot } = await setup();
  const first = snapshot(108);
  await service.sync(cookie, first);
  await assert.rejects(service.sync(cookie, { ...first, totalChants: 216 }), { code: 'OPERATION_CONFLICT' });
  assert.equal((await service.counter(cookie)).savedTotalChants, 108);
});

test('device replacement and logout revoke uploads; epochs prevent cross-account or old-session uploads', async () => {
  const { service, cookie, snapshot, accounts, identity, epoch } = await setup();
  const replacement = await accounts.signIn(identity, null, true);
  assert.notEqual(replacement.profile.counterEpoch, epoch);
  await assert.rejects(service.sync(cookie, snapshot(108)), { status: 401 });
  await assert.rejects(service.sync(replacement.session, snapshot(108)), { code: 'COUNTER_EPOCH_CHANGED' });
  const other = await accounts.signIn({ ...identity, googleSub: 'other-account' }, null, false);
  await assert.rejects(service.sync(other.session, snapshot(108)), { code: 'COUNTER_EPOCH_CHANGED' });
  await accounts.logout(replacement.session);
  await assert.rejects(service.counter(replacement.session), { status: 401 });
});

test('period write failure rolls back lifetime total and every period; a retry succeeds once', async () => {
  const { service, cookie, snapshot, database, userId } = await setup();
  const original = database.db.collection;
  let fail = true;
  database.db.collection = (name) => {
    const collection = original(name);
    const update = collection.updateOne;
    if (name === 'period_totals') collection.updateOne = async (filter, ...args) => {
      if (fail && filter.periodType === 'week') throw new Error('Simulated database failure');
      return update(filter, ...args);
    };
    return collection;
  };
  const input = snapshot(108);
  await assert.rejects(service.sync(cookie, input));
  assert.equal((await service.counter(cookie)).savedTotalChants, 0);
  assert.equal(await database.db.collection('period_totals').findOne({ userId }), null);
  fail = false;
  assert.equal((await service.sync(cookie, input)).newLeaderboardMalas, 1);
});

test('partial checkpoints save lifetime progress without ranking points', async () => {
  const { service, cookie, snapshot, database, userId } = await setup();
  assert.equal((await service.sync(cookie, snapshot(34))).savedTotalChants, 34);
  assert.equal(await database.db.collection('period_totals').findOne({ userId }), null);
  assert.equal((await service.sync(cookie, snapshot(108, 2))).newLeaderboardMalas, 1);
});

test('verified sign-in on the same browser resumes pending progress after logout; another browser gets a new epoch', async () => {
  const { accounts, identity, service } = await setup();
  const deviceId = randomUUID();
  const first = await accounts.signIn(identity, null, true, deviceId);
  await accounts.logout(first.session);
  const resumed = await accounts.signIn(identity, null, false, deviceId);
  assert.equal(resumed.profile.counterEpoch, first.profile.counterEpoch);
  assert.equal((await service.sync(resumed.session, { operationId: randomUUID(), sequence: 1,
    counterEpoch: first.profile.counterEpoch, totalChants: 34, reason: 'reconnect' })).savedTotalChants, 34);
  await accounts.logout(resumed.session);
  const anotherBrowser = await accounts.signIn(identity, null, false, randomUUID());
  assert.notEqual(anotherBrowser.profile.counterEpoch, first.profile.counterEpoch);
});

test('counter HTTP routes validate shape, session, origin and account ownership', async (t) => {
  const setupState = await setup();
  const { service, accounts, identity, snapshot, epoch } = setupState;
  const config = { origin: 'https://counter.test', secure: true, googleClientId: 'client', sessionSecret: 'a'.repeat(64) };
  const app = createApp({ store: accounts, counterService: service, authConfig: () => config, verifyIdentity: async () => identity });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const login = await fetch(`${base}/auth/google`, { method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: 'verified-by-test', replaceSession: true }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const currentEpoch = (await login.json()).profile.counterEpoch;
  const request = (path, body, origin = config.origin) => fetch(`${base}${path}`, {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await fetch(`${base}/counter`)).status, 401);
  for (const change of [{ totalChants: -1 }, { totalChants: '108' }, { sequence: 0 }, { reason: 'fake' }, { operationId: 'not-uuid' }, { userId: 'someone' }]) {
    assert.equal((await request('/counter/sync', { ...snapshot(108), counterEpoch: currentEpoch, ...change })).status, 400);
  }
  assert.equal((await request('/counter/sync', { ...snapshot(108), counterEpoch: currentEpoch }, 'https://attacker.test')).status, 403);
  assert.equal((await request('/counter/sync', { ...snapshot(108), counterEpoch: epoch })).status, 409);
  assert.equal((await request('/me/import-guest', { importId: randomUUID(), totalChants: 250, counterEpoch: currentEpoch })).status, 200);
  const saved = await request('/counter/sync', { ...snapshot(324), counterEpoch: currentEpoch });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.equal((await saved.json()).newLeaderboardMalas, 1);
});
