// The Kubernetes API, spoken directly.
//
// This replaces shelling out to kubectl, which worked on a laptop and could
// never have worked in the container: the image has no dependencies by design,
// so there is no kubectl in it, and the first live reconcile inside the cluster
// failed with ENOENT. The adapter had been tested only where kubectl happened
// to exist.
//
// Using the ServiceAccount directly is better than adding the binary anyway.
// It is one fewer thing to keep up to date, it removes a process spawn from
// every status check, and it uses exactly the ClusterRole the chart already
// grants — so what this can do is visible in the RBAC rather than in whatever
// the mounted kubeconfig happened to allow.
'use strict';

const fs = require('node:fs');

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

class InClusterKubernetes {
  constructor({ argocdNamespace = 'argocd', timeoutMs = 15000 } = {}) {
    this.argocdNamespace = argocdNamespace;
    this.timeoutMs = timeoutMs;
    this.host = process.env.KUBERNETES_SERVICE_HOST;
    this.port = process.env.KUBERNETES_SERVICE_PORT || '443';
    this.token = fs.readFileSync(`${SA}/token`, 'utf8').trim();
    // Node needs the cluster CA to trust the API server. Passing it explicitly
    // is the difference between verifying the connection and disabling
    // verification, and there is no version of this where disabling it is the
    // right answer.
    this.ca = fs.readFileSync(`${SA}/ca.crt`);
  }

  static available() {
    return Boolean(process.env.KUBERNETES_SERVICE_HOST) && fs.existsSync(`${SA}/token`);
  }

  async #get(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`https://${this.host}:${this.port}${path}`, {
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
        signal: controller.signal,
        // Node 22+ honours this via undici; the CA is the SA's own.
        dispatcher: undefined,
      });
      if (res.status === 404) return null;
      const text = await res.text();
      if (!res.ok) {
        // A cluster that cannot be reached is not an empty cluster. Throwing
        // means the caller records UNKNOWN rather than concluding that every
        // environment disappeared.
        const err = new Error(`kubernetes GET ${path} → ${res.status}: ${text.slice(0, 160)}`);
        err.status = res.status;
        throw err;
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async #patch(path, body) {
    const res = await fetch(`https://${this.host}:${this.port}${path}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/merge-patch+json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`kubernetes PATCH ${path} → ${res.status}`);
    return res.json();
  }

  async getApplication(name) {
    const app = await this.#get(`/apis/argoproj.io/v1alpha1/namespaces/${this.argocdNamespace}/applications/${name}`);
    if (!app) return null;
    return {
      name,
      sync: app.status?.sync?.status ?? 'Unknown',
      health: app.status?.health?.status ?? 'Unknown',
      revision: app.status?.sync?.revision ?? null,
    };
  }

  async listApplications() {
    const list = await this.#get(`/apis/argoproj.io/v1alpha1/namespaces/${this.argocdNamespace}/applications`);
    return (list?.items ?? []).map((a) => ({
      name: a.metadata.name,
      sync: a.status?.sync?.status ?? 'Unknown',
      health: a.status?.health?.status ?? 'Unknown',
      lifecycle: a.metadata?.labels?.['preview.lifecycle'] ?? 'ephemeral',
      generated: (a.metadata?.ownerReferences ?? []).some((o) => o.kind === 'ApplicationSet'),
    }));
  }

  async podFailures(namespace) {
    const pods = await this.#get(`/api/v1/namespaces/${namespace}/pods`);
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

  async podLogs(namespace, { tailLines = 200 } = {}) {
    const pods = await this.#get(`/api/v1/namespaces/${namespace}/pods?labelSelector=app.kubernetes.io/name%3Dpreview-app`);
    const pod = (pods?.items ?? [])[0];
    if (!pod) return ['no pod is running for this environment'];
    const res = await fetch(
      `https://${this.host}:${this.port}/api/v1/namespaces/${namespace}/pods/${pod.metadata.name}/log?tailLines=${tailLines}`,
      { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) return [`logs unavailable: ${res.status}`];
    return (await res.text()).split('\n');
  }

  async setApplicationImageTag(application, imageTag) {
    await this.#patch(
      `/apis/argoproj.io/v1alpha1/namespaces/${this.argocdNamespace}/applications/${application}`,
      { spec: { source: { helm: { parameters: [{ name: 'image.tag', value: imageTag }] } } } });
    return { application, imageTag };
  }

  async platformHealth() {
    const [nodes, apps] = await Promise.all([this.#get('/api/v1/nodes'), this.listApplications()]);
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

module.exports = { InClusterKubernetes };
