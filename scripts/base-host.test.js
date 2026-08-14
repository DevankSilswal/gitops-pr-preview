// The generation has to work for an address this cluster has never had.
//
// The test that matters most is the synthetic one: if the implementation ever
// falls back to the current production IP — a default, a cached value, a
// hardcoded string behind an error path — that case fails and nothing else
// would have noticed until the day the VM was replaced.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { baseHostFromIp, hostFor } = require('./base-host.js');

const PRODUCTION_IP = '20.24.211.179';

test('the current production address produces the hostname now in use', () => {
  assert.strictEqual(baseHostFromIp(PRODUCTION_IP), '20-24-211-179.nip.io');
});

test('a different address produces a different hostname, with no trace of production', () => {
  const generated = baseHostFromIp('51.103.22.7');
  assert.strictEqual(generated, '51-103-22-7.nip.io');
  assert.ok(!generated.includes('20-24-211-179'), 'fell back to the production address');
  assert.strictEqual(hostFor('demo', generated), 'demo.51-103-22-7.nip.io');
  assert.strictEqual(hostFor('app', generated), 'app.51-103-22-7.nip.io');
});

test('the dashed form is required, because nip.io splits on dashes too', () => {
  // pr-1.1.2.3.4.nip.io resolves to 1.127.0.0; the dashes are not cosmetic.
  assert.strictEqual(baseHostFromIp('1.2.3.4'), '1-2-3-4.nip.io');
  assert.ok(!baseHostFromIp('1.2.3.4').includes('.1.'));
});

test('surrounding whitespace is tolerated, because terraform output has a newline', () => {
  assert.strictEqual(baseHostFromIp('  20.24.211.179\n'), '20-24-211-179.nip.io');
});

test('an empty or missing address is refused, never defaulted', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.throws(() => baseHostFromIp(bad), /no IP given|empty/,
      `accepted ${JSON.stringify(bad)}`);
  }
});

test('a malformed address is refused', () => {
  for (const bad of ['not-an-ip', '20.24.211', '20.24.211.179.5', '20.24.211.abc',
                     '20.24.211.256', '20.024.211.179', '20-24-211-179']) {
    assert.throws(() => baseHostFromIp(bad), Error, `accepted ${JSON.stringify(bad)}`);
  }
});

test('IPv6 is refused with a reason, because nip.io hostnames here are IPv4', () => {
  assert.throws(() => baseHostFromIp('2001:db8::1'), /IPv4 only/);
});

test('a non-string is refused rather than coerced', () => {
  assert.throws(() => baseHostFromIp(20242111790), /must be a string/);
});

test('nothing in the module carries the production address as a default', () => {
  const source = require('node:fs').readFileSync(`${__dirname}/base-host.js`, 'utf8');
  assert.ok(!source.includes(PRODUCTION_IP),
    'base-host.js contains the production IP; it must derive, not remember');
  assert.ok(!source.includes('20-24-211-179'),
    'base-host.js contains the production hostname; it must derive, not remember');
});
