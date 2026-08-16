// The GitHub webhook boundary.
//
// This endpoint has no other authentication: anyone on the internet can reach
// it, so the signature is the only thing between a forged POST and a preview
// environment. Two properties matter and both are easy to get subtly wrong.
//
//   1. The HMAC is computed over the *raw* body. Parsing the JSON first and
//      re-serialising it changes bytes — key order, whitespace, unicode escapes
//      — and the signature no longer matches what GitHub signed. Every handler
//      here takes a Buffer for that reason.
//
//   2. The comparison is timing-safe. A byte-by-byte compare that returns early
//      leaks the expected signature one character at a time to anybody willing
//      to measure.
'use strict';

const crypto = require('node:crypto');

/**
 * @param {Buffer} rawBody exactly the bytes GitHub sent
 * @param {string} signatureHeader value of X-Hub-Signature-256
 * @param {string} secret the webhook secret
 */
function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret) throw new Error('no webhook secret configured; refusing to accept unauthenticated events');
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false;
  if (!Buffer.isBuffer(rawBody)) throw new Error('the signature must be computed over the raw body bytes');

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which is itself a length oracle;
  // comparing lengths first and returning the same false either way is fine
  // because the length of a hex digest is not a secret.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Events this control plane acts on. Anything else is stored and ignored. */
const HANDLED = Object.freeze(['pull_request', 'installation', 'installation_repositories', 'ping']);

/**
 * Turn a verified delivery into an intent, without performing it.
 *
 * Separating "what does this event mean" from "do it" is what makes the
 * interesting cases testable: a closed pull request, a synchronize on a preview
 * that does not exist, an event for a repository nobody connected.
 */
function interpret(eventType, payload) {
  if (eventType === 'ping') return { intent: 'none', reason: 'ping' };

  if (eventType === 'installation' || eventType === 'installation_repositories') {
    return { intent: 'sync_installation', installationId: payload.installation && payload.installation.id };
  }

  if (eventType !== 'pull_request') {
    return { intent: 'none', reason: `unhandled event type: ${eventType}` };
  }

  const pr = payload.pull_request || {};
  const repo = payload.repository || {};
  const identity = {
    owner: repo.owner && repo.owner.login,
    name: repo.name,
    prNumber: pr.number,
    title: pr.title,
    author: pr.user && pr.user.login,
    isBot: !!(pr.user && pr.user.type === 'Bot'),
    isFork: !!(pr.head && pr.head.repo && repo.full_name && pr.head.repo.full_name !== repo.full_name),
    headSha: pr.head && pr.head.sha,
    updatedAt: pr.updated_at,
  };

  switch (payload.action) {
    case 'opened':
    case 'reopened':
      return { intent: 'create_preview', ...identity };
    case 'synchronize':
      // A new commit updates the environment that already exists. Creating a
      // second one per push is the failure mode this intent exists to prevent.
      return { intent: 'update_preview', ...identity };
    case 'closed':
      return { intent: 'destroy_preview', ...identity, merged: !!pr.merged };
    default:
      return { intent: 'none', reason: `pull_request.${payload.action} needs no action` };
  }
}

/**
 * The delivery pipeline. Returns quickly and never throws at GitHub: a webhook
 * that 500s gets retried, and a retry storm is worse than a recorded failure.
 *
 * @param {object} deps store, now(), and a process(intent) callback
 */
async function receive({ rawBody, headers, secret, store, process: processIntent, now = () => new Date().toISOString() }) {
  const signature = headers['x-hub-signature-256'];
  const deliveryId = headers['x-github-delivery'];
  const eventType = headers['x-github-event'];

  if (!verifySignature(rawBody, signature, secret)) {
    // No state is recorded for an unverified delivery. Writing a row would let
    // anyone fill the table by POSTing noise.
    return { status: 401, body: { error: { code: 'invalid_signature', message: 'signature verification failed' } } };
  }
  if (!deliveryId) {
    return { status: 400, body: { error: { code: 'missing_delivery_id', message: 'X-GitHub-Delivery is required' } } };
  }

  // The unique constraint is the idempotency, not this read: two concurrent
  // deliveries of the same id both see "not seen" here, and the loser fails to
  // insert. That is the intended outcome and it is why the insert is inside a
  // try rather than guarded by an if.
  let stored;
  try {
    stored = store.recordWebhookEvent({ deliveryId, eventType, receivedAt: now() });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return { status: 200, body: { status: 'duplicate', delivery: deliveryId } };
    }
    throw err;
  }

  if (!HANDLED.includes(eventType)) {
    store.completeWebhookEvent(stored.id, { result: 'ignored', processedAt: now() });
    return { status: 200, body: { status: 'ignored', event: eventType } };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    store.completeWebhookEvent(stored.id, { result: 'failed', error: 'body was not JSON', processedAt: now() });
    return { status: 400, body: { error: { code: 'invalid_body', message: 'body was not JSON' } } };
  }

  const intent = interpret(eventType, payload);
  if (intent.intent === 'none') {
    store.completeWebhookEvent(stored.id, { result: 'ignored', processedAt: now() });
    return { status: 200, body: { status: 'ignored', reason: intent.reason } };
  }

  try {
    const result = await processIntent(intent);
    store.completeWebhookEvent(stored.id, { result: 'ok', processedAt: now() });
    return { status: 200, body: { status: 'accepted', intent: intent.intent, result } };
  } catch (err) {
    // Recorded, not hidden, and still a 200: GitHub retrying will hit the
    // duplicate path and change nothing, so a retry cannot fix this. The
    // unprocessed row is what an operator looks at.
    store.completeWebhookEvent(stored.id, { result: 'failed', error: String(err.message || err), processedAt: now() });
    return { status: 200, body: { status: 'failed', error: 'the event was recorded but could not be processed' } };
  }
}

module.exports = { verifySignature, interpret, receive, HANDLED };
