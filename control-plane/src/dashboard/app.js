// The dashboard, in the product's own vocabulary.
//
// Nothing here says pod, namespace, Application or Ingress. A developer looking
// at a broken preview should read a sentence about their build and their
// commit; the Kubernetes detail underneath is available, one line down, for the
// person who wants it.
//
// No framework and no build step: the whole surface is a few screens over an
// API that already exists, and a toolchain would be the largest dependency in a
// control plane that currently has none.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) node.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return node;
};

const api = async (path, options) => {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (res.status === 401) { render.signIn(); throw new Error('unauthenticated'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `request failed: ${res.status}`);
  return body;
};

const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const until = (iso) => {
  if (!iso) return 'does not expire';
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
};
const short = (sha) => (sha ? String(sha).slice(0, 7) : '—');
const badge = (status) => el('span', { className: `badge s-${status}` }, status);

// What a failure means, said in terms of the change rather than the cluster.
// The raw message is kept underneath for whoever needs it, never as the
// headline.
const FAILURE = {
  build: (d) => ['The image for this commit did not build.',
    `Nothing was deployed, so the environment is still running ${short(d.lastGood) || 'nothing'}.`],
  image: (d) => ['The image was never published.',
    `The environment asked for the build of ${short(d.commit)} and the registry does not have it — usually a build that failed or was cancelled.`],
  health: (d) => ['The environment started but never became healthy.',
    `It is running, and its health check has not passed${d.healthPath ? ` at ${d.healthPath}` : ''}.`],
  policy: () => ['This pull request is not allowed a preview.', 'A project policy refused it.'],
  capacity: () => ['No environment was free.', 'Every slot on the platform is in use. One frees up when another pull request is closed or goes idle.'],
  unknown: () => ['The environment failed.', 'The platform could not classify why. The detail below is what it saw.'],
};

const render = {
  mount(...nodes) { const app = $('#app'); app.replaceChildren(...nodes.flat()); },

  signIn() {
    $('#who').replaceChildren();
    render.mount(el('div', { className: 'signin' },
      el('h2', {}, 'Sign in'),
      el('p', {}, 'StackPreview shows the preview environments for repositories you have access to.'),
      el('a', { href: '/auth/github' }, el('button', { className: 'primary' }, 'Continue with GitHub'))));
  },

  async whoami() {
    try {
      const { user } = await api('/api/me');
      $('#who').replaceChildren(
        el('span', {}, user.login),
        el('a', { href: '/auth/logout' }, el('button', {}, 'Sign out')));
      return user;
    } catch { return null; }
  },

  async overview() {
    const [{ projects }, { previews }, capacity, health, metrics] = await Promise.all([
      api('/api/projects'), api('/api/previews'),
      api('/api/platform/capacity'), api('/api/platform/health'),
      api('/api/platform/metrics').catch(() => null),
    ]);

    const count = (s) => previews.filter((p) => p.status === s).length;
    const tiles = el('div', { className: 'row' },
      tile('Previews', previews.length, `${count('READY')} ready`),
      tile('Building', count('BUILDING') + count('PROVISIONING') + count('UPDATING'), 'in progress'),
      tile('Failed', count('FAILED'), count('FAILED') ? 'needs attention' : 'none'),
      tile('Capacity', `${capacity.used}/${capacity.max}`,
        capacity.unknownRepositories ? `${capacity.unknownRepositories} repository unreachable` : `${capacity.remaining} free`),
      tile('Provisioning', metrics?.byKind?.first_provision?.p50 != null ? `${metrics.byKind.first_provision.p50}s` : '—',
        metrics?.byKind?.first_provision?.samples ? `p50 over ${metrics.byKind.first_provision.samples} first provisions` : 'not enough samples'),
      tile('Platform', health.node?.ready ? 'Healthy' : 'Degraded',
        health.applications ? `${health.applications.healthy}/${health.applications.total} deployments healthy` : 'status unknown'));

    render.mount(tiles,
      section('Projects', projects.length
        ? table(['Project', 'Repositories', 'Previews'], projects.map((p) => ({
            onclick: () => route(`#/project/${p.id}`),
            cells: [p.name, p.repositories ?? '—', previews.filter((v) => v.projectId === p.id).length],
          })))
        : el('div', { className: 'empty' }, 'No projects yet.')),
      section('Previews', previews.length
        ? table(['Status', 'Repository', 'Pull request', 'Commit', 'Updated'], previews.map((p) => ({
            onclick: () => route(`#/preview/${p.id}`),
            cells: [badge(p.status), p.repository ?? '—', `#${p.pullRequest.number}`,
              el('span', { className: 'mono' }, short(p.commit)), ago(p.observedAt)],
          })))
        : el('div', { className: 'empty' }, 'No previews. Open a pull request on a connected repository.')));
  },

  async project(id) {
    const { project, repositories, previews } = await api(`/api/projects/${id}`);
    const { policy, capped } = await api(`/api/projects/${id}/policies`).catch(() => ({ policy: null, capped: [] }));
    render.mount(crumbs([['Overview', '#/'], [project.name, null]]),
      section('Repositories', repositories.length
        ? table(['Repository', 'Previews enabled', 'Connected'], repositories.map((r) => ({
            cells: [`${r.owner}/${r.name}`, r.enabled ? 'yes' : 'no', ago(r.connected_at)] })))
        : el('div', { className: 'empty' }, 'No repositories connected.')),
      policy ? section('Policy', el('dl', { className: 'kv' },
        kv('Expires after', `${policy.ttl_days} days idle`),
        kv('Environments', String(policy.max_environments)),
        kv('Visibility', policy.visibility),
        kv('Forks', policy.fork_policy),
        ...(capped?.length ? [kv('Adjusted by the platform',
          el('span', { className: 'muted' }, capped.map((c) => `${c.field}: asked ${c.requested}, effective ${c.effective}`).join('; ')))] : []))) : '',
      section('Previews', previews.length
        ? table(['Status', 'Pull request', 'Commit', 'Expires'], previews.map((p) => ({
            onclick: () => route(`#/preview/${p.id}`),
            cells: [badge(p.status), `#${p.pullRequest.number}`,
              el('span', { className: 'mono' }, short(p.commit)), until(p.expiresAt)] })))
        : el('div', { className: 'empty' }, 'No previews.')));
  },

  async preview(id) {
    const { preview, deployments } = await api(`/api/previews/${id}`);
    const current = deployments[0];
    const lastGood = deployments.find((d) => d.is_last_known_good);

    const act = async (label, fn) => {
      const buttons = document.querySelectorAll('.actions button');
      buttons.forEach((b) => { b.disabled = true; });
      try { await fn(); await render.preview(id); }
      catch (err) { alert(`${label} failed: ${err.message}`); buttons.forEach((b) => { b.disabled = false; }); }
    };

    const failed = preview.status === 'FAILED' && current?.failure_kind;
    const [headline, explanation] = failed
      ? (FAILURE[current.failure_kind] || FAILURE.unknown)({
          commit: current.commit_sha, lastGood: lastGood?.commit_sha, healthPath: preview.healthPath })
      : [];

    render.mount(crumbs([['Overview', '#/'], [`${preview.repository} #${preview.pullRequest.number}`, null]]),
      section('Preview', el('dl', { className: 'kv' },
        kv('Status', el('span', {}, badge(preview.status), ' ',
          el('span', { className: 'muted' }, preview.reason || ''))),
        kv('Observed', ago(preview.observedAt)),
        kv('URL', preview.status === 'READY' && preview.url
          ? el('a', { href: preview.url, target: '_blank', rel: 'noreferrer' }, preview.url)
          : el('span', { className: 'muted' }, preview.url ? `${preview.url} — not serving this commit yet` : '—')),
        kv('Repository', preview.repository ?? '—'),
        kv('Pull request', `#${preview.pullRequest.number}${preview.pullRequest.title ? ` · ${preview.pullRequest.title}` : ''}`),
        kv('Commit', el('span', { className: 'mono' }, short(current?.commit_sha))),
        kv('Provisioning', current?.provisioning_seconds != null ? `${current.provisioning_seconds}s` : '—'),
        kv('Expires', until(preview.expiresAt)),
        kv('Certificate', preview.url?.startsWith('https://') ? 'Let’s Encrypt, valid' : '—'),
        kv('Lifecycle', preview.lifecycle))),

      failed ? section('Why it failed', el('div', { className: 'failure' },
        el('h3', {}, headline),
        el('p', { className: 'muted' }, explanation),
        current.failure_detail ? el('details', {},
          el('summary', { className: 'muted' }, 'Platform detail'),
          el('pre', {}, current.failure_detail)) : '')) : '',

      el('div', { className: 'actions' },
        el('button', { className: 'primary', disabled: preview.status !== 'READY',
          onclick: () => window.open(preview.url, '_blank', 'noreferrer') }, 'Open preview'),
        el('button', { onclick: () => act('Redeploy', () => api(`/api/previews/${id}/redeploy`, { method: 'POST' })) }, 'Redeploy'),
        el('button', { disabled: !lastGood,
          onclick: () => act('Rollback', () => api(`/api/previews/${id}/rollback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })) },
          lastGood ? `Roll back to ${short(lastGood.commit_sha)}` : 'Nothing to roll back to'),
        el('button', { className: 'danger', onclick: () => confirm('Destroy this preview environment?')
          && act('Destroy', () => api(`/api/previews/${id}`, { method: 'DELETE' })) }, 'Destroy')),

      section('Deployments', deployments.length
        ? table(['Trigger', 'Commit', 'Result', 'Took', 'When'], deployments.map((d) => ({
            cells: [d.trigger, el('span', { className: 'mono' }, short(d.commit_sha)),
              d.status === 'failed' ? el('span', { className: 's-FAILED' }, d.failure_kind || 'failed') : d.status,
              d.provisioning_seconds != null ? `${d.provisioning_seconds}s` : '—', ago(d.started_at)] })))
        : el('div', { className: 'empty' }, 'No deployments recorded.')),

      section('Logs', el('div', { id: 'logs' }, el('div', { className: 'empty' }, 'Loading…'))));

    api(`/api/previews/${id}/logs`).then(({ lines }) => {
      $('#logs').replaceChildren(lines?.length
        ? el('pre', {}, lines.slice(-200).join('\n'))
        : el('div', { className: 'empty' }, 'No logs.'));
    }).catch((err) => {
      $('#logs').replaceChildren(el('div', { className: 'empty' },
        err.message.includes('permission') ? 'Your role does not include reading logs.' : 'Logs are unavailable.'));
    });
  },
};

const tile = (k, v, sub) => el('div', { className: 'tile' },
  el('div', { className: 'k' }, k), el('div', { className: 'v' }, v), el('div', { className: 'sub' }, sub ?? ''));
const kv = (k, v) => [el('dt', {}, k), el('dd', {}, v)];
const section = (title, body) => body ? el('section', {}, el('h2', {}, title), body) : '';
const crumbs = (parts) => el('nav', { className: 'crumbs' },
  parts.flatMap(([label, href], i) => [i ? ' / ' : '', href ? el('a', { href }, label) : label]));
const table = (headers, rows) => el('table', {},
  el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
  el('tbody', {}, rows.map((r) => el('tr',
    r.onclick ? { className: 'clickable', onclick: r.onclick } : {},
    r.cells.map((c) => el('td', {}, c))))));

async function route(hash) {
  if (hash) window.location.hash = hash;
  const path = window.location.hash.slice(2) || '';
  const user = await render.whoami();
  if (!user) return render.signIn();
  try {
    if (path.startsWith('project/')) return await render.project(path.slice('project/'.length));
    if (path.startsWith('preview/')) return await render.preview(path.slice('preview/'.length));
    return await render.overview();
  } catch (err) {
    if (err.message !== 'unauthenticated') {
      render.mount(el('div', { className: 'empty' }, `Could not load: ${err.message}`));
    }
  }
}

window.addEventListener('hashchange', () => route());
route();
