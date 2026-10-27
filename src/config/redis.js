// Redis is optional. Keep credentials on the backend and bound every request.
export function createRedisTransport(env = process.env, send = fetch, clock = Date.now) {
  let config;
  try {
    const url = new URL(env.UPSTASH_REDIS_REST_URL);
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/'
      && !url.search && !url.hash && env.UPSTASH_REDIS_REST_TOKEN) {
      config = { url: url.origin, token: env.UPSTASH_REDIS_REST_TOKEN };
    }
  } catch { /* Missing/invalid optional configuration uses MongoDB. */ }
  let retryAt = 0;
  return {
    get enabled() { return !!config && clock() >= retryAt; },
    async command(command) {
      if (!config || clock() < retryAt) throw new Error('Ranking cache unavailable');
      try {
        const response = await send(config.url, { method: 'POST',
          headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(command), signal: AbortSignal.timeout(800), cache: 'no-store' });
        const body = await response.json();
        if (!response.ok || body.error || !Object.hasOwn(body, 'result')) throw new Error('Ranking cache unavailable');
        return body.result;
      } catch {
        // Quota/outage failures must not delay every subsequent chant sync.
        retryAt = clock() + 30000;
        throw new Error('Ranking cache unavailable');
      }
    },
  };
}
