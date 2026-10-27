import { ObjectId } from 'mongodb';
import { getDatabase } from '../config/mongo.js';
import { collections } from '../models/index.js';
import { sessionHash } from './session.js';
import { cumulativeDelta } from '../utils/malaMath.js';
import { istPeriods } from '../utils/istPeriods.js';
import { HttpError } from '../utils/httpError.js';
import { leaderboardCache } from './leaderboardCache.js';

export function createCounterService(connect = getDatabase, clock = () => new Date(), cache = leaderboardCache) {
  async function transact(cookie, epoch, action) {
    if (!cookie) throw new HttpError(401, 'Please sign in to save progress.', 'SESSION_REQUIRED');
    const { client, db } = await connect();
    // The counter document is also written by logout and device replacement.
    // Concurrent ownership changes cause a transaction conflict and revalidation.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await client.withSession((session) => session.withTransaction(async () => {
          const store = collections(db);
          const userId = new ObjectId(cookie.userId);
          const hash = sessionHash(cookie.sessionId);
          const now = clock();
          const user = await store.users.findOne({ _id: userId, activeSessionId: hash,
            activeSessionExpiresAt: { $gt: now } }, { session });
          const state = await store.counterStates.findOne({ userId, activeSessionId: hash }, { session });
          if (!user || !state) throw new HttpError(401, 'Your session ended. Sign in again to save progress.', 'SESSION_REVOKED');
          if (epoch && state.counterEpoch !== epoch) {
            throw new HttpError(409, 'This progress belongs to an earlier account session.', 'COUNTER_EPOCH_CHANGED');
          }
          return action({ store, state, userId, session, now });
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }));
      } catch (error) {
        // An insert may race a newly created period or operation. Retry the
        // entire transaction against fresh state; never retry just an increment.
        if (error.code !== 11000 || attempt === 2) throw error;
      }
    }
  }
  const counterResult = (state) => ({ savedTotalChants: state.totalChants,
    completedLifetimeMalas: Math.floor(state.totalChants / 108), remainder: state.totalChants % 108,
    counterEpoch: state.counterEpoch });

  return {
    counter(cookie) { return transact(cookie, null, async ({ state }) => counterResult(state)); },
    importGuest(cookie, input) {
      return transact(cookie, input.counterEpoch, async ({ store, state, userId, session, now }) => {
        const receipt = (state.guestImports || []).find((item) => item.importId === input.importId);
        if (receipt) {
          if (receipt.totalChants !== input.totalChants) throw new HttpError(409, 'Guest import ID was reused with different progress.', 'OPERATION_CONFLICT');
          return { ...counterResult(state), importedBaseTotal: receipt.acceptedTotalChants, alreadyApplied: true };
        }
        // Older deployed records may have only importedGuestIds. Fail closed
        // rather than import them twice without a recoverable durable receipt.
        if ((state.importedGuestIds || []).includes(input.importId)) {
          throw new HttpError(409, 'This guest progress was already imported.', 'IMPORT_RECEIPT_MISSING');
        }
        if (await store.syncOperations.findOne({ userId, operationId: input.importId }, { session })) {
          throw new HttpError(409, 'Import ID was already used by another operation.', 'OPERATION_CONFLICT');
        }
        const total = state.totalChants + input.totalChants;
        if (!Number.isSafeInteger(total)) throw new HttpError(400, 'Chant total exceeds the supported range.', 'INVALID_INPUT');
        const next = { ...state, totalChants: total };
        const importReceipt = { importId: input.importId, totalChants: input.totalChants,
          acceptedTotalChants: total, counterEpoch: state.counterEpoch };
        await store.counterStates.updateOne({ userId }, {
          $set: { totalChants: total, updatedAt: now, lastSyncedAt: now },
          $addToSet: { importedGuestIds: input.importId }, $push: { guestImports: importReceipt },
        }, { session });
        await store.syncOperations.insertOne({ userId, operationId: input.importId, kind: 'guest_import',
          acceptedTotalChants: total, awardedMalas: 0, receivedAt: now,
          expireAt: new Date(now.getTime() + 7 * 86400000) }, { session });
        // No period_totals writes: historical guest dates are unknown.
        return { ...counterResult(next), importedBaseTotal: total, alreadyApplied: false };
      });
    },
    async sync(cookie, input) {
      const result = await transact(cookie, input.counterEpoch, async ({ store, state, userId, session, now }) => {
        const previous = await store.syncOperations.findOne({ userId, operationId: input.operationId }, { session });
        if (previous) {
          if (previous.kind !== 'counter_sync' || previous.incomingTotalChants !== input.totalChants
            || previous.sequence !== input.sequence || previous.counterEpoch !== input.counterEpoch) {
            throw new HttpError(409, 'Operation ID was reused with different progress.', 'OPERATION_CONFLICT');
          }
          return { ...previous.result, alreadyApplied: true };
        }
        const delta = cumulativeDelta(state.totalChants, input.totalChants);
        const periods = istPeriods(now);
        const result = { ...counterResult({ ...state, totalChants: delta.savedTotalChants }),
          newLeaderboardMalas: delta.newLeaderboardMalas, creditedPeriod: periods.day, alreadyApplied: false };
        await store.counterStates.updateOne({ userId }, { $set: {
          totalChants: delta.savedTotalChants, lastSequence: Math.max(state.lastSequence || 0, input.sequence),
          updatedAt: now, lastSyncedAt: now,
        } }, { session });
        if (delta.newLeaderboardMalas > 0) {
          for (const periodType of ['day', 'week', 'month']) {
            await store.periodTotals.updateOne({ userId, periodType, periodKey: periods[periodType] }, {
              $inc: { malas: delta.newLeaderboardMalas }, $set: { updatedAt: now },
            }, { upsert: true, session });
          }
        }
        await store.syncOperations.insertOne({ userId, operationId: input.operationId, kind: 'counter_sync',
          counterEpoch: input.counterEpoch, sequence: input.sequence, incomingTotalChants: input.totalChants,
          acceptedTotalChants: delta.savedTotalChants, awardedMalas: delta.newLeaderboardMalas, result,
          receivedAt: now, expireAt: new Date(now.getTime() + 7 * 86400000) }, { session });
        return result;
      });
      // Only committed, authoritative absolute period totals reach Redis. A
      // duplicate operation can repair a previously failed cache update safely.
      if (cache.enabled && result.newLeaderboardMalas > 0) {
        try {
          const { db } = await connect();
          const periods = istPeriods(new Date(`${result.creditedPeriod}T00:00:00+05:30`));
          const rows = await Promise.all(['day', 'week', 'month'].map((periodType) =>
            collections(db).periodTotals.findOne({ userId: new ObjectId(cookie.userId), periodType, periodKey: periods[periodType] })));
          await cache.update(cookie.userId, rows.filter(Boolean));
        } catch { /* A cache failure never rolls back or rejects saved chants. */ }
      }
      return result;
    },
  };
}
