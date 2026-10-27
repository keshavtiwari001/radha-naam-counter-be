export function getMongoConfig(env = process.env) {
  if (!env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  return { uri: env.MONGODB_URI, database: env.MONGODB_DB || 'radha_naam_counter' };
}

export function getAuthConfig(env = process.env) {
  let origin;
  try {
    const url = new URL(env.APP_ORIGIN);
    if (url.origin !== env.APP_ORIGIN || !['http:', 'https:'].includes(url.protocol)) throw new Error();
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && (!local || env.NODE_ENV === 'production')) throw new Error();
    origin = url.origin;
  } catch {
    throw new Error('APP_ORIGIN must be an exact HTTPS origin (HTTP localhost is development only)');
  }
  if (!env.GOOGLE_CLIENT_ID || typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) {
    throw new Error('GOOGLE_CLIENT_ID and a SESSION_SECRET of at least 32 characters are required');
  }
  return {
    origin,
    googleClientId: env.GOOGLE_CLIENT_ID,
    sessionSecret: env.SESSION_SECRET,
    secure: origin.startsWith('https:'),
  };
}
