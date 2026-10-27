import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const digest = (body, secret) => createHmac('sha256', secret).update(body).digest('base64url');
export const sessionHash = (id) => createHash('sha256').update(id).digest('hex');
export const cookieName = (config) => config.secure ? '__Host-rnjc_session' : 'rnjc_session';

export function newSession(userId, now = Date.now()) {
  return { userId, sessionId: randomBytes(32).toString('base64url'), expiresAt: now + SESSION_TTL_MS };
}

export function encodeSession(session, secret) {
  const body = Buffer.from(JSON.stringify({ ...session, version: 1 })).toString('base64url');
  return `${body}.${digest(body, secret)}`;
}

export function decodeSession(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = Buffer.from(digest(body, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (value.version !== 1 || !/^[a-f0-9]{24}$/.test(value.userId)
      || !/^[A-Za-z0-9_-]{43}$/.test(value.sessionId)
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now
      || value.expiresAt > now + SESSION_TTL_MS) return null;
    return value;
  } catch { return null; }
}

export function readSession(req, config) {
  const name = `${cookieName(config)}=`;
  const cookies = (req.headers.cookie || '').split(';').map((part) => part.trim());
  const matches = cookies.filter((part) => part.startsWith(name));
  if (matches.length !== 1) return null;
  return decodeSession(matches[0].slice(name.length), config.sessionSecret);
}

const options = (config) => ({
  httpOnly: true, secure: config.secure, sameSite: 'lax', path: '/',
});
export function setSessionCookie(res, session, config) {
  res.cookie(cookieName(config), encodeSession(session, config.sessionSecret), {
    ...options(config), expires: new Date(session.expiresAt),
  });
}
export function clearSessionCookie(res, config) {
  res.clearCookie(cookieName(config), options(config));
}
