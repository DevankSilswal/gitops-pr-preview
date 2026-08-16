// The seam between the product and the machinery.
//
// Above this line the vocabulary is previews, deployments and commits. Below
// it, and only below it, there are namespaces, Applications and labels. The
// point is not tidiness: it is that the product cannot grow a `kubectl apply`
// endpoint by accident, because nothing above this interface has a client that
// could.
//
// The existing engine is not rebuilt. Creating a preview means adding a label
// to a pull request; the ApplicationSet notices, ArgoCD reconciles, and a
// namespace appears. Destroying one means removing that label. Both are already
// live and neither is reimplemented here.
'use strict';

/**
 * @typedef {Object} PreviewOrchestrator
 * @property {(spec) => Promise<{accepted: boolean, reason?: string}>} create
 * @property {(spec) => Promise<{accepted: boolean}>} update
 * @property {(spec) => Promise<{accepted: boolean}>} destroy
 * @property {(spec) => Promise<{accepted: boolean, target: string}>} rollback
 * @property {(spec) => Promise<Status>} status
 * @property {(spec) => Promise<string[]>} logs
 *
 * @typedef {Object} Status
 * @property {boolean} serving   the environment answered — the only evidence
 *                               that may promote a preview to READY
 * @property {string}  phase     orchestrator-level phase, for diagnosis
 * @property {string=} url
 * @property {string=} failureKind
 * @property {string=} detail
 */

/**
 * Drives the live engine: GitHub labels for lifecycle, the Kubernetes API for
 * observation, and an HTTP request for the one fact that matters.
 */
class ArgoCDOrchestrator {
  /**
   * How long an environment may legitimately not exist yet.
   *
   * The ApplicationSet's pull request generator requeues every 300 seconds, so
   * anything shorter than that would report a failure for a preview that is
   * simply waiting its turn. The margin covers a poll that lands just before
   * the label does.
   */
  static GENERATION_GRACE_SECONDS = 420;

  /**
   * @param {object} deps
   * @param {object} deps.github  addLabel/removeLabel, scoped to one repository
   * @param {object} deps.cluster read-only Kubernetes reads
   * @param {(url: string) => Promise<number>} deps.probe returns an HTTP status
   * @param {string} deps.baseHost generated from Terraform's public_ip (P0-6)
   */
  constructor({ github, cluster, probe, baseHost }) {
    this.github = github;
    this.cluster = cluster;
    this.probe = probe;
    this.baseHost = baseHost;
  }

  /** `<slug>-pr-<n>` — the same shape the ApplicationSet templates. */
  namespaceFor({ slug, prNumber }) { return `${slug}-pr-${prNumber}`; }
  urlFor({ slug, prNumber }) { return `https://${slug}-pr-${prNumber}.${this.baseHost}`; }
  applicationFor({ slug, prNumber }) { return `preview-${slug}-${prNumber}`; }

  async create({ owner, repo, prNumber }) {
    await this.github.addLabel({ owner, repo, prNumber, label: 'preview' });
    // Deliberately does not wait. Provisioning takes a couple of minutes and a
    // webhook handler that blocked on it would be killed by GitHub's timeout
    // long before anything was ready.
    return { accepted: true };
  }

  async update() {
    // A new commit is a new image tag under the same label, so there is nothing
    // to do here. Saying so explicitly is better than an empty method that
    // looks unfinished.
    return { accepted: true, reason: 'a new commit is picked up by the existing environment' };
  }

  async destroy({ owner, repo, prNumber }) {
    try {
      await this.github.removeLabel({ owner, repo, prNumber, label: 'preview' });
    } catch (err) {
      // Already gone is not a failure. Cleanup that cannot be run twice cannot
      // be trusted once.
      if (err.status !== 404) throw err;
    }
    return { accepted: true };
  }

  async rollback({ slug, prNumber, imageTag }) {
    const app = this.applicationFor({ slug, prNumber });
    await this.cluster.setApplicationImageTag(app, imageTag);
    return { accepted: true, target: imageTag };
  }

