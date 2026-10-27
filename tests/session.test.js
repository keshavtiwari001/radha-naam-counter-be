import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuthConfig } from '../src/config/env.js';
import { newSession, encodeSession, decodeSession, sessionHash, readSession, SESSION_TTL_MS } from '../src/services/session.js';
import { identityFromPayload, googlePhoto } from '../src/services/googleIdentity.js';

const secret = 'a'.repeat(64);
const now = Date.now();

test('session signatures reject tampering, wrong secrets, expiry and malformed data', () => {
  const session = newSession('0123456789abcdef01234567', now);
  const token = encodeSession(session, secret);
  assert.equal(decodeSession(token, secret, now).sessionId, session.sessionId);
  assert.equal(decodeSession(`${token}x`, secret, now), null);
  assert.equal(decodeSession(token, 'b'.repeat(64), now), null);
  assert.equal(decodeSession(token, secret, now + SESSION_TTL_MS), null);
  assert.equal(decodeSession('broken', secret), null);
  assert.equal(decodeSession(encodeSession({ ...session, userId: 'invalid' }, secret), secret), null);
  assert.equal(decodeSession(encodeSession({ ...session, expiresAt: now + SESSION_TTL_MS * 2 }, secret), secret), null);
  assert.notEqual(sessionHash(session.sessionId), session.sessionId);
  assert.equal(new Set(Array.from({ length: 50 }, () => newSession(session.userId).sessionId)).size, 50);
});

test('session reader uses only its host cookie and rejects ambiguous duplicates', () => {
  const token = encodeSession(newSession('0123456789abcdef01234567'), secret);
  const config = { secure: true, sessionSecret: secret };
  assert.ok(readSession({ headers: { cookie: `__Host-rnjc_session=${token}` } }, config));
  assert.equal(readSession({ headers: { cookie: `rnjc_session=${token}` } }, config), null);
  assert.equal(readSession({ headers: { cookie: `__Host-rnjc_session=${token}; __Host-rnjc_session=${token}` } }, config), null);
});

test('auth configuration requires secrets and secure exact origins', () => {
  const env = { APP_ORIGIN: 'https://counter.test', GOOGLE_CLIENT_ID: 'client', SESSION_SECRET: secret };
  assert.equal(getAuthConfig(env).secure, true);
  assert.equal(getAuthConfig({ ...env, APP_ORIGIN: 'http://localhost:3000' }).secure, false);
  for (const APP_ORIGIN of ['https://counter.test/', 'https://counter.test/profile', 'http://counter.test', 'null']) {
    assert.throws(() => getAuthConfig({ ...env, APP_ORIGIN }));
  }
  assert.throws(() => getAuthConfig({ ...env, APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'production' }));
  assert.throws(() => getAuthConfig({ ...env, SESSION_SECRET: 'short' }));
});

test('Google identity uses sub and rejects wrong claims even after library verification', () => {
  const payload = { sub: 'google-sub', aud: 'client', iss: 'https://accounts.google.com',
    exp: Math.floor(now / 1000) + 60, email: 'private@example.test', email_verified: true,
    name: 'Radha Devotee', picture: 'https://lh3.googleusercontent.com/photo' };
  const identity = identityFromPayload(payload, 'client', now);
  assert.equal(identity.googleSub, 'google-sub');
  assert.equal(identity.photoUrl, payload.picture);
  for (const change of [{ aud: 'wrong' }, { iss: 'https://attacker.test' }, { exp: 0 },
    { sub: '' }, { email_verified: false }, { email: null }]) {
    assert.throws(() => identityFromPayload({ ...payload, ...change }, 'client', now));
  }
  assert.equal(googlePhoto('https://googleusercontent.com.attacker.test/photo'), null);
  assert.equal(googlePhoto('http://lh3.googleusercontent.com/photo'), null);
  assert.equal(googlePhoto('javascript:alert(1)'), null);
});
