import { ObjectId } from 'mongodb';
import { getDatabase } from '../config/mongo.js';
import { collections } from '../models/index.js';
import { istPeriods } from '../utils/istPeriods.js';
import { HttpError } from '../utils/httpError.js';
import { leaderboardCache } from './leaderboardCache.js';

export function createLeaderboardService(connect = getDatabase, clock = () => new Date(), cache = leaderboardCache) {
  return {
    async current(periodType, userId = null) {
      if (!['day', 'week', 'month'].includes(periodType)) {
        throw new HttpError(400, 'Choose day, week or month.', 'INVALID_INPUT');
      }
      const now = clock();
      const periodKey = istPeriods(now)[periodType];
      const { client, db } = await connect();
      if (cache.enabled) {
        try {
          let cached = await cache.read(periodType, periodKey, userId);
          if (!cached) {
            await cache.rebuild(periodType, periodKey, (limit) => client.withSession((session) =>
              session.withTransaction(async () => {
                const rows = await collections(db).periodTotals.find({ periodType, periodKey, malas: { $gt: 0 } },
                  { session, projection: { userId: 1, malas: 1 } }).limit(limit).toArray();
                return rows.map((row) => ({ userId: row.userId.toString(), malas: row.malas }));
              }, { readConcern: { level: 'snapshot' } })));
            cached = await cache.read(periodType, periodKey, userId);
          }
          if (cached) {
            const entries = [...cached.entries, ...(cached.ownEntry ? [cached.ownEntry] : [])];
            const profiles = entries.length ? await collections(db).users.find({
              _id: { $in: entries.map((row) => new ObjectId(row.userId)) },
            }, { projection: { displayName: 1, photoUrl: 1 } }).toArray() : [];
            const names = new Map(profiles.map((user) => [user._id.toString(), user]));
            // Never display a deleted user's cached identity or a placeholder.
            // On an interrupted deletion/cache update, read the DB instead.
            if (entries.some((row) => !names.has(row.userId))) throw new Error('Stale ranking cache');
            const entry = (row) => ({ ...row, displayName: names.get(row.userId).displayName,
              photoUrl: names.get(row.userId).photoUrl || null });
            return { periodType, periodKey, asOf: now.toISOString(), entries: cached.entries.map(entry),
              ownEntry: cached.ownEntry ? entry(cached.ownEntry) : null };
          }
        } catch { /* Missing, malformed, over-quota or failed Redis uses MongoDB. */ }
      }
      // One snapshot keeps the top list and the caller's rank consistent while
      // new chanting transactions arrive. Equal scores use ascending ObjectId.
      return client.withSession((session) => session.withTransaction(async () => {
        const { periodTotals, users } = collections(db);
        const filter = { periodType, periodKey, malas: { $gt: 0 } };
        const top = await periodTotals.find(filter, { session })
          .sort({ malas: -1, userId: 1 }).limit(100).toArray();
        const own = userId ? await periodTotals.findOne({ ...filter, userId: new ObjectId(userId) }, { session }) : null;
        const ownRank = own ? 1 + await periodTotals.countDocuments({ periodType, periodKey,
          $or: [{ malas: { $gt: own.malas } }, { malas: own.malas, userId: { $lt: own.userId } }],
        }, { session }) : null;
        const ids = [...top.map((row) => row.userId), ...(own ? [own.userId] : [])];
        const profiles = ids.length ? await users.find({ _id: { $in: ids } }, {
          session, projection: { displayName: 1, photoUrl: 1 },
        }).toArray() : [];
        const names = new Map(profiles.map((user) => [user._id.toString(), user]));
        const entry = (row, rank) => ({ rank, userId: row.userId.toString(), malas: row.malas,
          displayName: names.get(row.userId.toString())?.displayName || 'Devotee',
          photoUrl: names.get(row.userId.toString())?.photoUrl || null });
        return { periodType, periodKey, asOf: now.toISOString(),
          entries: top.map((row, index) => entry(row, index + 1)),
          ownEntry: own ? entry(own, ownRank) : null };
      }, { readConcern: { level: 'snapshot' } }));
    },
  };
}
