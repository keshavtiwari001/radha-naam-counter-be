import { randomUUID } from 'node:crypto';
import { createRedisTransport } from '../config/redis.js';

const PREFIX = '{rnjc:lb}:v1:';
const REVISION = `${PREFIX}revision`;
const DAY = 86400;
export const MAX_CACHE_ROWS = 2000;
export const CACHE_FRESH_SECONDS = 60;
export function periodExpiry(type, key) {
  const days = { day: 40, week: 90, month: 400 }[type];
  if (!days || !(type === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(key)) throw new Error('Invalid cache period');
  return Date.parse(`${key}${type === 'month' ? '-01' : ''}T00:00:00+05:30`) / 1000 + days * DAY;
}
const keysFor = (type, key) => [`${PREFIX}${type}:${key}`, `${PREFIX}${type}:${key}:ready`];
const deletedKey = (id) => `${PREFIX}deleted:${id}`;

// Scripts use one hash slot. Only IDs and scores enter Redis, never profiles.
export const scripts = {
  revision: `
    redis.call('SET', KEYS[1], ARGV[1], 'NX')
    return redis.call('GET', KEYS[1])`,
  read: `
    local count = redis.call('GET', KEYS[2])
    if not count or tonumber(count) ~= redis.call('ZCARD', KEYS[1]) then return false end
    local top = redis.call('ZRANGE', KEYS[1], 0, 99, 'WITHSCORES')
    local rank = false
    local score = false
    if ARGV[1] ~= '' then
      rank = redis.call('ZRANK', KEYS[1], ARGV[1])
      score = redis.call('ZSCORE', KEYS[1], ARGV[1])
    end
    return {top, rank or -1, score or '0'}`,
  seed: `
    for i = 2, #KEYS do
      if redis.call('EXISTS', KEYS[i]) == 0 then
        redis.call('ZADD', KEYS[1], 'LT', ARGV[(i-2)*2+2], ARGV[(i-2)*2+1])
      end
    end
    redis.call('EXPIRE', KEYS[1], 60)
    return redis.call('ZCARD', KEYS[1])`,
  publish: `
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
    if redis.call('ZCARD', KEYS[2]) ~= tonumber(ARGV[5]) then return 0 end
    if redis.call('EXISTS', KEYS[2]) == 1 then
      redis.call('RENAME', KEYS[2], KEYS[3])
      redis.call('EXPIREAT', KEYS[3], ARGV[3])
    else
      redis.call('DEL', KEYS[3])
    end
    redis.call('SET', KEYS[4], tostring(redis.call('ZCARD', KEYS[3])), 'EX', ARGV[4])
    redis.call('SET', KEYS[1], ARGV[2])
    return 1`,
  update: `
    if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
    redis.call('SET', KEYS[1], ARGV[1])
    for i = 3, #KEYS, 2 do
      local index = (i-3)+3
      if tonumber(ARGV[index]) < 0 then
        local ready = redis.call('GET', KEYS[i+1])
        local complete = ready and tonumber(ready) == redis.call('ZCARD', KEYS[i])
        if ready and not complete then redis.call('DEL', KEYS[i+1]) end
        redis.call('ZADD', KEYS[i], 'LT', ARGV[index], ARGV[2])
        redis.call('EXPIREAT', KEYS[i], ARGV[index+1])
        if complete then
          redis.call('SET', KEYS[i+1], tostring(redis.call('ZCARD', KEYS[i])), 'XX', 'KEEPTTL')
        end
      end
    end
    return 1`,
  remove: `
    redis.call('SET', KEYS[2], '1', 'EX', 34646400)
    redis.call('SET', KEYS[1], ARGV[1])
    for i = 3, #KEYS, 2 do
      local ready = redis.call('GET', KEYS[i+1])
      local complete = ready and tonumber(ready) == redis.call('ZCARD', KEYS[i])
      if ready and not complete then redis.call('DEL', KEYS[i+1]) end
      redis.call('ZREM', KEYS[i], ARGV[2])
      if complete then
        redis.call('SET', KEYS[i+1], tostring(redis.call('ZCARD', KEYS[i])), 'XX', 'KEEPTTL')
      end
    end
    return 1`,
};

export function createLeaderboardCache(transport = createRedisTransport()) {
  const evalScript = (script, keys, args = []) => transport.command(['EVAL', script, keys.length, ...keys, ...args.map(String)]);
  const validId = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);
  const score = (value) => Number.isSafeInteger(value) && value > 0;
  return {
    get enabled() { return transport.enabled; },
    async read(type, period, userId) {
      const raw = await evalScript(scripts.read, keysFor(type, period), [userId || '']);
      if (raw === null || raw === false) return null;
      if (!Array.isArray(raw) || raw.length !== 3 || !Array.isArray(raw[0]) || raw[0].length % 2 || raw[0].length > 200) throw new Error('Invalid cached rankings');
      const entries = [];
      for (let i = 0; i < raw[0].length; i += 2) {
        const malas = -Number(raw[0][i+1]);
        if (!validId(raw[0][i]) || !score(malas)) throw new Error('Invalid cached score');
        entries.push({ userId: raw[0][i], malas, rank: i / 2 + 1 });
      }
      const rank = Number(raw[1]);
      if (!Number.isSafeInteger(rank) || rank < -1 || (rank >= 0 && (!validId(userId) || !score(-Number(raw[2]))))) throw new Error('Invalid cached rank');
      return { entries, ownEntry: rank < 0 ? null : { userId, malas: -Number(raw[2]), rank: rank + 1 } };
    },
    async rebuild(type, period, load) {
      const revision = await evalScript(scripts.revision, [REVISION], [randomUUID()]);
      const rows = await load(MAX_CACHE_ROWS + 1);
      if (rows.length > MAX_CACHE_ROWS) return false;
      const temporary = `${keysFor(type, period)[0]}:build:${randomUUID()}`;
      let count = 0;
      for (let offset = 0; offset < rows.length; offset += 500) {
        const chunk = rows.slice(offset, offset + 500);
        const args = [];
        for (const row of chunk) {
          if (!validId(row.userId) || !score(row.malas)) throw new Error('Invalid seed score');
          args.push(row.userId, -row.malas);
        }
        count = await evalScript(scripts.seed, [temporary, ...chunk.map((row) => deletedKey(row.userId))], args);
      }
      return !!await evalScript(scripts.publish, [REVISION, temporary, ...keysFor(type, period)],
        [revision, randomUUID(), periodExpiry(type, period), CACHE_FRESH_SECONDS, count]);
    },
    async update(userId, periods) {
      const keys = [REVISION, deletedKey(userId)];
      const args = [randomUUID(), userId];
      for (const period of periods) {
        if (!score(period.malas)) continue;
        keys.push(...keysFor(period.periodType, period.periodKey));
        args.push(-period.malas, periodExpiry(period.periodType, period.periodKey));
      }
      if (keys.length > 2) await evalScript(scripts.update, keys, args);
    },
    async remove(userId, periods) {
      const unique = new Map(periods.map((p) => [`${p.periodType}:${p.periodKey}`, p]));
      const keys = [REVISION, deletedKey(userId)];
      for (const period of unique.values()) keys.push(...keysFor(period.periodType, period.periodKey));
      await evalScript(scripts.remove, keys, [randomUUID(), userId]);
    },
  };
}

export const leaderboardCache = createLeaderboardCache();
