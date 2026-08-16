// The only file in the control plane that knows Kubernetes exists.
//
// Read-mostly on purpose. The product's lifecycle verbs are GitHub labels — the
// ApplicationSet and ArgoCD do the applying — so this adapter exists to observe
// and to perform the one write the product genuinely needs, which is pointing an
// Application at an older image for a rollback.
//
// It shells out to kubectl rather than carrying a Kubernetes client library.
// That is a deliberate trade at this size: kubectl is already how this cluster
// is operated, its output is stable, and it keeps the control plane at zero
// dependencies. If this ever needs watches or high call volume, this is the one
// file that changes.
'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

class KubectlCluster {
  constructor({ kubectl = 'kubectl', namespace = 'argocd', timeoutMs = 20000 } = {}) {
    this.kubectl = kubectl;
    this.argocdNamespace = namespace;
    this.timeoutMs = timeoutMs;
  }

  async #json(args) {
    try {
      const { stdout } = await run(this.kubectl, [...args, '-o', 'json', `--request-timeout=${Math.floor(this.timeoutMs / 1000)}s`],
        { timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (err) {
      if (/NotFound|not found/.test(String(err.stderr || err.message))) return null;
      // A cluster that cannot be reached is not an empty cluster. Throwing here
      // means the caller records UNKNOWN rather than reporting zero previews and
      // letting something conclude they were all destroyed.
      throw new Error(`kubectl ${args.join(' ')}: ${String(err.stderr || err.message).trim()}`);
    }
  }

  /** ArgoCD's opinion — applied and healthy — which is not the same as serving. */
  async getApplication(name) {
    const app = await this.#json(['get', 'application', name, '-n', this.argocdNamespace]);
    if (!app) return null;
    return {
      name,
      sync: app.status?.sync?.status ?? 'Unknown',
      health: app.status?.health?.status ?? 'Unknown',
      revision: app.status?.sync?.revision ?? null,
    };
  }

  async listApplications() {
    const list = await this.#json(['get', 'applications', '-n', this.argocdNamespace]);
    return (list?.items ?? []).map((a) => ({
      name: a.metadata.name,
      sync: a.status?.sync?.status ?? 'Unknown',
      health: a.status?.health?.status ?? 'Unknown',
      lifecycle: a.metadata?.labels?.['preview.lifecycle'] ?? 'ephemeral',
      generated: (a.metadata?.ownerReferences ?? []).some((o) => o.kind === 'ApplicationSet'),
    }));
  }

  /** Why a workload is not running, in the shape the orchestrator translates. */
  async podFailures(namespace) {
    const pods = await this.#json(['get', 'pods', '-n', namespace]);
    if (!pods) return [];
    const failures = [];
    for (const pod of pods.items ?? []) {
      for (const cs of pod.status?.containerStatuses ?? []) {
        const w = cs.state?.waiting;
        if (w && w.reason && w.reason !== 'ContainerCreating') {
          failures.push({ name: pod.metadata.name, reason: w.reason, message: w.message });
        }
      }
      if (pod.status?.phase === 'Failed') {
        failures.push({ name: pod.metadata.name, reason: 'Failed', message: pod.status.message });
      }
    }
    return failures;
  }

  async podLogs(namespace, { container, tailLines = 200 } = {}) {
    const args = ['logs', '-n', namespace, '--all-containers=true', `--tail=${tailLines}`, '-l', 'app.kubernetes.io/name=preview-app'];
    if (container) args.push('-c', container);
    try {
      const { stdout } = await run(this.kubectl, args, { timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
      return stdout.split('\n');
    } catch (err) {
      return [`logs unavailable: ${String(err.stderr || err.message).trim()}`];
    }
  }

  /** The one write. Used by rollback, and by nothing else. */
  async setApplicationImageTag(application, imageTag) {
    const patch = JSON.stringify({
      spec: { source: { helm: { parameters: [{ name: 'image.tag', value: imageTag }] } } },
    });
    await run(this.kubectl, ['patch', 'application', application, '-n', this.argocdNamespace,
      '--type=merge', '-p', patch, `--request-timeout=${Math.floor(this.timeoutMs / 1000)}s`],
      { timeout: this.timeoutMs });
    return { application, imageTag };
  }

  /** Platform health, for the product's own health page. */
  async platformHealth() {
    const [nodes, apps] = await Promise.all([
      this.#json(['get', 'nodes']),
      this.listApplications(),
    ]);
    const node = (nodes?.items ?? [])[0];
    const ready = (node?.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
    return {
      node: { name: node?.metadata?.name ?? 'unknown', ready },
      applications: {
        total: apps.length,
        synced: apps.filter((a) => a.sync === 'Synced').length,
        healthy: apps.filter((a) => a.health === 'Healthy').length,
      },
    };
  }
}

/** An HTTP probe with a short timeout — the evidence a preview is serving. */
async function probe(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { KubectlCluster, probe };
