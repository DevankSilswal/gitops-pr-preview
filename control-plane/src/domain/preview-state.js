// The preview state machine.
//
// This is the smallest piece of the product and the one most worth getting
// right, because it encodes a rule the rest of the system cannot enforce on its
// own: the product may only call a preview READY when something outside it has
// confirmed the environment is actually serving.
//
// Every other transition is bookkeeping. That one is a promise to a reviewer
// who is about to click a link.
'use strict';

const STATES = Object.freeze({
  QUEUED: 'QUEUED',
  BUILDING: 'BUILDING',
  PROVISIONING: 'PROVISIONING',
  READY: 'READY',
  UPDATING: 'UPDATING',
  FAILED: 'FAILED',
  REJECTED: 'REJECTED',
  EXPIRING: 'EXPIRING',
  DESTROYING: 'DESTROYING',
  DESTROYED: 'DESTROYED',
});

// What may follow what. Anything absent is refused rather than logged, because
// a state machine that accepts an unexpected transition is a state machine that
// will eventually report READY for an environment that never came up.
const TRANSITIONS = Object.freeze({
  QUEUED:       ['BUILDING', 'REJECTED', 'FAILED', 'DESTROYING'],
  BUILDING:     ['PROVISIONING', 'FAILED', 'DESTROYING'],
  PROVISIONING: ['READY', 'FAILED', 'DESTROYING'],
  READY:        ['UPDATING', 'EXPIRING', 'DESTROYING', 'FAILED'],
  UPDATING:     ['READY', 'FAILED', 'DESTROYING'],
  FAILED:       ['BUILDING', 'EXPIRING', 'DESTROYING'],
  REJECTED:     ['QUEUED', 'DESTROYING'],
  EXPIRING:     ['DESTROYING', 'READY'],
  DESTROYING:   ['DESTROYED'],
  DESTROYED:    [],
});

const TERMINAL = Object.freeze(['DESTROYED']);

// States in which a preview occupies a slot on the node. A FAILED preview still
// holds a namespace, so it still counts; a DESTROYED one does not. Getting this
// wrong in either direction is expensive: too broad and nobody can open a pull
// request, too narrow and the node runs out of memory.
const OCCUPIES_CAPACITY = Object.freeze([
  'QUEUED', 'BUILDING', 'PROVISIONING', 'READY', 'UPDATING', 'FAILED', 'EXPIRING',
]);

class IllegalTransition extends Error {
  constructor(from, to) {
    super(`a preview cannot go from ${from} to ${to}`);
    this.name = 'IllegalTransition';
    this.from = from;
    this.to = to;
  }
}

class UnconfirmedReady extends Error {
  constructor() {
    super('READY requires confirmation from the orchestrator; the product does not decide that an environment is serving');
    this.name = 'UnconfirmedReady';
  }
}

/**
 * @param {string} from current state
 * @param {string} to   proposed state
 * @param {{confirmedServing?: boolean}} evidence
 *
 * `confirmedServing` must come from the orchestrator having observed the
 * environment answer — not from a deployment finishing, and not from ArgoCD
 * reporting Synced. Synced means the manifests were applied; it says nothing
 * about whether anything answers on the URL a reviewer is about to open.
 */
function assertTransition(from, to, evidence = {}) {
  if (!STATES[from]) throw new Error(`unknown current state: ${from}`);
  if (!STATES[to]) throw new Error(`unknown target state: ${to}`);
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) throw new IllegalTransition(from, to);
  if (to === STATES.READY && evidence.confirmedServing !== true) throw new UnconfirmedReady();
  return true;
}

function canTransition(from, to, evidence = {}) {
  try {
    return assertTransition(from, to, evidence);
  } catch {
    return false;
  }
}

const isTerminal = (state) => TERMINAL.includes(state);
const occupiesCapacity = (state) => OCCUPIES_CAPACITY.includes(state);

// What the product says out loud. The UI shows this, not the enum, and never a
// Kubernetes condition.
const HUMAN = Object.freeze({
  QUEUED:       'Waiting for a free environment',
  BUILDING:     'Building the image for this commit',
  PROVISIONING: 'Starting the environment',
  READY:        'Ready',
  UPDATING:     'Deploying a newer commit',
  FAILED:       'Failed',
  REJECTED:     'Not created',
  EXPIRING:     'Expiring — idle past its TTL',
  DESTROYING:   'Cleaning up',
  DESTROYED:    'Destroyed',
});

// Failure kinds translated into something a developer can act on. The raw
// message is kept beside these, never instead of them.
const FAILURE_MESSAGE = Object.freeze({
  build:    (d) => `The image for commit ${short(d.commit)} did not build.`,
  image:    (d) => `The image for commit ${short(d.commit)} was never published, so the environment has nothing to run.`,
  health:   (d) => `The environment started but never became healthy${d.path ? ` on ${d.path}` : ''}.`,
  policy:   (d) => `This pull request is not allowed a preview: ${d.reason || 'blocked by project policy'}.`,
  capacity: (d) => `No environment was free: ${d.used ?? '?'} of ${d.max ?? '?'} are in use.`,
  unknown:  () => 'The environment failed for a reason the platform could not classify.',
});

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : 'unknown');

function describeFailure(kind, detail = {}) {
  const f = FAILURE_MESSAGE[kind] || FAILURE_MESSAGE.unknown;
  return f(detail);
}

module.exports = {
  STATES, TRANSITIONS, HUMAN,
  assertTransition, canTransition, isTerminal, occupiesCapacity, describeFailure,
  IllegalTransition, UnconfirmedReady,
};
