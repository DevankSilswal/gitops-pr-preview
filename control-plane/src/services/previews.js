// PreviewService — the product's behaviour, in one place.
//
// Everything that changes a preview goes through here: the webhook handler, the
// API and the sweep all call the same methods, so the state machine and the
// audit trail cannot be bypassed by adding a route.
//
// The invariant this file exists to hold: **the product never claims READY
// unless the orchestrator observed the environment answering.** A deployment
// finishing is not evidence. ArgoCD reporting Synced is not evidence. An HTTP
// 200 from the hostname a reviewer will click is.
'use strict';

const state = require('../domain/preview-state.js');
const policyDomain = require('../domain/policy.js');

class PreviewService {
  constructor({ store, orchestrator, platformLimits, audit, now = () => new Date().toISOString() }) {
    this.store = store;
    this.orchestrator = orchestrator;
    this.platformLimits = platformLimits;
    this.audit = audit;
    this.now = now;
  }

  #context(repository) {
    const project = this.store.getProject(repository.project_id);
    const rawPolicy = this.store.getPolicy(project.id);
    const { policy, capped } = policyDomain.effectivePolicy(rawPolicy, this.platformLimits);
    return { project, policy, capped };
  }

  /**
   * A pull request was opened or reopened.
   *
   * Refusal is a first-class outcome with a reason, not an exception: capacity
   * full and fork-needs-approval are normal, and the reason is what gets posted
   * back to the pull request.
   */
  async onPullRequestOpened({ owner, name, prNumber, title, author, isBot, isFork, headSha, updatedAt, approvedForPreview = false }, actorUserId = null) {
    const repository = this.store.findRepository(owner, name);
    if (!repository) return { outcome: 'ignored', reason: 'repository is not connected to any project' };

    const { project, policy } = this.#context(repository);
    const census = policyDomain.census(this.store.listLivePreviews());

    const decision = policyDomain.admit({
      pullRequest: { isBot, isFork, approvedForPreview },
      repository, policy, platformLimits: this.platformLimits, census,
      unknownRepositories: this.platformLimits.unknownRepositories ?? 0,
    });

    const existing = this.store.findPreview(repository.id, prNumber);
    if (existing && existing.destroyed_at === null) {
      return this.onPullRequestUpdated({ owner, name, prNumber, headSha, updatedAt });
    }

    if (!decision.admit) {
      const preview = this.store.createPreview({
        repositoryId: repository.id, prNumber, prTitle: title, prAuthor: author,
        status: state.STATES.REJECTED, statusReason: decision.message,
      });
      this.audit.record({ organizationId: project.organization_id, projectId: project.id,
        actorUserId, action: 'preview.rejected', subjectType: 'preview', subjectId: preview.id,
        detail: { code: decision.code, prNumber } });
      return { outcome: 'rejected', code: decision.code, message: decision.message, preview };
    }

    const expiresAt = policyDomain.expiresAt(updatedAt || this.now(), policy.ttl_days);
    const preview = this.store.createPreview({
      repositoryId: repository.id, prNumber, prTitle: title, prAuthor: author,
      status: state.STATES.QUEUED, statusReason: state.HUMAN.QUEUED,
      namespace: `${project.slug}-pr-${prNumber}`,
      url: this.orchestrator.urlFor({ slug: project.slug, prNumber }),
      expiresAt,
    });
    this.store.startDeployment({ previewId: preview.id, commitSha: headSha, trigger: 'open' });

    await this.orchestrator.create({ owner, repo: name, prNumber, slug: project.slug });
    const moved = this.#transition(preview, state.STATES.BUILDING, state.HUMAN.BUILDING);

    this.audit.record({ organizationId: project.organization_id, projectId: project.id,
      actorUserId, action: 'preview.created', subjectType: 'preview', subjectId: preview.id,
      detail: { prNumber, commit: headSha } });

    return { outcome: 'created', preview: moved };
  }

  /** A new commit. The same environment updates; a second one is never created. */
  async onPullRequestUpdated({ owner, name, prNumber, headSha, updatedAt }) {
    const repository = this.store.findRepository(owner, name);
    if (!repository) return { outcome: 'ignored', reason: 'repository is not connected' };
    const preview = this.store.findPreview(repository.id, prNumber);
    if (!preview || preview.destroyed_at) return { outcome: 'ignored', reason: 'no live preview for this pull request' };

    const { project, policy } = this.#context(repository);
    this.store.startDeployment({ previewId: preview.id, commitSha: headSha, trigger: 'synchronize' });

    // From READY the honest state is UPDATING; from anything else the commit
    // simply replaces what was being attempted.
    const target = preview.status === state.STATES.READY ? state.STATES.UPDATING : state.STATES.BUILDING;
    const moved = this.#transition(preview, target, state.HUMAN[target], {
      expiresAt: policyDomain.expiresAt(updatedAt || this.now(), policy.ttl_days),
    });

    await this.orchestrator.update({ owner, repo: name, prNumber, slug: project.slug });
    this.audit.record({ organizationId: project.organization_id, projectId: project.id,
      action: 'preview.updated', subjectType: 'preview', subjectId: preview.id,
      detail: { prNumber, commit: headSha } });
    return { outcome: 'updated', preview: moved };
  }

  async onPullRequestClosed({ owner, name, prNumber }, actorUserId = null) {
    const repository = this.store.findRepository(owner, name);
    if (!repository) return { outcome: 'ignored' };
    const preview = this.store.findPreview(repository.id, prNumber);
    if (!preview || preview.destroyed_at) return { outcome: 'ignored', reason: 'already gone' };
    return this.destroy(preview.id, actorUserId, 'the pull request was closed');
  }

  async destroy(previewId, actorUserId = null, reason = 'destroyed') {
    const preview = this.store.getPreview(previewId);
    if (!preview) return { outcome: 'ignored' };
    if (preview.lifecycle === 'pinned') {
      // Multiple independent protections, per the pinned-safety rule. This is
      // the product-level one; the platform sweep cannot see pinned Applications
      // at all, and the permanent demo is not a pull request in any repository.
      return { outcome: 'refused', reason: 'this environment is pinned and does not expire' };
    }
    if (preview.status === state.STATES.DESTROYED) return { outcome: 'ignored', reason: 'already destroyed' };

    const repository = this.store.getRepository(preview.repository_id);
    const { project } = this.#context(repository);

    this.#transition(preview, state.STATES.DESTROYING, reason);
    await this.orchestrator.destroy({ owner: repository.owner, repo: repository.name, prNumber: preview.pr_number, slug: project.slug });
    const done = this.store.updatePreviewStatus(previewId, {
      status: state.STATES.DESTROYED, reason, destroyedAt: this.now(),
    });

    this.audit.record({ organizationId: project.organization_id, projectId: project.id,
      actorUserId, action: 'preview.destroyed', subjectType: 'preview', subjectId: previewId,
      detail: { reason } });
    return { outcome: 'destroyed', preview: done };
  }

  /**
   * Ask the orchestrator what is actually true and record it.
   *
   * This is the only path to READY. Called by the reconciler on a timer and by
   * the API when someone opens a preview page, so a stale row is corrected by
   * being looked at.
   */
  async reconcile(previewId) {
    const preview = this.store.getPreview(previewId);
    if (!preview || preview.destroyed_at) return null;
    const repository = this.store.getRepository(preview.repository_id);
    const { project } = this.#context(repository);

    const observed = await this.orchestrator.status({ slug: project.slug, prNumber: preview.pr_number,
      owner: repository.owner, repo: repository.name });

    if (observed.serving) {
      if (preview.status === state.STATES.READY) {
        return this.store.updatePreviewStatus(previewId, { status: state.STATES.READY, reason: state.HUMAN.READY, url: observed.url });
      }
      const readyAt = this.now();
      const current = this.store.currentDeployment(previewId);
      if (current && current.status !== 'succeeded') {
        const seconds = Math.round((Date.parse(readyAt) - Date.parse(current.started_at)) / 1000);
        this.store.finishDeployment(current.id, { status: 'succeeded', provisioningSeconds: seconds });
      }
      // PROVISIONING is the legal predecessor of READY; a preview observed
      // serving straight out of BUILDING passes through it rather than skipping,
      // so the transition table stays the single description of what may happen.
      if (preview.status === state.STATES.BUILDING) {
        this.#transition(preview, state.STATES.PROVISIONING, state.HUMAN.PROVISIONING);
      }
      const refreshed = this.store.getPreview(previewId);
      return this.#transition(refreshed, state.STATES.READY, state.HUMAN.READY,
        { url: observed.url, readyAt, confirmedServing: true });
    }

    if (observed.failureKind) {
      const current = this.store.currentDeployment(previewId);
      if (current && current.status !== 'failed') {
        this.store.finishDeployment(current.id, {
          status: 'failed', failureKind: observed.failureKind, failureDetail: observed.detail,
        });
      }
      const message = state.describeFailure(observed.failureKind, {
        commit: current && current.commit_sha, path: repository.health_path,
      });
      if (preview.status !== state.STATES.FAILED) {
        return this.#transition(preview, state.STATES.FAILED, message);
      }
      return this.store.updatePreviewStatus(previewId, { status: state.STATES.FAILED, reason: message });
    }

    // Still coming up. Recording the observation time is the point: the UI can
    // then say "as of 20 seconds ago" instead of implying the row is current.
    return this.store.updatePreviewStatus(previewId, {
      status: preview.status, reason: state.HUMAN[preview.status],
    });
  }

  async redeploy(previewId, actorUserId) {
    const preview = this.store.getPreview(previewId);
    if (!preview || preview.destroyed_at) throw new Error('no live preview');
    const repository = this.store.getRepository(preview.repository_id);
    const { project } = this.#context(repository);
    const last = this.store.currentDeployment(previewId);

    this.store.startDeployment({ previewId, commitSha: last ? last.commit_sha : 'unknown', trigger: 'redeploy' });
    const moved = this.#transition(preview, state.STATES.BUILDING, 'Redeploying at the request of a user');
    await this.orchestrator.update({ owner: repository.owner, repo: repository.name, prNumber: preview.pr_number, slug: project.slug });
    this.audit.record({ organizationId: project.organization_id, projectId: project.id, actorUserId,
      action: 'preview.redeployed', subjectType: 'preview', subjectId: previewId });
    return moved;
  }

  async rollback(previewId, actorUserId, deploymentId = null) {
    const preview = this.store.getPreview(previewId);
    if (!preview || preview.destroyed_at) throw new Error('no live preview');
    const target = deploymentId
      ? this.store.listDeployments(previewId).find((d) => d.id === deploymentId)
      : this.store.lastKnownGood(previewId);
    if (!target) {
      // Refusing is the only safe answer. Rolling back to "something older"
      // without knowing it ever worked would deploy an untested image and call
      // it a recovery.
      throw new Error('there is no previously successful deployment to roll back to');
    }
    const repository = this.store.getRepository(preview.repository_id);
    const { project } = this.#context(repository);

    this.store.startDeployment({ previewId, commitSha: target.commit_sha, imageTag: target.image_tag, trigger: 'rollback' });
    const moved = this.#transition(preview, state.STATES.UPDATING, `Rolling back to ${target.commit_sha.slice(0, 7)}`);
    await this.orchestrator.rollback({ slug: project.slug, prNumber: preview.pr_number, imageTag: target.image_tag });
    this.audit.record({ organizationId: project.organization_id, projectId: project.id, actorUserId,
      action: 'preview.rolled_back', subjectType: 'preview', subjectId: previewId,
      detail: { to: target.commit_sha } });
    return moved;
  }

  #transition(preview, to, reason, extra = {}) {
    state.assertTransition(preview.status, to, { confirmedServing: extra.confirmedServing });
    return this.store.updatePreviewStatus(preview.id, {
      status: to, reason,
      url: extra.url, readyAt: extra.readyAt, expiresAt: extra.expiresAt,
    });
  }
}

/** Audit is a service so that "was this recorded?" is answerable in a test. */
class AuditService {
  constructor(store) { this.store = store; }
  record(event) { return this.store.recordAudit(event); }
  list(organizationId, limit) { return this.store.listAudit(organizationId, limit); }
}

module.exports = { PreviewService, AuditService };
