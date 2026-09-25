/* global window, chrome */
// Message endpoint for the service worker, plus the on-page status HUD.
window.LEA = window.LEA || {};

(function (LEA) {
  const D = LEA.dom;

  // After the extension is reloaded, older injected copies are orphaned and
  // every chrome.* call throws. Fail quietly instead of spamming the console.
  function send(msg) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch { /* orphaned context */ }
  }

  function report(level, message) {
    send({ type: 'CS_LOG', level, message });
  }

  // Everything below is routed through whichever site adapter claims this page,
  // so this file contains no board-specific logic at all.
  const site = () => LEA.sites.current();
  const noSite = { error: 'no site adapter for ' + location.hostname };

  const handlers = {
    async PING() {
      const s = site();
      return {
        ok: true,
        url: location.href,
        site: s ? s.id : null,
        // "ready" means this board's results list has rendered, which is what
        // the service worker waits for after navigating.
        ready: !!(s && document.querySelector(readySelector(s)))
      };
    },

    async COLLECT_JOBS() {
      const s = site();
      if (!s) return noSite;
      return s.collectJobs();
    },

    async OPEN_JOB({ job }) {
      const s = site();
      if (!s) return noSite;
      return s.openJob(job);
    },

    async READ_JOB({ job }) {
      const s = site();
      if (!s) return noSite;
      return s.readJob(job);
    },

    async APPLY_JOB({ job, cfg }) {
      const s = site();
      if (!s) return { status: 'failed', reason: noSite.error };
      try {
        return await s.quickApply(job, cfg, report);
      } catch (e) {
        try { await s.abort(report); } catch { /* best effort */ }
        return { status: 'failed', reason: 'exception: ' + (e && e.message ? e.message : String(e)) };
      }
    },

    async NEXT_PAGE() {
      const s = site();
      if (!s) return noSite;
      return { ok: await s.goToNextPage() };
    },

    async ABORT() {
      const s = site();
      if (s) { try { await s.abort(report); } catch { /* nothing open */ } }
      hud.hide();
      return { ok: true };
    },

    // Opens the employer's own site, whichever board we are on.
    async CLICK_APPLY() {
      const s = site();
      if (!s) return noSite;
      return s.clickExternalApply();
    }
  };

  // The one remaining per-site detail out here: what "the list has rendered"
  // looks like. Each adapter's first card selector answers it.
  function readySelector(s) {
    if (s.id === 'linkedin') return LEA.SEL.jobCard.join(',');
    return (s.SEL && s.SEL.card ? s.SEL.card : ['body']).join(',');
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const fn = handlers[msg && msg.type];
    if (!fn) return false;
    Promise.resolve(fn(msg))
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e && e.message || e) }));
    return true;   // async response
  });

  // --------------------------------------------------------------- the HUD

  const hud = (function () {
    let root = null;

    function build() {
      if (root) return root;
      root = document.createElement('div');
      root.id = 'lea-hud';
      Object.assign(root.style, {
        position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483646',
        background: '#1b1f23', color: '#fff', borderRadius: '10px',
        padding: '10px 12px', width: '260px', boxShadow: '0 6px 24px rgba(0,0,0,.35)',
        font: '12px -apple-system, Segoe UI, Roboto, sans-serif', lineHeight: '1.5'
      });
      root.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:#4ade80" id="lea-dot"></span>' +
        '<strong style="flex:1">jobDo</strong>' +
        '<button id="lea-stop" style="background:#b91c1c;color:#fff;border:0;border-radius:12px;padding:3px 10px;cursor:pointer;font-size:11px">Stop</button>' +
        '</div>' +
        '<div id="lea-phase" style="margin-top:6px;color:#cbd5e1"></div>' +
        '<div id="lea-job" style="color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>' +
        '<div id="lea-counts" style="margin-top:4px;color:#94a3b8"></div>';
      document.body.appendChild(root);
      root.querySelector('#lea-stop').onclick = () => {
        send({ type: 'STOP_RUN' });
        root.querySelector('#lea-phase').textContent = 'stopping...';
      };
      return root;
    }

    return {
      update(run) {
        if (!run || !run.active) return this.hide();
        const el = build();
        el.style.display = 'block';
        el.querySelector('#lea-dot').style.background = run.paused ? '#fbbf24' : '#4ade80';
        el.querySelector('#lea-phase').textContent = run.phase || '';
        el.querySelector('#lea-job').textContent = run.current
          ? run.current.title + ' - ' + run.current.company : '';
        el.querySelector('#lea-counts').textContent =
          'applied ' + run.applied + '  skipped ' + run.skipped + '  failed ' + run.failed + '  seen ' + run.seen;
      },
      hide() { if (root) root.style.display = 'none'; }
    };
  })();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.run) hud.update(changes.run.newValue);
  });

  chrome.storage.local.get('run').then((r) => hud.update(r.run)).catch(() => {});

  // The script is injected across whole job boards; only the job pages matter,
  // and logging the rest would bury the run log.
  if (LEA.sites.current() && /job|search|viewjob|srp/i.test(location.pathname + location.search)) {
    const s = LEA.sites.current();
    report('info', s.name + ' content script ready on ' + location.pathname);
  }
})(window.LEA);
