// Provisioning time, measured rather than promised.
//
// The measurement this replaces was wrong in a way that looked right: it timed
// from the commit's timestamp, so reopening a five-day-old pull request
// produced a sample of 415673 seconds and went into the same file as the real
// ones. A metric nobody can trust is worse than no metric, because it gets
// quoted.
//
// Two rules make the difference. The clock starts when the platform decided to
// provision — not when somebody wrote the commit — and it stops at the first
// external HTTP 200 on the hostname a reviewer would open. Everything between
// those points is the platform's responsibility, and nothing outside them is.
'use strict';

// A provision that took longer than this did not take longer than this. It was
// a run that stalled and was later reconciled, a clock that moved, or a row
// written by the measurement bug above. Two hours is far past anything this
// platform has ever legitimately taken; the observed spread is 79-121 seconds.
const IMPLAUSIBLE_SECONDS = 2 * 60 * 60;

const KIND = Object.freeze({
  open: 'first_provision',
  synchronize: 'redeploy',
  redeploy: 'redeploy',
  rollback: 'recovery',
});

/**
 * Why a sample was thrown away. Kept rather than silently dropped, because
 * "how many did you discard, and why" is the first question anybody sensible
 * asks about a percentile.
 */
function reject(deployment) {
  const s = deployment.provisioning_seconds;
  if (deployment.status !== 'succeeded') return 'did not reach a serving state';
  if (s === null || s === undefined) return 'no provisioning time was recorded';
  if (typeof s !== 'number' || Number.isNaN(s)) return 'provisioning time is not a number';
  if (s < 0) return 'negative duration — the clock disagreed with itself';
  if (s === 0) return 'zero duration — nothing is provisioned instantly';
  if (s > IMPLAUSIBLE_SECONDS) return `implausible duration (${s}s) — a stalled run reconciled later, not a provision`;
  if (!deployment.started_at || !deployment.finished_at) return 'missing a timestamp';
  const span = (Date.parse(deployment.finished_at) - Date.parse(deployment.started_at)) / 1000;
  if (Number.isNaN(span)) return 'unparseable timestamps';
  // The recorded duration and the timestamps must agree. A row where they do
  // not is a row written by two different code paths.
  if (Math.abs(span - s) > 5) return `recorded duration ${s}s disagrees with its own timestamps (${Math.round(span)}s)`;
  return null;
}

const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  // Nearest-rank. With single-digit sample counts, interpolation invents
  // precision the data does not have.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
};

/**
 * @param {Array} deployments rows from the deployments table
 * @returns a report that states its own sample size everywhere it states a number
 */
function report(deployments) {
  const attempted = deployments.length;
  const accepted = [];
  const rejected = [];

  for (const d of deployments) {
    const why = reject(d);
    if (why) rejected.push({ id: d.id, trigger: d.trigger, seconds: d.provisioning_seconds, why });
    else accepted.push({ ...d, kind: KIND[d.trigger] || 'unknown' });
  }

  const byKind = {};
  for (const kind of ['first_provision', 'redeploy', 'recovery']) {
    const samples = accepted.filter((a) => a.kind === kind).map((a) => a.provisioning_seconds).sort((a, b) => a - b);
    byKind[kind] = {
      samples: samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      min: samples[0] ?? null,
      max: samples[samples.length - 1] ?? null,
      // The percentiles describe and claim nothing. Attainment against a target
      // is a claim, and one that needs enough samples to survive the question
      // "over how many?".
      attainment: samples.length >= 20 ? 'computable' : `withheld — ${samples.length} of 20 samples`,
    };
  }

  const finished = deployments.filter((d) => d.status === 'succeeded' || d.status === 'failed');
  return {
    attempted,
    valid: accepted.length,
    rejected: rejected.length,
    rejections: rejected,
    firstProvisions: byKind.first_provision.samples,
    byKind,
    successRate: finished.length
      ? { succeeded: finished.filter((d) => d.status === 'succeeded').length, of: finished.length,
          percent: Math.round((finished.filter((d) => d.status === 'succeeded').length / finished.length) * 100) }
      : null,
    // Deliberately absent: a target. There is not enough evidence to set one,
    // and a number invented now would be quoted long after anybody remembered
    // it was invented.
    objective: null,
  };
}

module.exports = { report, reject, percentile, KIND, IMPLAUSIBLE_SECONDS };
