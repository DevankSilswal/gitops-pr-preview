// The loop that makes READY possible.
//
// reconcile() existed from the first version of the control plane and nothing
// ever called it on a schedule. The consequence was visible the first time a
// real pull request went through the deployed product: the environment served
// 200 for eleven minutes while the product still said BUILDING, because the
// only paths that reconciled were a webhook arriving and somebody opening the
// preview in an API they had not built a UI for yet.
//
// A status that only refreshes when someone asks is not a status. This asks.
'use strict';

class Reconciler {
  /**
   * @param {number} intervalMs how often to sweep. Ten seconds is chosen
   *   against what provisioning actually costs — 21 seconds measured — so a
   *   preview is rarely more than one interval behind the truth.
   */
  constructor({ previews, store, intervalMs = 10000, log = () => {} }) {
    this.previews = previews;
    this.store = store;
    this.intervalMs = intervalMs;
    this.log = log;
    this.timer = null;
    this.running = false;
  }

  async sweep() {
    // Overlapping sweeps would reconcile the same preview twice and race on the
    // transition. One at a time, and a slow cluster simply skips a beat.
    if (this.running) return { skipped: true };
    this.running = true;
    const started = Date.now();
    let checked = 0, changed = 0, failed = 0;
    try {
      for (const preview of this.store.listLivePreviews()) {
        // Terminal states have nothing left to observe.
        if (['DESTROYED', 'REJECTED'].includes(preview.status)) continue;
        checked += 1;
        try {
          const after = await this.previews.reconcile(preview.id);
          if (after && after.status !== preview.status) {
            changed += 1;
            this.log('info', 'preview changed state', {
              preview: preview.id, repository: `${preview.owner}/${preview.repo_name}`,
              pr: preview.pr_number, from: preview.status, to: after.status,
            });
          }
        } catch (err) {
          // One preview failing must not stop the sweep. The next pass tries
          // again, and the error is visible rather than swallowed.
          failed += 1;
          this.log('warn', 'reconcile failed', { preview: preview.id, error: String(err.message).slice(0, 200) });
        }
      }
    } finally {
      this.running = false;
    }
    return { checked, changed, failed, ms: Date.now() - started };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.sweep().catch(() => {}); }, this.intervalMs);
    // Never hold the process open on account of the reconciler alone.
    if (this.timer.unref) this.timer.unref();
    this.log('info', 'reconciler started', { intervalMs: this.intervalMs });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Reconciler };
