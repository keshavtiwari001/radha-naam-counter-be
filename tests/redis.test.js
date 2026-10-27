import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createRedisTransport } from '../src/config/redis.js';
import { createLeaderboardCache, periodExpiry, MAX_CACHE_ROWS } from '../src/services/leaderboardCache.js';
import { createLeaderboardService } from '../src/services/leaderboardService.js';
import { createAccountStore } from '../src/services/accountStore.js';
import { createCounterService } from '../src/services/counterService.js';
import { memoryDatabase } from './helpers/memoryDatabase.js';
import { luaRedis } from './helpers/luaRedis.js';

const date = new Date('2026-10-26T06:00:00Z');
const id = (n) => n.toString(16).padStart(24, '0');
const period = (malas, periodType = 'day', periodKey = '2026-10-26') => ({ malas, periodType, periodKey });

test('production Lua preserves top 100/own rank, ascending ID ties, absolute scores and expirations', async () => {
  const redis = luaRedis(date.getTime()); const cache = createLeaderboardCache(redis.transport);
  const rows = Array.from({ length: 101 }, (_, index) => ({ userId: id(index + 1), malas: 2 }));
  assert.equal(await cache.rebuild('day', '2026-10-26', async () => rows), true);
  const result = await cache.read('day', '2026-10-26', id(101));
  assert.equal(result.entries.length, 100);
  assert.equal(result.entries[0].userId, id(1));
  assert.equal(result.ownEntry.rank, 101);
  assert.equal((await cache.read('day', '2026-10-26', id(102))).ownEntry, null);
  await cache.update(id(101), [period(5)]);
  await cache.update(id(101), [period(3)]);
  await cache.update(id(101), [period(5)]);
  assert.equal((await cache.read('day', '2026-10-26', id(101))).entries[0].malas, 5);
  const dataKey = [...redis.data.keys()].find((key) => key.endsWith('day:2026-10-26'));
  assert.equal(redis.read(dataKey).expiresAt, periodExpiry('day', '2026-10-26') * 1000);
  redis.advance(59000);
  await cache.update(id(101), [period(6)]);
  redis.advance(1001);
  assert.equal(await cache.read('day', '2026-10-26', id(101)), null);
  assert.ok(redis.read(dataKey));
  assert.equal(periodExpiry('week', '2026-10-26') - periodExpiry('day', '2026-10-26'), 50 * 86400);
  assert.equal(periodExpiry('month', '2026-10'), Date.parse('2026-10-01T00:00:00+05:30') / 1000 + 400 * 86400);
});

test('stale rebuild cannot replace a new score, and deletion blocks delayed seeds/writes', async () => {
  const redis = luaRedis(date.getTime()); const cache = createLeaderboardCache(redis.transport);
  const rows = [{ userId: id(1), malas: 1 }];
  await cache.rebuild('day', '2026-10-26', async () => rows);
  assert.equal(await cache.rebuild('day', '2026-10-26', async () => {
    await cache.update(id(1), [period(9)]); return rows;
  }), false);
  assert.equal((await cache.read('day', '2026-10-26', id(1))).ownEntry.malas, 9);
  assert.equal(await cache.rebuild('day', '2026-10-26', async () => {
    await cache.remove(id(1), [period(0)]); return rows;
  }), false);
  await cache.update(id(1), [period(99)]);
  assert.equal((await cache.read('day', '2026-10-26', id(1))).ownEntry, null);
  assert.equal(await cache.rebuild('day', '2026-10-26', async () => rows), true);
  assert.deepEqual((await cache.read('day', '2026-10-26', id(1))).entries, []);
});

test('cold caches, partial eviction, empty periods, competing rebuilds and size cap remain safe', async () => {
  const redis = luaRedis(date.getTime()); const cache = createLeaderboardCache(redis.transport);
  await cache.update(id(1), [period(2)]);
  assert.equal(await cache.read('day', '2026-10-26', id(1)), null);
  await cache.rebuild('day', '2026-10-26', async () => [{ userId: id(1), malas: 2 }]);
  const key = [...redis.data.keys()].find((key) => key.endsWith('day:2026-10-26'));
  redis.data.delete(key);
  assert.equal(await cache.read('day', '2026-10-26', id(1)), null);
  await cache.update(id(2), [period(1)]);
  assert.equal(await cache.read('day', '2026-10-26', id(2)), null);
  assert.equal(await cache.rebuild('day', '2026-10-26', async () => {
    await cache.rebuild('day', '2026-10-26', async () => [{ userId: id(1), malas: 8 }]);
    return [{ userId: id(1), malas: 2 }];
  }), false);
  assert.equal((await cache.read('day', '2026-10-26', id(1))).ownEntry.malas, 8);
  await cache.rebuild('month', '2026-11', async () => []);
  assert.deepEqual(await cache.read('month', '2026-11'), { entries: [], ownEntry: null });
  assert.equal(await cache.rebuild('day', '2026-10-26', async () => Array(MAX_CACHE_ROWS + 1).fill({ userId: id(1), malas: 1 })), false);
});

