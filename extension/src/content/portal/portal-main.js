/* global window, chrome */
// Message endpoint inside a company career-site tab.
window.LEA = window.LEA || {};

(function (LEA) {
  function send(msg) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch { /* orphaned after an extension reload */ }
  }

  const report = (level, message) => send({ type: 'CS_LOG', level, message });

  const handlers = {
    async PORTAL_PING() {
      return { ok: true, url: location.href, host: location.hostname, hasForm: !!LEA.portal.pickForm() };
    },

    async PORTAL_APPLY({ job, cfg, ats }) {
      try {
        const res = await LEA.portal.apply(job, cfg, ats, report);
        if (res.keepTab) banner(res.reason, job);
        return res;
      } catch (e) {
        return { status: 'failed', reason: 'portal exception: ' + (e && e.message ? e.message : String(e)), keepTab: true };
      }
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

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    const fn = handlers[msg && msg.type];
    if (!fn) return false;
    Promise.resolve(fn(msg)).then(sendResponse).catch((e) => sendResponse({ error: String(e && e.message || e) }));
    return true;
  });

  // When the run hands a tab back to you, say so on the page itself - a line
  // in the extension log is easy to miss when a tab opens in the background.
  function banner(reason, job) {
    if (document.getElementById('lea-handoff')) return;
    const el = document.createElement('div');
    el.id = 'lea-handoff';
    Object.assign(el.style, {
      position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647',
      background: '#0a66c2', color: '#fff', padding: '10px 16px',
      font: '13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif',
      display: 'flex', gap: '12px', alignItems: 'center',
      boxShadow: '0 2px 10px rgba(0,0,0,.25)'
    });
    const txt = document.createElement('div');
    txt.style.flex = '1';
    txt.innerHTML = '<b>Easy Apply Autopilot filled this in for you.</b> ';
    txt.appendChild(document.createTextNode(reason + (job && job.title ? '  —  ' + job.title + ' at ' + job.company : '')));
    const close = document.createElement('button');
    close.textContent = 'Dismiss';
    Object.assign(close.style, {
      background: 'rgba(255,255,255,.15)', color: '#fff', border: '1px solid rgba(255,255,255,.5)',
      borderRadius: '14px', padding: '4px 12px', cursor: 'pointer', font: 'inherit'
    });
    close.onclick = () => el.remove();
    el.append(txt, close);
    document.body.appendChild(el);
  }
})(window.LEA);
