/* global window */
// Reads the search results list and the job details pane.
window.LEA = window.LEA || {};

(function (LEA) {
  const { q, qa, text, waitFor, clickEl, sleep, visible, scrollThrough } = LEA.dom;
  const SEL = LEA.SEL;

  function jobIdOf(card) {
    const direct = card.getAttribute('data-occludable-job-id') || card.getAttribute('data-job-id');
    if (direct) return String(direct);
    const inner = card.querySelector('[data-job-id]');
    if (inner) return String(inner.getAttribute('data-job-id'));
    const link = card.querySelector('a[href*="/jobs/view/"]');
    if (link) {
      const m = link.getAttribute('href').match(/\/jobs\/view\/(\d+)/);
      if (m) return m[1];
    }
    return '';
  }

  // The results column is its own scroll container; find whichever ancestor
  // actually scrolls so virtualised cards get rendered.
  function scrollParent(el) {
    let n = el;
    while (n && n !== document.body) {
      const st = getComputedStyle(n);
      if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 40) return n;
      n = n.parentElement;
    }
    return document.scrollingElement;
  }

  function readCard(card) {
    const jobId = jobIdOf(card);
    if (!jobId) return null;
    const titleEl = q(SEL.cardTitle, card);
    // LinkedIn renders the title twice (once visually hidden for screen
    // readers), which collapses to "Title Title" - fold the repeat back.
    const title = (text(titleEl) || '').replace(/^(.+?)\s*\1$/, '$1').trim();
    const footer = text(q(SEL.cardFooter, card));
    const whole = text(card);
    return {
      jobId,
      title,
      company: text(q(SEL.cardCompany, card)),
      location: text(q(SEL.cardLocation, card)),
      easyApply: /easy apply/i.test(footer) || /easy apply/i.test(whole),
      alreadyApplied: /\bapplied\b/i.test(footer),
      url: 'https://www.linkedin.com/jobs/view/' + jobId + '/'
    };
  }

  async function collectJobs() {
    const anyCard = q(SEL.jobCard);
    if (!anyCard) return { jobs: [], hasNext: false, error: 'no job cards on page' };

    await scrollThrough(scrollParent(anyCard), 14);

    const seen = new Set();
    const jobs = [];
    for (const card of qa(SEL.jobCard)) {
      const j = readCard(card);
      if (!j || seen.has(j.jobId)) continue;
      seen.add(j.jobId);
      jobs.push(j);
    }
    const nextBtn = LEA.dom.findButton([/^next$/i], document) || q(SEL.paginationNext);
    return { jobs, hasNext: !!(nextBtn && visible(nextBtn) && !nextBtn.disabled) };
  }

  function currentJobIdFromUrl() {
    const u = new URL(location.href);
    return u.searchParams.get('currentJobId') || (location.pathname.match(/\/jobs\/view\/(\d+)/) || [])[1] || '';
  }

  async function openJob(job) {
    const card = qa(SEL.jobCard).find((c) => jobIdOf(c) === job.jobId);
    if (!card) return { ok: false, reason: 'card no longer in list' };

    const link = q(SEL.cardTitle, card) || card.querySelector('a[href*="/jobs/view/"]') || card;
    await clickEl(link);

    const loaded = await waitFor(
      () => currentJobIdFromUrl() === job.jobId && q(SEL.detailsDescription) ? true : null,
      { timeout: 15000 }
    );
    if (!loaded) return { ok: false, reason: 'details pane did not load' };

    // "See more" so the description text is complete before we score it.
    const more = q(SEL.seeMore);
    if (more && visible(more)) { await clickEl(more); await sleep(400); }

    return {
      ok: true,
      title: text(q(SEL.detailsTitle)) || job.title,
      company: text(q(SEL.detailsCompany)) || job.company,
      description: text(q(SEL.detailsDescription)),
      hasEasyApply: !!easyApplyButton()
    };
  }

  // The top-card button says "Easy Apply" for in-app applications and
  // "Apply" (with an external-link icon) for company-portal ones.
  function easyApplyButton() {
    for (const b of qa(SEL.applyButton)) {
      if (!visible(b)) continue;
      const label = (b.getAttribute('aria-label') || '') + ' ' + text(b);
      if (/easy apply/i.test(label)) return b;
    }
    return null;
  }

  // The company-portal counterpart: an "Apply" button that opens the employer's
  // own site in a new tab.
  function externalApplyButton() {
    for (const b of qa(SEL.applyButton)) {
      if (!visible(b)) continue;
      const label = (b.getAttribute('aria-label') || '') + ' ' + text(b);
      if (/easy apply/i.test(label)) continue;
      if (/\bapplied\b/i.test(label)) continue;
      if (/\bapply\b/i.test(label)) return b;
    }
    return null;
  }

  function applyButtonKind() {
    const btns = qa(SEL.applyButton).filter(visible);
    if (!btns.length) return 'none';
    const label = btns.map((b) => (b.getAttribute('aria-label') || '') + ' ' + text(b)).join(' ');
    if (/easy apply/i.test(label)) return 'easy';
    if (/applied/i.test(label)) return 'applied';
    return 'external';
  }

  async function goToNextPage() {
    const btn = LEA.dom.findButton([/^next$/i], document) || q(SEL.paginationNext);
    if (!btn || !visible(btn) || btn.disabled) return false;
    await clickEl(btn);
    await sleep(2500);
    return true;
  }

  LEA.scrape = {
    collectJobs, openJob, easyApplyButton, externalApplyButton, applyButtonKind,
    goToNextPage, currentJobIdFromUrl, jobIdOf
  };
})(window.LEA);
