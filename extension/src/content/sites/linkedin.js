/* global window */
// LinkedIn adapter. The work itself lives in scrape.js (results list and job
// pane) and easy-apply.js (the modal state machine); this only presents them
// through the shared site interface.
window.LEA = window.LEA || {};

(function (LEA) {
  LEA.sites.register({
    id: 'linkedin',
    name: 'LinkedIn',
    matches: (host) => /(^|\.)linkedin\.com$/.test(host),

    async collectJobs() {
      const res = await LEA.scrape.collectJobs();
      return {
        jobs: res.jobs.map((j) => ({ ...j, quickApply: j.easyApply, site: 'linkedin' })),
        hasNext: res.hasNext,
        error: res.error
      };
    },

    // LinkedIn keeps the list and the detail pane on one page, so a job is
    // opened by clicking its card rather than by navigating.
    async openJob(job) {
      const res = await LEA.scrape.openJob(job);
      if (!res.ok) return res;
      return { ...res, hasQuickApply: res.hasEasyApply, hasExternalApply: !res.hasEasyApply };
    },

    async readJob(job) {
      return this.openJob(job);
    },

    async quickApply(job, cfg, report) {
      return LEA.easyApply.applyToJob(job, cfg, report);
    },

    async clickExternalApply() {
      const btn = LEA.scrape.externalApplyButton();
      if (!btn) return { ok: false, reason: 'no company-site Apply button on this posting' };
      await LEA.dom.clickEl(btn);
      await LEA.dom.sleep(1400);
      const dialog = document.querySelector('div[role="dialog"], .artdeco-modal');
      if (dialog && LEA.dom.visible(dialog)) {
        const cont = LEA.dom.findButton([/^continue$/i, /^apply on company (site|website)$/i], dialog);
        if (cont) { await LEA.dom.clickEl(cont); await LEA.dom.sleep(800); }
      }
      return { ok: true };
    },

    async goToNextPage() {
      return LEA.scrape.goToNextPage();
    },

    async abort(report) {
      return LEA.easyApply.discard(report);
    }
  });
})(window.LEA);
