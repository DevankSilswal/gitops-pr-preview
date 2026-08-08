#!/usr/bin/env node
//
// Smoke tests that run against a live preview environment.
//
//   PREVIEW_URL=https://... [PREVIEW_USER=... PREVIEW_PASSWORD=...] \
//   [EXPECT_PR=7] [EXPECT_SHA=abc123] node smoke-test.js
//
// server.test.js proves the application is correct on a runner. This proves
// something different and, for a preview environment, more useful: that the
// deployment a reviewer is about to click actually serves, and that it is
// serving *this* pull request's build rather than a stale one.
//
// It is what makes the preview a gate rather than a link. A reviewer should not
// have to work out for themselves whether anything is broken.
//
// Scope, and why it is drawn here. This runs against a *deployed* environment,
// and that deployment is governed by the chart on the platform's default
// branch — never by the branch under review (ADR 0003). So it cannot assert
// properties of a chart change that has not merged yet, and trying to is a
// category error rather than a stricter test: it would fail on precisely the
// pull request that adds the protection.
//
// The platform's own invariants — noindex, refusing unauthenticated requests —
// are therefore asserted in scripts/e2e-test.sh, which deploys the chart from
// the branch under review onto a real cluster on every commit. Here they are
// checked only when the caller states it expects them, via EXPECT_NOINDEX,
// which is also the honest default for an adopter whose cluster may be
// configured differently from this one.
//
// No dependencies: fetch is built into the Node this repository targets, and a
// smoke test that needs an install step is one more thing to go wrong between
// the environment being ready and finding out whether it works.

const url = process.env.PREVIEW_URL;
if (!url) {
  console.error('PREVIEW_URL is not set');
  process.exit(1);
}

const base = url.replace(/\/$/, '');
const user = process.env.PREVIEW_USER;
const password = process.env.PREVIEW_PASSWORD;

const headers = {};
if (user && password) {
  headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

async function get(pathname) {
  const res = await fetch(`${base}${pathname}`, { headers, redirect: 'manual' });
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  // --- it serves at all ----------------------------------------------------
  const root = await get('/');
  check('the site serves at the root', root.status === 200, `got ${root.status}`);

  // --- it is serving *this* build ------------------------------------------
  // The single most valuable assertion here. An environment that answers is not
  // the same as an environment running the commit under review — a stale image,
  // or a tag that resolved to something else, both answer 200 quite happily.
  const info = await get('/api/info');
  check('/api/info responds', info.status === 200, `got ${info.status}`);

  let identity = {};
  try {
    identity = JSON.parse(info.body);
  } catch {
    check('/api/info returns JSON', false, info.body.slice(0, 200));
  }

  if (process.env.EXPECT_PR) {
    check(
      `it reports pull request ${process.env.EXPECT_PR}`,
      String(identity.prNumber) === String(process.env.EXPECT_PR),
      `reported ${identity.prNumber}`,
    );
  }

  if (process.env.EXPECT_SHA) {
    check(
      'it reports the commit under review',
      identity.gitSha === process.env.EXPECT_SHA,
      `reported ${identity.gitSha}, expected ${process.env.EXPECT_SHA}`,
    );
  }

  // --- the platform's promises hold in the real deployment -----------------
  const health = await get('/api/health');
  check('the readiness endpoint is healthy', health.status === 200, `got ${health.status}`);

  // Unreleased work on a guessable hostname must not end up in a search index,
  // and a crawler that has already been let in cannot be un-told. Enforced in
  // e2e-test.sh against the chart under review; asserted here only when the
  // caller says the cluster is configured for it.
  const robots = root.headers.get('x-robots-tag') || '';
  if (process.env.EXPECT_NOINDEX === 'true') {
    check(
      'responses carry X-Robots-Tag: noindex',
      robots.includes('noindex'),
      `header was ${robots ? `'${robots}'` : 'absent'}`,
    );
  } else {
    console.log(
      `note X-Robots-Tag is ${robots ? `'${robots}'` : 'absent'}` +
        ' (set EXPECT_NOINDEX=true to require it)',
    );
  }

  // If a password was issued, the environment must actually be refusing
  // requests that do not carry it. An auth annotation that silently fails open
  // looks exactly like one that works — so this is not optional: being handed a
  // credential and finding it is not needed is a finding either way.
  if (user && password) {
    const res = await fetch(`${base}/api/info`, { redirect: 'manual' });
    check(
      'an unauthenticated request is refused',
      res.status === 401,
      `got ${res.status} without credentials`,
    );
  }
}

main()
  .then(() => {
    console.log();
    if (failures) {
      console.error(`${failures} smoke test(s) failed against ${base}`);
      process.exit(1);
    }
    console.log(`all smoke tests passed against ${base}`);
  })
  .catch((err) => {
    console.error(`smoke tests could not run against ${base}: ${err.message}`);
    process.exit(1);
  });
