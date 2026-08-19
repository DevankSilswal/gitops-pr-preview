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
const https = require('node:https');

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

class InClusterKubernetes {
  constructor({ argocdNamespace = 'argocd', timeoutMs = 15000 } = {}) {
    this.argocdNamespace = argocdNamespace;
    this.timeoutMs = timeoutMs;
    this.host = process.env.KUBERNETES_SERVICE_HOST;
    this.port = process.env.KUBERNETES_SERVICE_PORT || '443';
    this.token = fs.readFileSync(`${SA}/token`, 'utf8').trim();
    // The cluster CA, and it has to be handed to the request. The first
    // version of this file read it into a field and then called fetch, with a
    // comment asserting Node would honour it — Node does not: its fetch is
    // undici and takes no ca option, so every call failed with the wonderfully
    // uninformative 'fetch failed'. node:https takes the CA directly, which is
    // the difference between verifying the connection and not making it.
    this.ca = fs.readFileSync(`${SA}/ca.crt`);
  }

  static available() {
    return Boolean(process.env.KUBERNETES_SERVICE_HOST) && fs.existsSync(`${SA}/token`);
  }

  #request(method, path, body) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: this.host, port: this.port, path, method,
        ca: this.ca,
        timeout: this.timeoutMs,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/merge-patch+json' } : {}),
        },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          if (res.statusCode === 404) return resolve(null);
          if (res.statusCode >= 400) {
            // A cluster that cannot be reached is not an empty cluster. Rejecting
            // means the caller records UNKNOWN rather than concluding that every
            // environment disappeared.
            const err = new Error(`kubernetes ${method} ${path} → ${res.statusCode}: ${text.slice(0, 160)}`);
            err.status = res.statusCode;
            return reject(err);
          }
          try { resolve(text ? JSON.parse(text) : null); }
          catch (err) { reject(new Error(`kubernetes ${method} ${path}: unparseable response`)); }
        });
      });
      req.on('timeout', () => req.destroy(new Error(`kubernetes ${method} ${path}: timed out after ${this.timeoutMs}ms`)));
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async #get(path) { return this.#request('GET', path); }

  async #patch(path, body) { return this.#request('PATCH', path, body); }

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
    // Logs are text, not JSON, so this cannot go through #request.
    return new Promise((resolve) => {
      const req = https.request({
        host: this.host, port: this.port, ca: this.ca, timeout: this.timeoutMs,
        path: `/api/v1/namespaces/${namespace}/pods/${pod.metadata.name}/log?tailLines=${tailLines}`,
        headers: { authorization: `Bearer ${this.token}` },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve(res.statusCode >= 400 ? [`logs unavailable: ${res.statusCode}`] : text.split('\n')));
      });
      req.on('error', (e) => resolve([`logs unavailable: ${e.message}`]));
      req.on('timeout', () => { req.destroy(); resolve(['logs unavailable: timed out']); });
      req.end();
    });
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
