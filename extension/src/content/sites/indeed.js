/* global window */
// Indeed adapter.
//
// Indeed is the hardest of the three, for two reasons worth knowing before you
// turn it on:
//
//   1. It runs aggressive bot detection. This adapter does not try to defeat
//      it - it detects the challenge, stops, and says so, because quietly
//      hammering a challenge page is how an account gets banned.
//   2. "Indeed Apply" hands off to smartapply.indeed.com, a separate origin.
//      A content script cannot reach across that, so the application itself is
//      completed by the portal engine on that page - the same code that fills
//      Greenhouse and Lever. Indeed is registered there as an assisted ATS, so
//      by default it fills the form and leaves it to you; turn on
//      "Submit automatically on Indeed" in settings to let it finish.
window.LEA = window.LEA || {};

(function (LEA) {
  const D = LEA.dom;
  const { q, qa, text, blockText, visible, clickEl, sleep, waitFor } = D;

  const SEL = {
    card: ['.job_seen_beacon', 'div.cardOutline', '[data-testid="slider_item"]'],
    cardTitle: ['h2.jobTitle span[title]', 'h2.jobTitle a span', 'h2.jobTitle', 'a.jcs-JobTitle'],
    cardCompany: ['[data-testid="company-name"]', '.companyName', 'span.companyName'],
    cardLocation: ['[data-testid="text-location"]', '.companyLocation', 'div.companyLocation'],
    cardApplyBadge: ['.indeedApply', '[data-testid="indeedApply"]', 'span.iaLabel'],

    detailTitle: ['.jobsearch-JobInfoHeader-title', 'h2.jobsearch-JobInfoHeader-title', 'h1'],
    detailCompany: ['[data-testid="inlineHeader-companyName"]', '.jobsearch-InlineCompanyRating div:first-child'],
    detailDescription: ['#jobDescriptionText', '.jobsearch-jobDescriptionText', '.jobsearch-JobComponent-description'],

    applyButton: ['#indeedApplyButton', '[id^="indeedApplyButton"]', '.ia-IndeedApplyButton',
      'button[data-testid="indeed-apply-button"]'],
    externalApply: ['#applyButtonLinkContainer a', '#viewJobButtonLinkContainer a', 'a[href*="/applystart"]'],
    appliedBadge: ['[data-testid="applied-state"]', '.jobsearch-IndeedApplyButton-newDesign--applied'],

    nextPage: ['a[data-testid="pagination-page-next"]', 'a[aria-label="Next Page"]', 'a[aria-label="Next"]']
  };

  // Indeed's interstitials look nothing like a results page. Recognising them
  // is the difference between "0 jobs found" and "we are being challenged".
  function botChallenge() {
    const body = (document.body.innerText || '').slice(0, 4000);
    if (/additional verification required|verify you are a human|unusual activity from your (computer )?network/i.test(body)) return 'verification page';
    if (document.querySelector('#challenge-running, iframe[src*="challenge"], iframe[title*="challenge" i]')) return 'challenge frame';
    if (/^\s*$/.test(body) && !q(SEL.card) && /indeed\.com/.test(location.hostname) && /\/jobs/.test(location.pathname)) return 'blank results page';
    return '';
  }

  function jobIdOf(card) {
    const holder = card.querySelector('[data-jk]') || card.closest('[data-jk]') || card;
    const jk = holder.getAttribute && holder.getAttribute('data-jk');
    if (jk) return jk;
    const link = card.querySelector('a[href*="jk="]');
    if (link) {
      const m = link.getAttribute('href').match(/[?&]jk=([a-z0-9]+)/i);
      if (m) return m[1];
    }
    return '';
  }

  async function collectJobs() {
    const challenge = botChallenge();
    if (challenge) {
      return { jobs: [], hasNext: false, error: 'Indeed is showing a ' + challenge + ' - stopping rather than pushing through it' };
    }

    const first = await waitFor(() => q(SEL.card), { timeout: 12000 });
    if (!first) {
      const late = botChallenge();
      return { jobs: [], hasNext: false, error: late ? 'Indeed is showing a ' + late : 'no job cards on page' };
    }
    await D.scrollThrough(document.scrollingElement, 8);

    const seen = new Set();
    const jobs = [];
    for (const card of qa(SEL.card)) {
      const jobId = jobIdOf(card);
      if (!jobId || seen.has(jobId)) continue;
      seen.add(jobId);
      const titleEl = q(SEL.cardTitle, card);
      jobs.push({
        jobId,
        site: 'indeed',
        title: (titleEl && titleEl.getAttribute('title')) || text(titleEl),
        company: text(q(SEL.cardCompany, card)),
        location: text(q(SEL.cardLocation, card)),
        url: 'https://' + location.hostname + '/viewjob?jk=' + encodeURIComponent(jobId),
        // "Easily apply" means Indeed Apply rather than the employer's site.
        quickApply: !!q(SEL.cardApplyBadge, card),
        alreadyApplied: /\bapplied\b/i.test(text(card))
      });
    }

    const next = q(SEL.nextPage);
    return { jobs, hasNext: !!(next && visible(next)) };
  }

  async function readJob(job) {
    const challenge = botChallenge();
    if (challenge) return { ok: false, reason: 'Indeed is showing a ' + challenge };

    const loaded = await waitFor(() => q(SEL.detailDescription), { timeout: 15000 });
    if (!loaded) return { ok: false, reason: 'job page did not load' };

    const applied = !!q(SEL.appliedBadge);
    return {
      ok: true,
      title: text(q(SEL.detailTitle)) || job.title,
      company: text(q(SEL.detailCompany)) || job.company,
      description: blockText(q(SEL.detailDescription)),
      hasQuickApply: !!q(SEL.applyButton) && !applied,
      hasExternalApply: !!q(SEL.externalApply),
      alreadyApplied: applied
    };
  }

  // Clicking Indeed Apply leaves this origin for smartapply.indeed.com, so the
  // adapter's job ends here: it reports that a hand-off has begun and the
  // service worker follows the new tab into the portal engine.
  async function quickApply(job, cfg, report) {
    const btn = q(SEL.applyButton);
    if (!btn) return { status: 'skipped', reason: 'no Indeed Apply button on this posting' };
    if (cfg.safety.dryRun) {
      return { status: 'dry_run', reason: 'found the Indeed Apply button; dry run so nothing was opened' };
    }
    report('indeed', 'opening Indeed Apply');
    await clickEl(btn);
    await sleep(1500);
    return { status: 'handoff', reason: 'Indeed Apply opens on smartapply.indeed.com' };
  }

  async function clickExternalApply() {
    const btn = q(SEL.externalApply) || q(SEL.applyButton);
    if (!btn) return { ok: false, reason: 'no Apply button on this posting' };
    await clickEl(btn);
    await sleep(1200);
    return { ok: true };
  }

  LEA.sites.register({
    id: 'indeed',
    name: 'Indeed',
    matches: (host) => /(^|\.)indeed\.com$/.test(host),
    collectJobs,
    readJob,
    openJob: readJob,
    quickApply,
    clickExternalApply,
    botChallenge,
    async goToNextPage() {
      const next = q(SEL.nextPage);
      if (!next || !visible(next)) return false;
      await clickEl(next);
      await sleep(2500);
      return true;
    },
    async abort() { /* nothing modal to dismiss on Indeed */ },
    SEL
  });
})(window.LEA);
