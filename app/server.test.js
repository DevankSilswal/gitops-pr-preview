const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('./server');

// One server for the whole suite. Starting and stopping a listener per request
// is slow and leaves sockets in TIME_WAIT, which made the concurrency test
// flaky when it was first written.
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => server.close());

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get(`${baseUrl}${path}`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      })
      .on('error', reject);
  });
}

// Restores whatever the environment looked like before a test changed it.
function withEnv(t, vars) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  Object.assign(process.env, vars);

  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('GET /api/health returns ok', async () => {
  const res = await get('/api/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(JSON.parse(res.body), { status: 'ok' });
});

test('GET /api/info defaults to local values when env is unset', async () => {
  const res = await get('/api/info');
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
  withEnv(t, {
    ENVIRONMENT: 'pr-42',
    PR_NUMBER: '42',
    GIT_SHA: 'abc123',
    BUILT_AT: '2026-07-29T00:00:00Z',
  });

  const res = await get('/api/info');
  assert.deepStrictEqual(JSON.parse(res.body), {
    environment: 'pr-42',
    prNumber: '42',
    gitSha: 'abc123',
    builtAt: '2026-07-29T00:00:00Z',
  });
});

test('GET / renders build info as HTML', async (t) => {
  withEnv(t, { ENVIRONMENT: 'pr-7', PR_NUMBER: '7' });

  const res = await get('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.body, /Preview Environment/);
  assert.match(res.body, /pr-7/);
});

// Branch names reach these values, and a branch name can contain almost
// anything. Rendering one unescaped would make every preview environment a
// stored-XSS vector against whoever reviews the pull request.
test('GET / escapes HTML in environment values', async (t) => {
  withEnv(t, {
    ENVIRONMENT: '<script>alert(1)</script>',
    PR_NUMBER: '" onmouseover="alert(2)',
  });

  const res = await get('/');
  assert.doesNotMatch(res.body, /<script>alert\(1\)<\/script>/);
  assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(res.body, /onmouseover="alert\(2\)/);
  assert.match(res.body, /&quot; onmouseover=&quot;alert\(2\)/);
});

test('unknown routes return 404', async () => {
  const res = await get('/does-not-exist');
  assert.strictEqual(res.status, 404);
});

// The readiness probe polls this endpoint on every pod, and a single node can
// host many preview environments at once.
test('health endpoint handles concurrent requests', async () => {
  const results = await Promise.all(
    Array.from({ length: 50 }, () => get('/api/health')),
  );

  assert.strictEqual(results.length, 50);
  for (const res of results) {
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { status: 'ok' });
  }
});
