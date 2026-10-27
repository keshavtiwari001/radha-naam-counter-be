import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../config/mongo.js';
import { collections } from '../models/index.js';
import { newSession, sessionHash } from './session.js';
import { HttpError } from '../utils/httpError.js';
import { leaderboardCache, periodExpiry } from './leaderboardCache.js';
import { istPeriods } from '../utils/istPeriods.js';

export function privateProfile(user, counter) {
  return {
    id: user._id.toHexString(), displayName: user.displayName,
    photoUrl: user.photoUrl, email: user.email,
    totalChants: counter?.totalChants ?? 0,
    completedLifetimeMalas: Math.floor((counter?.totalChants ?? 0) / 108),
    counterEpoch: counter?.counterEpoch,
  };
}

// Injecting the database connector allows HTTP tests to stay independent of Atlas.
export function createAccountStore(connect = getDatabase, cache = leaderboardCache) {
  async function transaction(callback) {
    const { client, db } = await connect();
    return client.withSession((session) => session.withTransaction(
      () => callback(collections(db), session),
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    ));
  }

  async function current(store, cookie, session) {
    if (!cookie) throw new HttpError(401, 'Please sign in to continue.', 'SESSION_REQUIRED');
    const user = await store.users.findOne({
      _id: new ObjectId(cookie.userId), activeSessionId: sessionHash(cookie.sessionId),
      activeSessionExpiresAt: { $gt: new Date() },
    }, { session });
    if (!user) throw new HttpError(401, 'Your session ended. Please sign in again.', 'SESSION_REVOKED');
    return user;
  }

  return {
    async signIn(identity, cookie, replaceSession, deviceId) {
      // A unique googleSub index resolves simultaneous first registrations.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await transaction(async (store, session) => {
            const now = new Date();
            let user = await store.users.findOne({ googleSub: identity.googleSub }, { session });
            if (!user) {
              user = { _id: new ObjectId(), ...identity, createdAt: now, updatedAt: now };
              await store.users.insertOne(user, { session });
            }
            const sameDevice = cookie && cookie.userId === user._id.toHexString()
              && user.activeSessionId === sessionHash(cookie.sessionId);
            if (user.activeSessionId && user.activeSessionExpiresAt > now && !sameDevice && !replaceSession) {
              throw new HttpError(409, 'This account is signed in on another device.', 'ACTIVE_DEVICE_EXISTS');
            }
            const login = newSession(user._id.toHexString(), now.getTime());
            const activeSessionId = sessionHash(login.sessionId);
            const existingCounter = await store.counterStates.findOne({ userId: user._id }, { session });
            // A public browser ID permits resuming this browser's queue after
            // logout/expiry, but never authenticates a request or bypasses an
            // existing active-device conflict. A different browser gets a new epoch.
            const active = user.activeSessionId && user.activeSessionExpiresAt > now;
            const continuing = sameDevice || (!active && deviceId && existingCounter?.deviceId === deviceId);
            const counterEpoch = continuing && existingCounter?.counterEpoch
              ? existingCounter.counterEpoch : randomUUID();
            await store.users.updateOne({ _id: user._id }, { $set: {
              email: identity.email, photoUrl: identity.photoUrl, activeSessionId,
              activeSessionExpiresAt: new Date(login.expiresAt), updatedAt: now,
            } }, { session });
            await store.counterStates.updateOne({ userId: user._id }, {
              $set: { activeSessionId, counterEpoch,
                ...(deviceId ? { deviceId } : {}),
                lastSequence: continuing ? (existingCounter?.lastSequence || 0) : 0, updatedAt: now },
              $setOnInsert: { totalChants: 0, importedGuestIds: [], lastSyncedAt: null },
            }, { upsert: true, session });
            const counter = await store.counterStates.findOne({ userId: user._id }, { session });
            return { session: login, profile: privateProfile({ ...user, email: identity.email, photoUrl: identity.photoUrl }, counter) };
          });
        } catch (error) {
          if (error.code !== 11000 || attempt === 2) throw error;
        }
      }
    },
    async profile(cookie) {
      return transaction(async (store, session) => {
        const user = await current(store, cookie, session);
        const counter = await store.counterStates.findOne({ userId: user._id }, { session });
        // Upgrade an already-signed-in account from the previous app version.
        if (counter && !counter.counterEpoch) {
          counter.counterEpoch = randomUUID();
          await store.counterStates.updateOne({ userId: user._id }, { $set: { counterEpoch: counter.counterEpoch } }, { session });
        }
        return privateProfile(user, counter);
      });
    },
    async rename(cookie, displayName) {
      return transaction(async (store, session) => {
        const user = await current(store, cookie, session);
        await store.users.updateOne({ _id: user._id, activeSessionId: sessionHash(cookie.sessionId) },
          { $set: { displayName, updatedAt: new Date() } }, { session });
        const counter = await store.counterStates.findOne({ userId: user._id }, { session });
        return privateProfile({ ...user, displayName }, counter);
      });
    },
    async deleteAccount(cookie) {
      if (!cookie) throw new HttpError(401, 'Please sign in to delete your account.', 'SESSION_REQUIRED');
      const removedPeriods = await transaction(async (store, session) => {
        const userId = new ObjectId(cookie.userId);
        const user = await store.users.findOne({ _id: userId }, { session });
        // A signed, unexpired cookie may retry after the committed reply was lost.
        if (!user) return [];
        await current(store, cookie, session);
        const periods = await store.periodTotals.find({ userId }, { session }).toArray();
        // Deleting this document conflicts with concurrent sync/logout/device
        // replacement transactions, which then revalidate the active session.
        await store.counterStates.deleteMany({ userId }, { session });
        await store.periodTotals.deleteMany({ userId }, { session });
        await store.syncOperations.deleteMany({ userId }, { session });
        await store.users.deleteMany({ _id: userId }, { session });
        return periods;
      });
      if (cache.enabled) {
        try {
          const periods = istPeriods();
          const live = removedPeriods.filter((p) => periodExpiry(p.periodType, p.periodKey) > Date.now() / 1000);
          await cache.remove(cookie.userId, [...live, ...Object.entries(periods).map(([periodType, periodKey]) => ({ periodType, periodKey }))]);
        } catch { /* MongoDB deletion is permanent even if Redis is unavailable. */ }
      }
    },
    async logout(cookie) {
      if (!cookie) return;
      await transaction(async (store, session) => {
        const filter = { _id: new ObjectId(cookie.userId), activeSessionId: sessionHash(cookie.sessionId) };
        await store.users.updateOne(filter, { $unset: { activeSessionId: '', activeSessionExpiresAt: '' },
          $set: { updatedAt: new Date() } }, { session });
        await store.counterStates.updateOne({ userId: filter._id, activeSessionId: filter.activeSessionId },
          { $unset: { activeSessionId: '' }, $set: { updatedAt: new Date() } }, { session });
      });
    },
  };
}
