const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('./server');

function request(path) {
  const server = app.listen(0);
  const { port } = server.address();

  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  }).finally(() => server.close());
}

test('GET /api/health returns ok', async () => {
  const res = await request('/api/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(JSON.parse(res.body), { status: 'ok' });
});

test('GET /api/info defaults to local values when env is unset', async () => {
  const res = await request('/api/info');
  assert.deepStrictEqual(JSON.parse(res.body), {
    environment: 'local',
    prNumber: 'none',
    gitSha: 'unknown',
    builtAt: 'unknown',
  });
});

// This is the mechanism every preview environment relies on: CI and Kubernetes
// inject build identity via env vars, and the app must report it back.
test('GET /api/info reflects injected env vars', async (t) => {
  const original = { ...process.env };
  t.after(() => {
    process.env = original;
  });

  process.env.ENVIRONMENT = 'pr-42';
  process.env.PR_NUMBER = '42';
  process.env.GIT_SHA = 'abc123';
  process.env.BUILT_AT = '2026-07-29T00:00:00Z';

  const res = await request('/api/info');
  assert.deepStrictEqual(JSON.parse(res.body), {
    environment: 'pr-42',
    prNumber: '42',
    gitSha: 'abc123',
    builtAt: '2026-07-29T00:00:00Z',
  });
});

test('GET / renders build info as HTML', async () => {
  const res = await request('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.body, /Preview Environment/);
});