test('an expired staging set cannot publish an empty replacement', async () => {
  const redis = luaRedis(date.getTime());
  const original = redis.transport.command;
  const transport = { enabled: true, async command(command) {
    // Advance after actual seed Lua runs, before the publication CAS.
    const result = await original(command);
    if (command[1].includes("redis.call('EXPIRE', KEYS[1], 60)")) redis.advance(60001);
    return result;
  } };
  const cache = createLeaderboardCache(transport);
  assert.equal(await cache.rebuild('day', '2026-10-26', async () => [{ userId: id(1), malas: 4 }]), false);
  assert.equal(await cache.read('day', '2026-10-26', id(1)), null);
});

test('sync and deletion integrate with actual cache Lua across all three periods', async () => {
  const database = memoryDatabase(); const connect = async () => database;
  const redis = luaRedis(date.getTime()); const cache = createLeaderboardCache(redis.transport);
  const accounts = createAccountStore(connect, cache);
  const user = await accounts.signIn({ googleSub: 'integrated', email: 'private@test', displayName: 'Name', photoUrl: null }, null, false);
  const counter = createCounterService(connect, () => date, cache);
  await counter.sync(user.session, { counterEpoch: user.profile.counterEpoch, operationId: 'sync', sequence: 1, totalChants: 324 });
  const rankings = createLeaderboardService(connect, () => date, cache);
  for (const type of ['day', 'week', 'month']) {
    assert.equal((await rankings.current(type, user.profile.id)).ownEntry.malas, 3);
  }
  await accounts.deleteAccount(user.session);
  for (const type of ['day', 'week', 'month']) assert.deepEqual((await rankings.current(type)).entries, []);
  await cache.update(user.profile.id, [period(100)]);
  assert.equal((await cache.read('day', '2026-10-26', user.profile.id)).ownEntry, null);
});

test('Redis hits match MongoDB, resolve current public profiles and fall back on outage/malformed/deleted rows', async () => {
  const database = memoryDatabase(); const connect = async () => database;
  const redis = luaRedis(date.getTime()); const cache = createLeaderboardCache(redis.transport);
  await database.db.collection('users').insertOne({ _id: new ObjectId(id(1)), displayName: 'Name', email: 'private@test', photoUrl: 'https://lh3.googleusercontent.com/photo' });
  await database.db.collection('period_totals').insertOne({ userId: new ObjectId(id(1)), ...period(3) });
  const mongo = createLeaderboardService(connect, () => date, { enabled: false });
  const service = createLeaderboardService(connect, () => date, cache);
  assert.deepEqual(await service.current('day', id(1)), await mongo.current('day', id(1)));
  assert.deepEqual(await service.current('day', id(1)), await mongo.current('day', id(1)));
  await database.db.collection('users').updateOne({ _id: new ObjectId(id(1)) }, { $set: { displayName: 'Renamed' } });
  assert.equal((await service.current('day')).entries[0].displayName, 'Renamed');
  const failing = createLeaderboardService(connect, () => date, { enabled: true, read: async () => { throw new Error('Quota'); } });
  assert.deepEqual(await failing.current('day'), await mongo.current('day'));
  const corrupt = createLeaderboardCache({ enabled: true, command: async () => [['bad-id', '-4'], -1, '0'] });
  assert.deepEqual(await createLeaderboardService(connect, () => date, corrupt).current('day'), await mongo.current('day'));
  await database.db.collection('users').deleteMany({ _id: new ObjectId(id(1)) });
  await database.db.collection('period_totals').deleteMany({ userId: new ObjectId(id(1)) });
  assert.deepEqual((await service.current('day')).entries, []);
});

