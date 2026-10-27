import test from 'node:test';
import assert from 'node:assert/strict';
import { cumulativeDelta } from '../src/utils/malaMath.js';
import { istPeriods } from '../src/utils/istPeriods.js';

test('mala boundaries and imported partial mala score only new boundaries', () => {
  assert.equal(cumulativeDelta(107, 108).newLeaderboardMalas, 1);
  assert.equal(cumulativeDelta(0, 216).newLeaderboardMalas, 2);
  assert.equal(cumulativeDelta(250, 324).newLeaderboardMalas, 1);
  assert.equal(cumulativeDelta(324, 358).newLeaderboardMalas, 0);
  assert.equal(cumulativeDelta(358, 432).newLeaderboardMalas, 1);
});

test('replayed and stale totals never decrease progress or score again', () => {
  for (const total of [108, 216, 250, 324]) {
    const result = cumulativeDelta(324, total);
    assert.equal(result.savedTotalChants, 324);
    assert.equal(result.newChants, 0);
    assert.equal(result.newLeaderboardMalas, 0);
  }
});

test('invalid counts cannot enter cumulative math', () => {
  for (const invalid of [-1, 1.2, NaN, Infinity, '108', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => cumulativeDelta(0, invalid));
    assert.throws(() => cumulativeDelta(invalid, 108));
  }
});

test('IST midnight starts Monday week and a new calendar month', () => {
  assert.deepEqual(istPeriods(new Date('2026-05-31T18:29:59.999Z')), {
    day: '2026-05-31', week: '2026-05-25', month: '2026-05',
  });
  assert.deepEqual(istPeriods(new Date('2026-05-31T18:30:00.000Z')), {
    day: '2026-06-01', week: '2026-06-01', month: '2026-06',
  });
});

test('year rollover and leap day use IST calendar dates', () => {
  assert.deepEqual(istPeriods(new Date('2026-12-31T18:30:00Z')), {
    day: '2027-01-01', week: '2026-12-28', month: '2027-01',
  });
  assert.equal(istPeriods(new Date('2028-02-28T18:30:00Z')).day, '2028-02-29');
  assert.throws(() => istPeriods(new Date('invalid')));
});
