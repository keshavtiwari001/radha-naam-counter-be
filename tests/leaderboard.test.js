import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { memoryDatabase } from './helpers/memoryDatabase.js';
import { createLeaderboardService } from '../src/services/leaderboardService.js';

test('top 100, deterministic ties, private-field exclusion and own rank outside top 100', async () => {
  const database = memoryDatabase();
  const users = database.db.collection('users');
  const totals = database.db.collection('period_totals');
  for (let i = 1; i <= 102; i++) {
    const id = new ObjectId(i.toString(16).padStart(24, '0'));
    await users.insertOne({ _id: id, displayName: `Person ${i}`, email: 'private@example.com', activeSessionId: 'secret' });
    await totals.insertOne({ userId: id, periodType: 'day', periodKey: '2026-10-26', malas: i === 102 ? 0 : 2 });
  }
  const service = createLeaderboardService(async () => database, () => new Date('2026-10-25T18:30:00Z'));
  const result = await service.current('day', (101).toString(16).padStart(24, '0'));
  assert.equal(result.entries.length, 100);
  assert.equal(result.entries[0].displayName, 'Person 1');
  assert.equal(result.ownEntry.rank, 101);
  assert.equal(JSON.stringify(result).includes('private@example.com'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal((await service.current('day', (102).toString(16).padStart(24, '0'))).ownEntry, null);
  assert.equal((await service.current('week')).entries.length, 0);
  await assert.rejects(service.current('year'), { status: 400 });
});

test('IST midnight, Monday and month rollover select only the current period', async () => {
  const database = memoryDatabase();
  let at = new Date('2026-10-31T18:29:59Z');
  const service = createLeaderboardService(async () => database, () => at);
  assert.equal((await service.current('month')).periodKey, '2026-10');
  at = new Date('2026-10-31T18:30:00Z');
  assert.equal((await service.current('month')).periodKey, '2026-11');
  assert.equal((await service.current('day')).periodKey, '2026-11-01');
  assert.equal((await service.current('week')).periodKey, '2026-10-26');
  at = new Date('2026-11-01T18:30:00Z');
  assert.equal((await service.current('week')).periodKey, '2026-11-02');
});