test('committed sync repairs absolute cache scores on retry; cache failure cannot reject save or deletion', async () => {
  const database = memoryDatabase(); const connect = async () => database;
  const identity = { googleSub: 'cache-test', email: 'private@test', displayName: 'Devotee', photoUrl: null };
  let fail = true; const writes = [];
  const cache = { enabled: true,
    async update(user, periods) { if (fail) throw new Error('Quota'); writes.push({ user, periods }); },
    async remove(user) { assert.equal(await database.db.collection('users').findOne({ _id: new ObjectId(user) }), null); throw new Error('Offline'); },
  };
  const store = createAccountStore(connect, cache); const account = await store.signIn(identity, null, false);
  const counter = createCounterService(connect, () => date, cache);
  const input = { counterEpoch: account.profile.counterEpoch, operationId: 'first', sequence: 1, totalChants: 216 };
  assert.equal((await counter.sync(account.session, input)).savedTotalChants, 216);
  fail = false;
  assert.equal((await counter.sync(account.session, input)).alreadyApplied, true);
  assert.deepEqual(writes[0].periods.map((p) => p.malas), [2, 2, 2]);
  await store.deleteAccount(account.session);
  assert.equal(await database.db.collection('users').findOne({ _id: new ObjectId(account.profile.id) }), null);
});

test('REST transport keeps secrets server-side and opens a circuit on quota or timeout failures', async () => {
  let now = 0; let calls = 0;
  const transport = createRedisTransport({ UPSTASH_REDIS_REST_URL: 'https://cache.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'private-token' },
    async (url, options) => {
      calls++; assert.equal(url, 'https://cache.upstash.io');
      assert.equal(options.headers.Authorization, 'Bearer private-token');
      assert.ok(options.signal); return { ok: false, json: async () => ({ error: 'Quota' }) };
    }, () => now);
  assert.equal(transport.enabled, true);
  await assert.rejects(transport.command(['GET', 'key']), /Ranking cache unavailable/);
  assert.equal(transport.enabled, false);
  await assert.rejects(transport.command(['GET', 'key']));
  assert.equal(calls, 1); now = 30000; assert.equal(transport.enabled, true);
  assert.equal(createRedisTransport({}).enabled, false);
  assert.equal(createRedisTransport({ UPSTASH_REDIS_REST_URL: 'http://cache', UPSTASH_REDIS_REST_TOKEN: 'token' }).enabled, false);
  const success = createRedisTransport({ UPSTASH_REDIS_REST_URL: 'https://cache.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'token' },
    async () => ({ ok: true, json: async () => ({ result: 42 }) }));
  assert.equal(await success.command(['GET', 'key']), 42);
  const timeout = createRedisTransport({ UPSTASH_REDIS_REST_URL: 'https://cache.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'secret' },
    async () => { throw new Error('secret provider message'); });
  await assert.rejects(timeout.command(['GET', 'key']), { message: 'Ranking cache unavailable' });
  assert.equal(timeout.enabled, false);
});

test('cached periods switch at IST month rollover without leaking the previous period', async () => {
  const database = memoryDatabase(); const redis = luaRedis(date.getTime());
  const cache = createLeaderboardCache(redis.transport);
  await database.db.collection('users').insertOne({ _id: new ObjectId(id(1)), displayName: 'Name' });
  await database.db.collection('period_totals').insertOne({ userId: new ObjectId(id(1)), ...period(2, 'month', '2026-10') });
  let at = new Date('2026-10-31T18:29:59Z');
  const service = createLeaderboardService(async () => database, () => at, cache);
  assert.equal((await service.current('month')).entries.length, 1);
  at = new Date('2026-10-31T18:30:00Z');
  assert.equal((await service.current('month')).periodKey, '2026-11');
  assert.deepEqual((await service.current('month')).entries, []);
});

test('failed MongoDB transactions never write ranking caches', async () => {
  const database = memoryDatabase(); const connect = async () => database;
  const account = await createAccountStore(connect, { enabled: false }).signIn({ googleSub: 'rollback-cache', displayName: 'Name', email: 'private@test', photoUrl: null }, null, false);
  const original = database.db.collection.bind(database.db);
  database.db.collection = (name) => {
    const collection = original(name);
    if (name === 'period_totals') collection.updateOne = async () => { throw new Error('Write interrupted'); };
    return collection;
  };
  const counter = createCounterService(connect, () => date, { enabled: true, update: async () => assert.fail('Cache must wait for commit') });
  await assert.rejects(counter.sync(account.session, { counterEpoch: account.profile.counterEpoch, operationId: 'rollback', sequence: 1, totalChants: 108 }), /Write interrupted/);
  assert.equal((await counter.counter(account.session)).savedTotalChants, 0);
});
