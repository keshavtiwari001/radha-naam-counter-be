import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';

test('health and errors disclose no secrets and are never cached', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-powered-by'), null);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const unknown = await fetch(`${base}/api/v1/unknown`);
  assert.equal(unknown.status, 404);
  const bad = await fetch(`${base}/api/v1/unknown`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'Invalid JSON' });
});
