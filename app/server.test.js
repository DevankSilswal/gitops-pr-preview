const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
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

function get(pathname) {
  return new Promise((resolve, reject) => {
    http
      .get(`${baseUrl}${pathname}`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
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
// inject build identity via env vars, and the app must report it back. The page
// reads this at runtime, which is what lets one image identify itself
// differently in every environment it runs in.
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

test('the site is served at the root', async () => {
  const res = await get('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /Pixel Arcade/);
});

test('static assets are served', async () => {
  const res = await get('/styles.css');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /text\/css/);
});

// The badge shows values that originate in branch names, and a branch name can
// contain markup. Building it with innerHTML would make every preview
// environment a way to run script in a reviewer's browser — a regression that
// would be invisible in review, so it is asserted here instead.
test('the environment badge is not built with innerHTML', () => {
  const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const badgeScript = page.slice(page.indexOf("fetch('/api/info')"));
  assert.doesNotMatch(
    badgeScript.slice(0, 900),
    /innerHTML/,
    'the badge must use textContent; these values come from branch names',
  );
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
