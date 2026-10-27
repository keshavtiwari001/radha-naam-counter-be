import express from 'express';
import { createAccountRouter } from './routes/account.js';
import { HttpError } from './utils/httpError.js';

export function createApp(accountOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api/v1', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));

  // Liveness only: intentionally discloses no configuration or database state.
  app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));
  // Mount only implemented account paths, leaving unknown routes as 404.
  const accountRouter = createAccountRouter(accountOptions);
  app.use('/api/v1', (req, res, next) => {
    if (!['/auth/google', '/auth/logout', '/me', '/me/import-guest', '/counter', '/counter/sync', '/leaderboard'].includes(req.path)) return next();
    return accountRouter(req, res, next);
  });
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request too large' });
    }
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message, code: error.code });
    return res.status(503).json({ error: 'Service unavailable. Please try again.', code: 'SERVICE_UNAVAILABLE' });
  });

  return app;
}

// Vercel's Express entry point; local listener lives in server.js.
export default createApp();
