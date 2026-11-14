/* global window */
// Reads the search results list and the job details pane.
window.LEA = window.LEA || {};

(function (LEA) {
  const { q, qa, text, blockText, waitFor, clickEl, sleep, visible, scrollThrough } = LEA.dom;
  const SEL = LEA.SEL;

  function jobIdOf(card) {
    const direct = card.getAttribute('data-lea-job-id') ||
      card.getAttribute('data-occludable-job-id') || card.getAttribute('data-job-id');
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

  // ---------------------------------------- cards, whatever the page layout
  //
  // LinkedIn reskins its pages a few times a year, and the class names in
  // selectors.js go with them. When none of them match, cards are found by the
  // one thing every layout has had: a link or attribute carrying the job's id.
  const ID_SCAN = 'a[href*="/jobs/view/"], a[href*="currentJobId="], [data-occludable-job-id], [data-job-id], ' +
    '[data-entity-urn*="jobPosting"], [componentkey*="job" i]';

  function idIn(el) {
    for (const a of ['data-occludable-job-id', 'data-job-id']) {
      const v = el.getAttribute(a);
      if (v && /^\d{6,}$/.test(v)) return v;
    }
    const href = el.getAttribute('href') || '';
    let m = href.match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})/) || href.match(/[?&]currentJobId=(\d{6,})/);
    if (m) return m[1];
    m = ((el.getAttribute('data-entity-urn') || '') + ' ' + (el.getAttribute('componentkey') || ''))
      .match(/job[a-z]*[:_-][a-z_-]*?(\d{8,})/i);
    return m ? m[1] : '';
  }

  // The cards in the results list. With the known selectors when they match;
  // otherwise each card is the largest box around a job id that holds no other
  // job, and the list is the parent holding the most of them (which leaves out
  // the details pane and any "similar jobs" strip).
  function findCards() {
    const known = qa(SEL.jobCard).filter((c) => jobIdOf(c));
    if (known.length) return known;
    const root = document.querySelector('main') || document.body;
    const marks = [];
    const perId = new Map();
    for (const el of root.querySelectorAll(ID_SCAN)) {
      const id = idIn(el);
      if (!id || (perId.get(id) || 0) >= 2) continue;
      perId.set(id, (perId.get(id) || 0) + 1);
      marks.push({ el, id });
    }
    if (!marks.length) return [];
    const groups = new Map();     // parent -> Map(id -> card)
    for (const { el, id } of marks) {
      let box = el;
      while (box.parentElement && box.parentElement !== root &&
        !marks.some((m) => m.id !== id && box.parentElement.contains(m.el))) box = box.parentElement;
      const g = groups.get(box.parentElement) || new Map();
      if (!g.has(id)) g.set(id, box);
      groups.set(box.parentElement, g);
    }
    let best = null;
    for (const g of groups.values()) if (!best || g.size > best.size) best = g;
    return [...best].map(([id, box]) => { box.setAttribute('data-lea-job-id', id); return box; });
  }

  const hasCards = () => !!(q(SEL.jobCard) || (document.querySelector('main') || document.body).querySelector(ID_SCAN));

  // A card's lines, for when its parts have no class names to find them by.
  const CARD_NOISE = /^(promoted|easy apply|viewed|saved|applied|dismiss.*|with verification|be an early applicant|actively (hiring|reviewing).*|.*\b(ago|reposted|applicants?|alumni|connections?|benefits?)\b.*|.*([₹$€£]|\/yr|\/hr|\blpa\b).*)$/i;
  function cardLines(card) {
    const out = [];
    for (const raw of blockText(card).split('\n')) {
      const line = raw.replace(/^(.+?)\s*\1$/, '$1').trim();
      if (line && !CARD_NOISE.test(line) && line !== out[out.length - 1]) out.push(line);
    }
    return out;
  }

  function readCard(card) {
    const jobId = jobIdOf(card);
    if (!jobId) return null;
    const titleEl = q(SEL.cardTitle, card);
    // LinkedIn renders the title twice (once visually hidden for screen
    // readers), which collapses to "Title Title" - fold the repeat back.
    const fold = (s) => (s || '').replace(/^(.+?)\s*\1$/, '$1').trim();
    let title = fold(text(titleEl));
    let company = text(q(SEL.cardCompany, card));
    let location = text(q(SEL.cardLocation, card));
    if (!title || !company) {
      const link = card.querySelector('a[href*="/jobs/view/"], a[href*="currentJobId="]');
      const lines = cardLines(card);
      title = title || fold(text(link)) || fold((link && link.getAttribute('aria-label')) || '') || lines[0] || '';
      const rest = lines.filter((l) => l !== title && !title.startsWith(l));
      company = company || rest[0] || '';
      location = location || rest[1] || '';
    }
    const footer = text(q(SEL.cardFooter, card));
    const whole = text(card);
    return {
      jobId,
      title,
      company,
      location,
      easyApply: /easy apply/i.test(footer) || /easy apply/i.test(whole),
      alreadyApplied: /\bapplied\b/i.test(footer) || /(^|\n)\s*applied\b/i.test(blockText(card)),
      url: 'https://www.linkedin.com/jobs/view/' + jobId + '/'
    };
  }

  // Where the page stands, for the log when no cards are found at all.
  function fingerprint() {
    const root = document.querySelector('main') || document.body;
    const views = {};
    for (const el of root.querySelectorAll('[data-view-name]')) {
      const v = el.getAttribute('data-view-name');
      views[v] = (views[v] || 0) + 1;
    }
    const top = Object.entries(views).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => k + ' x' + n);
    return location.pathname + ', ' + root.querySelectorAll('a[href*="/jobs/"]').length + ' job links' +
      (top.length ? ', ' + top.join(', ') : '');
  }

  // Why a results page shows no job cards: the search found nothing, LinkedIn
  // is not signed in, or it wants a security check. '' when none of these,
  // which leaves a page LinkedIn has redesigned.
  const NO_RESULTS = /no matching jobs found|we couldn[’']?t find (a match|any jobs)|no (jobs|results) found/i;
  function emptyReason() {
    const path = location.pathname;
    if (/^\/(checkpoint|challenge)\b/.test(path) || /security (check|verification)/i.test(document.title)) return 'checkpoint';
    if (/^\/(authwall|login|uas\/login|signup|signin)\b/.test(path) || q(SEL.signedOut)) return 'signedOut';
    const main = document.querySelector('main') || document.body;
    if (q(SEL.noResults) || NO_RESULTS.test((main.innerText || '').slice(0, 20000))) return 'noResults';
    return '';
  }

  async function collectJobs() {
    const anyCard = findCards()[0];
    if (!anyCard) {
      const why = emptyReason();
      if (why === 'noResults') return { jobs: [], hasNext: false, noResults: true };
      if (why === 'signedOut') {
        return { jobs: [], hasNext: false, error: 'LinkedIn is not signed in in this Chrome. Sign in on linkedin.com, then start the run again' };
      }
      if (why === 'checkpoint') {
        return { jobs: [], hasNext: false, error: 'LinkedIn is asking for a security check. Complete it in the LinkedIn tab, then start the run again' };
      }
      return {
        jobs: [], hasNext: false,
        error: 'no job cards on the page "' + document.title.slice(0, 80) + '" (' + fingerprint() + ') - LinkedIn may have changed its page layout'
      };
    }

    await scrollThrough(scrollParent(anyCard), 14);

    const seen = new Set();
    const jobs = [];
    // Found again after scrolling: a virtualised list renders more cards.
    for (const card of findCards()) {
      const j = readCard(card);
      if (!j || seen.has(j.jobId)) continue;
      seen.add(j.jobId);
      jobs.push(j);
    }
    const nextBtn = LEA.dom.findButton([/^next$/i], document) || q(SEL.paginationNext);
    return { jobs, hasNext: !!(nextBtn && visible(nextBtn) && !nextBtn.disabled), byLinks: !q(SEL.jobCard) };
  }

  function currentJobIdFromUrl() {
    const u = new URL(location.href);
    return u.searchParams.get('currentJobId') || (location.pathname.match(/\/jobs\/view\/(\d+)/) || [])[1] || '';
  }

  // The job's description in the details pane. Every layout so far has headed
  // it "About the job", so that finds it when the class names do not.
  function descriptionEl() {
    const known = q(SEL.detailsDescription);
    if (known) return known;
    const heading = Array.from(document.querySelectorAll('h1, h2, h3, h4, strong, span'))
      .find((h) => /^about the job$/i.test(text(h)));
    let box = heading;
    while (box && box.parentElement && box !== document.body && blockText(box).length < 300) box = box.parentElement;
    return box && box !== document.body ? box : null;
  }

  async function openJob(job) {
    const card = findCards().find((c) => jobIdOf(c) === job.jobId);
    if (card) {
      // The card's own link, or its clickable area; never its Dismiss or Save
      // buttons, which are real <button>s.
      const link = q(SEL.cardTitle, card) ||
        card.querySelector('a[href*="/jobs/view/"], a[href*="currentJobId="], [role="link"], [role="button"]:not(button)') || card;
      await clickEl(link);
    } else if (currentJobIdFromUrl() !== job.jobId) {
      // Reopening a job found earlier in the run: the page was loaded with
      // ?currentJobId=, so its details are in the pane even if the list has
      // shifted and the card itself scrolled off it.
      return { ok: false, reason: 'card no longer in list' };
    }

    // This job's pane, not the last one's: the address names it, or, on a
    // layout that keeps the job out of the address, the pane shows its title.
    const showing = () => {
      const id = currentJobIdFromUrl();
      if (id) return id === job.jobId;
      const pane = descriptionEl();
      const region = pane && (pane.closest('[class*="details"], section, article') || pane.parentElement);
      return !!(region && job.title && blockText(region).includes(job.title));
    };
    const loaded = await waitFor(() => (showing() && descriptionEl() ? true : null), { timeout: 15000 });
    if (!loaded) return { ok: false, reason: 'details pane did not load' };

    // "See more" so the description text is complete before we score it.
    const more = q(SEL.seeMore) || LEA.dom.findButton([/^(…\s*)?(see|show) more$/i], descriptionEl());
    if (more && visible(more)) { await clickEl(more); await sleep(400); }

    return {
      ok: true,
      title: text(q(SEL.detailsTitle)) || job.title,
      company: text(q(SEL.detailsCompany)) || job.company,
      description: blockText(descriptionEl()),
      hasEasyApply: !!easyApplyButton()
    };
  }

  // The job's Apply buttons. Without the known class names, they are found by
  // what they say ("Easy Apply", "Apply", "Apply on company website") and are
  // never one inside a results card.
  function applyButtons() {
    const known = qa(SEL.applyButton);
    if (known.length) return known;
    const inCard = SEL.jobCard.concat('[data-lea-job-id]').join(',');
    return Array.from(document.querySelectorAll('button, a[role="button"], a[href]')).filter((b) => {
      const label = (text(b) || b.getAttribute('aria-label') || '').trim();
      return /^(easy apply|apply( now)?|apply on company (site|website))\b/i.test(label) && !b.closest(inCard);
    });
  }

  // The top-card button says "Easy Apply" for in-app applications and
  // "Apply" (with an external-link icon) for company-portal ones.
  function easyApplyButton() {
    for (const b of applyButtons()) {
      if (!visible(b)) continue;
      const label = (b.getAttribute('aria-label') || '') + ' ' + text(b);
      if (/easy apply/i.test(label)) return b;
    }
    return null;
  }

  // The company-portal counterpart: an "Apply" button that opens the employer's
  // own site in a new tab.
  function externalApplyButton() {
    for (const b of applyButtons()) {
      if (!visible(b)) continue;
      const label = (b.getAttribute('aria-label') || '') + ' ' + text(b);
      if (/easy apply/i.test(label)) continue;
      if (/\bapplied\b/i.test(label)) continue;
      if (/\bapply\b/i.test(label)) return b;
    }
    return null;
  }

  function applyButtonKind() {
    const btns = applyButtons().filter(visible);
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
    goToNextPage, currentJobIdFromUrl, jobIdOf, emptyReason, findCards, hasCards
  };
})(window.LEA);