  /**
   * The only place a preview may be called READY.
   *
   * ArgoCD reporting Synced/Healthy is not enough: Synced means the manifests
   * were applied, and Healthy means the workload's own probes pass. Neither
   * says that the hostname a reviewer is about to click answers — which is
   * exactly what failed on 2026-08-13, when every pod was Ready and every URL
   * returned 503 because the ingress controller was refusing the annotation.
   */
  async status({ slug, prNumber, ageSeconds = 0 }) {
    const app = this.applicationFor({ slug, prNumber });
    const url = this.urlFor({ slug, prNumber });

    const application = await this.cluster.getApplication(app);
    if (!application) {
      // Absence is the normal state for the first few minutes. The label is the
      // request; the ApplicationSet notices on its own schedule — a 300s requeue
      // — and only then does an Application exist. The first live run of this
      // code called a preview FAILED two seconds after asking for it, because
      // this branch did not know the difference between 'not yet' and 'not
      // going to'.
      if (ageSeconds < ArgoCDOrchestrator.GENERATION_GRACE_SECONDS) {
        return { serving: false, phase: 'pending', url,
          detail: 'waiting for the generator to notice the label' };
      }
      return { serving: false, phase: 'absent', url, failureKind: 'unknown',
        detail: `no environment appeared within ${ArgoCDOrchestrator.GENERATION_GRACE_SECONDS}s of the label being added` };
    }

    const sync = application.sync;
    const health = application.health;

    let code = 0;
    try { code = await this.probe(url); } catch { code = 0; }
    const serving = code === 200;

    if (serving) return { serving: true, phase: 'serving', url, httpStatus: code };

    if (health === 'Degraded' || health === 'Missing') {
      const pods = await this.cluster.podFailures(this.namespaceFor({ slug, prNumber }));
      const imagePull = pods.find((p) => /ImagePull|ErrImage/.test(p.reason || ''));
      if (imagePull) {
        return { serving: false, phase: 'image-missing', url, failureKind: 'image',
          detail: imagePull.message || imagePull.reason };
      }
      return { serving: false, phase: 'unhealthy', url, failureKind: 'health',
        detail: pods.map((p) => `${p.name}: ${p.reason}`).join('; ') || `ArgoCD reports ${health}` };
    }

    // Applied and healthy but not answering: the environment is still coming
    // up, or something between the hostname and the pod is wrong. Both are
    // "not ready", and the product must not round that up.
    return { serving: false, phase: sync === 'Synced' ? 'starting' : 'syncing', url, httpStatus: code };
  }

  async logs({ slug, prNumber, container, tailLines = 200 }) {
    return this.cluster.podLogs(this.namespaceFor({ slug, prNumber }), { container, tailLines });
  }
}

/**
 * An in-memory orchestrator for tests and for running the control plane without
 * a cluster. It implements the same contract, including the rule that nothing
 * is serving until something says so.
 */
class FakeOrchestrator {
  constructor({ baseHost = 'test.nip.io' } = {}) {
    this.baseHost = baseHost;
    this.labels = new Set();
    this.serving = new Set();
    this.calls = [];
  }
  key({ owner, repo, prNumber }) { return `${owner}/${repo}#${prNumber}`; }
  urlFor({ slug, prNumber }) { return `https://${slug}-pr-${prNumber}.${this.baseHost}`; }
  async create(spec) { this.calls.push(['create', spec]); this.labels.add(this.key(spec)); return { accepted: true }; }
  async update(spec) { this.calls.push(['update', spec]); return { accepted: true }; }
  async destroy(spec) { this.calls.push(['destroy', spec]); this.labels.delete(this.key(spec)); this.serving.delete(this.key(spec)); return { accepted: true }; }
  async rollback(spec) { this.calls.push(['rollback', spec]); return { accepted: true, target: spec.imageTag }; }
  async status(spec) {
    const serving = this.serving.has(this.key(spec));
    return { serving, phase: serving ? 'serving' : 'starting', url: this.urlFor(spec) };
  }
  async logs() { return ['line one', 'line two']; }
  /** Test control: make an environment answer. */
  markServing(spec) { this.serving.add(this.key(spec)); }
}

module.exports = { ArgoCDOrchestrator, FakeOrchestrator };
