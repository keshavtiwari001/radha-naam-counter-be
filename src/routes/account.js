import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { getAuthConfig } from '../config/env.js';
import { createAccountStore } from '../services/accountStore.js';
import { verifyGoogleIdentity } from '../services/googleIdentity.js';
import { clearSessionCookie, readSession, setSessionCookie } from '../services/session.js';
import { HttpError } from '../utils/httpError.js';
import { createCounterService } from '../services/counterService.js';
import { createLeaderboardService } from '../services/leaderboardService.js';

function fields(body, allowed) {
  if (!body || Array.isArray(body) || typeof body !== 'object'
    || Object.keys(body).some((field) => !allowed.includes(field))) {
    throw new HttpError(400, 'Invalid request fields.', 'INVALID_INPUT');
  }
}
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

export function createAccountRouter({
  store = createAccountStore(), verifyIdentity = verifyGoogleIdentity, authConfig = getAuthConfig,
  rateLimitMax = 15,
  counterService = createCounterService(),
  leaderboardService = createLeaderboardService(),
} = {}) {
  const router = Router();
  // These paths are same-origin JSON APIs; rejecting missing/foreign origins
  // and cross-site fetches also protects login from CSRF. No CORS is enabled.
  router.use((req, _res, next) => {
    try { req.authConfig = authConfig(); } catch {
      throw new HttpError(503, 'Account services are not configured yet.', 'ACCOUNT_UNAVAILABLE');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('origin') !== req.authConfig.origin || req.get('sec-fetch-site') === 'cross-site') {
        throw new HttpError(403, 'Request origin is not allowed.', 'ORIGIN_REJECTED');
      }
      if (!req.is('application/json')) throw new HttpError(415, 'Send application/json.', 'JSON_REQUIRED');
    }
    req.accountSession = readSession(req, req.authConfig);
    next();
  });
  const limit = rateLimit({ windowMs: 15 * 60 * 1000, limit: rateLimitMax,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again later.', code: 'RATE_LIMITED' },
  });

  router.post('/auth/google', limit, async (req, res) => {
    fields(req.body, ['credential', 'replaceSession', 'deviceId']);
    if (typeof req.body.credential !== 'string' || req.body.credential.length < 1
      || req.body.credential.length > 12000
      || (req.body.replaceSession !== undefined && typeof req.body.replaceSession !== 'boolean')
      || (req.body.deviceId !== undefined && !uuid(req.body.deviceId))) {
      throw new HttpError(400, 'A Google credential is required.', 'INVALID_INPUT');
    }
    const identity = await verifyIdentity(req.body.credential, req.authConfig);
    const result = await store.signIn(identity, req.accountSession, req.body.replaceSession === true, req.body.deviceId);
    setSessionCookie(res, result.session, req.authConfig);
    res.json({ profile: result.profile });
  });
  router.post('/auth/logout', limit, async (req, res) => {
    fields(req.body, []);
    await store.logout(req.accountSession);
    clearSessionCookie(res, req.authConfig);
    res.status(204).end();
  });
  router.get('/me', async (req, res) => {
    if (!req.accountSession) throw new HttpError(401, 'Please sign in to continue.', 'SESSION_REQUIRED');
    res.json({ profile: await store.profile(req.accountSession) });
  });
  router.patch('/me', limit, async (req, res) => {
    if (!req.accountSession) throw new HttpError(401, 'Please sign in to continue.', 'SESSION_REQUIRED');
    fields(req.body, ['displayName']);
    const name = req.body.displayName;
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80
      || /[\p{Cc}\p{Cf}]/u.test(name)) {
      throw new HttpError(400, 'Display name must be 1–80 characters without control characters.', 'INVALID_INPUT');
    }
    res.json({ profile: await store.rename(req.accountSession, name.trim()) });
  });
  router.delete('/me', limit, async (req, res) => {
    fields(req.body, ['confirmation', 'accountId']);
    if (req.body.confirmation !== 'DELETE' || !/^[a-f0-9]{24}$/.test(req.body.accountId)) {
      throw new HttpError(400, 'Explicit account deletion confirmation is required.', 'INVALID_INPUT');
    }
    if (!req.accountSession) throw new HttpError(401, 'Please sign in to delete your account.', 'SESSION_REQUIRED');
    if (req.body.accountId !== req.accountSession.userId) {
      throw new HttpError(409, 'The active account changed. Refresh before deleting.', 'ACCOUNT_CHANGED');
    }
    await store.deleteAccount(req.accountSession);
    clearSessionCookie(res, req.authConfig);
    res.status(204).end();
  });
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  const syncLimit = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Saving is busy. Your progress remains on this device.', code: 'RATE_LIMITED' } });
  router.get('/counter', async (req, res) => res.json(await counterService.counter(req.accountSession)));
  router.get('/leaderboard', async (req, res) => {
    // Validate active ownership before using a cookie to expose a personal rank.
    const profile = req.accountSession ? await store.profile(req.accountSession) : null;
    res.json(await leaderboardService.current(req.query.period ?? 'day', profile?.id));
  });
  router.post('/me/import-guest', syncLimit, async (req, res) => {
    fields(req.body, ['importId', 'totalChants', 'counterEpoch']);
    if (!uuid(req.body.importId) || !uuid(req.body.counterEpoch) || !count(req.body.totalChants)) {
      throw new HttpError(400, 'Invalid guest progress.', 'INVALID_INPUT');
    }
    res.json(await counterService.importGuest(req.accountSession, req.body));
  });
  router.post('/counter/sync', syncLimit, async (req, res) => {
    fields(req.body, ['operationId', 'sequence', 'totalChants', 'reason', 'counterEpoch']);
    if (!uuid(req.body.operationId) || !uuid(req.body.counterEpoch) || !count(req.body.totalChants)
      || !Number.isSafeInteger(req.body.sequence) || req.body.sequence < 1
      || !['mala_completed', 'startup', 'reconnect', 'background', 'manual', 'logout'].includes(req.body.reason)) {
      throw new HttpError(400, 'Invalid counter snapshot.', 'INVALID_INPUT');
    }
    res.json(await counterService.sync(req.accountSession, req.body));
  });
  return router;
}
