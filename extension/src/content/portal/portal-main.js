/* global window, chrome */
// Message endpoint inside a company career-site tab.
window.LEA = window.LEA || {};

(function (LEA) {
  // Resolves once the background has the message, or at once if it cannot.
  function send(msg) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return Promise.resolve();
      return chrome.runtime.sendMessage(msg).catch(() => {});
    } catch { return Promise.resolve(); /* orphaned after an extension reload */ }
  }

  const report = (level, message) => { send({ type: 'CS_LOG', level, message }); };

  const handlers = {
    async PORTAL_PING() {
      return { ok: true, url: location.href, host: location.hostname, hasForm: !!LEA.portal.pickForm() };
    },

    async PORTAL_APPLY({ job, cfg, ats, atsHosts }) {
      try {
        const res = await LEA.portal.apply(job, cfg, ats, report, {
          atsHosts,
          submitting: () => send({ type: 'PORTAL_SUBMITTING' })
        });
        if (res.keepTab) banner(res.reason, job);
        return res;
      } catch (e) {
        return { status: 'failed', reason: 'portal exception: ' + (e && e.message ? e.message : String(e)), keepTab: true };
      }
    },

    // Submit took the tab to this page; is it a confirmation?
    async PORTAL_CONFIRM({ ats }) {
      const res = await LEA.portal.afterSubmit(ats);
      if (res.keepTab) banner(res.reason, null);
      return res;
    },

    // Used by the options page "test on this page" button.
    async PORTAL_INSPECT() {
      const form = LEA.portal.pickForm();
      if (!form) return { ok: false, reason: 'no form found' };
      return {
        ok: true,
        host: location.hostname,
        fields: LEA.portal.questions(form).map((q) => ({
          label: q.label, kind: q.kind, required: !!q.required,
          options: (q.options || []).map((o) => o.label).slice(0, 12)
        })),
        submit: (() => { const b = LEA.portal.findSubmit(form); return b ? (b.innerText || b.value || '').trim() : null; })()
      };
    }
  };

  // The background injects this file when a page has no copy yet, and the
  // manifest's copy can still arrive afterwards. Two listeners would both run
  // PORTAL_APPLY on the same form, so the newest one replaces the last.
  if (LEA.portalListener) {
    try { chrome.runtime.onMessage.removeListener(LEA.portalListener); } catch { /* orphaned */ }
  }
  LEA.portalListener = (msg, _s, sendResponse) => {
    const fn = handlers[msg && msg.type];
    if (!fn) return false;
    Promise.resolve(fn(msg)).then(sendResponse).catch((e) => sendResponse({ error: String(e && e.message || e) }));
    return true;
  };
  chrome.runtime.onMessage.addListener(LEA.portalListener);

  // When the run hands a tab back to you, say so on the page itself - a line
  // in the extension log is easy to miss when a tab opens in the background.
  // Not "filled this in": on a sign-in page or a list of openings nothing was.
  function banner(reason, job) {
    if (document.getElementById('lea-handoff')) return;
    LEA.dom.panel({
      id: 'lea-handoff',
      where: 'top',
      tone: 'warn',
      title: 'Over to you',
      body: reason,
      note: job && job.title ? job.title + (job.company ? ' at ' + job.company : '') : '',
      actions: [{ label: 'Dismiss' }]
    });
  }
})(window.LEA);
