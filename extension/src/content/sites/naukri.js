/* global window */
// Naukri adapter.
//
// Two things make Naukri different from LinkedIn:
//   1. Results link out to full job pages, so a job is opened by navigating to
//      its URL rather than by clicking a card into a side pane.
//   2. "Apply" often succeeds outright, but sometimes opens a chat-style
//      questionnaire that has to be answered one message at a time before the
//      application counts. That chatbot is most of this file.
window.LEA = window.LEA || {};

(function (LEA) {
  const D = LEA.dom;
  const { q, qa, text, blockText, visible, clickEl, sleep, waitFor } = D;

  // As ever, selectors are the thing that rots. They are grouped here so a
  // Naukri reskin is a one-file fix.
  const SEL = {
    card: ['.srp-jobtuple-wrapper', 'article.jobTuple', '.jobTuple', '[data-job-id]'],
    cardTitle: ['a.title', '.title a', 'a.jobTitle'],
    cardCompany: ['a.comp-name', '.comp-name', '.companyInfo .subTitle', '.subTitle'],
    cardLocation: ['.locWdth', '.loc span', '.location', '.placeHolderLi.location'],
    cardFooter: ['.job-post-day', '.type', '.footer'],

    detailTitle: ['.styles_jd-header-title__rZwM1', 'h1.jd-header-title', 'h1'],
    detailCompany: ['.styles_jd-header-comp-name__MvqAI a', '.jd-header-comp-name a', '.comp-name'],
    detailDescription: ['.styles_JDC__dang-inner-html__h0K4t', '.dang-inner-html', '.job-desc', 'section.job-desc'],

    applyButton: ['#apply-button', '.styles_apply-button__uJI3A', 'button.apply-button'],
    companySiteButton: ['#company-site-button', '.styles_company-site-button__C_2YK', '.company-site-button'],
    alreadyApplied: ['.styles_applied-status__1TmDF', '.already-applied', '#already-applied'],

    // the questionnaire drawer
    chatbot: ['.chatbot_DrawerContentWrapper', '.chatbot_Drawer', '[class*="chatbot_Drawer"]'],
    botMessage: ['.botMsg', '[class*="botMsg"]', '.chatbot_MessageContainer .botItem'],
    chatTextInput: ['.textArea', 'div[contenteditable="true"]', 'textarea', 'input[type="text"]'],
    chatSend: ['.sendMsg', '.sendMsgbtn', '[class*="sendMsg"]', 'div.send'],
    chatChips: ['.ssrc__radio-btn-container', '.chatbot_Chip', '[class*="chip"] label', '.singleselect-radiobutton-container label'],
    chatDone: ['.chatbot_Complete', '[class*="successMsg"]']
  };

  const APPLIED_TEXT = /applied|application sent|successfully applied|you have applied/i;

  function jobIdOf(card) {
    const direct = card.getAttribute('data-job-id') || card.getAttribute('data-jobid');
    if (direct) return String(direct);
    const link = card.querySelector('a[href*="/job-listings-"]') || card.querySelector('a[href]');
    const href = link && link.getAttribute('href');
    if (!href) return '';
    // .../job-listings-senior-engineer-acme-bengaluru-5-to-8-years-120325004567
    const m = href.match(/-(\d{8,})(?:\?|$)/) || href.match(/jobId=(\d+)/);
    return m ? m[1] : href.split('?')[0];
  }

  function absolute(href) {
    try { return new URL(href, location.origin).toString(); } catch { return ''; }
  }

  // ------------------------------------------------------------------ search

  async function collectJobs() {
    const first = await waitFor(() => q(SEL.card), { timeout: 12000 });
    if (!first) return { jobs: [], hasNext: false, error: 'no job cards on page' };

    // Naukri lazy-loads logos and some cards; a scroll settles the list.
    await D.scrollThrough(document.scrollingElement, 10);

    const seen = new Set();
    const jobs = [];
    for (const card of qa(SEL.card)) {
      const jobId = jobIdOf(card);
      if (!jobId || seen.has(jobId)) continue;
      seen.add(jobId);
      const titleEl = q(SEL.cardTitle, card);
      const href = titleEl && titleEl.getAttribute('href');
      jobs.push({
        jobId,
        site: 'naukri',
        title: text(titleEl),
        company: text(q(SEL.cardCompany, card)),
        location: text(q(SEL.cardLocation, card)),
        url: href ? absolute(href) : '',
        // Naukri gives no "quick apply" marker on the card; it is only knowable
        // on the job page, so assume yes and find out when we get there.
        quickApply: true,
        alreadyApplied: APPLIED_TEXT.test(text(q(SEL.cardFooter, card)) || '')
      });
    }

    const next = D.findButton([/^next$/i]) || q(['a.styles_btn-secondary__2AsIP', '.pagination a.next']);
    return { jobs: jobs.filter((j) => j.url), hasNext: !!(next && visible(next)) };
  }

  // Naukri opens jobs as their own pages, so the service worker navigates and
  // this just reads whatever is on screen.
  async function readJob(job) {
    const loaded = await waitFor(() => q(SEL.detailDescription) || q(SEL.applyButton), { timeout: 15000 });
    if (!loaded) return { ok: false, reason: 'job page did not load' };

    const applied = !!q(SEL.alreadyApplied) || APPLIED_TEXT.test(text(q(SEL.applyButton)) || '');
    return {
      ok: true,
      title: text(q(SEL.detailTitle)) || job.title,
      company: text(q(SEL.detailCompany)) || job.company,
      description: blockText(q(SEL.detailDescription)),
      hasQuickApply: !!q(SEL.applyButton) && !applied,
      hasExternalApply: !!q(SEL.companySiteButton),
      alreadyApplied: applied
    };
  }

  // ----------------------------------------------------------- the chatbot

  function lastQuestion() {
    const msgs = qa(SEL.botMessage).filter(visible);
    if (!msgs.length) return '';
    return text(msgs[msgs.length - 1]);
  }

  function chipOptions() {
    return qa(SEL.chatChips).filter(visible).map((el) => ({
      value: (el.querySelector('input') || {}).value || text(el),
      label: text(el),
      el
    })).filter((o) => o.label);
  }

  async function answerChatbot(cfg, report) {
    const drawer = q(SEL.chatbot);
    if (!drawer) return { done: true };

    report('naukri', 'questionnaire opened');
    const unknowns = [];
    let lastAsked = '';
    let repeats = 0;

    for (let step = 0; step < 20; step++) {
      await sleep(D.rand(700, 1300));
      if (!q(SEL.chatbot)) return { done: true };                 // drawer closed = finished
      if (q(SEL.chatDone) || APPLIED_TEXT.test(document.body.innerText || '')) return { done: true };

      const question = lastQuestion();
      if (!question) return { done: true, unknowns };

      // The same question twice running means our answer was not accepted.
      if (question === lastAsked && ++repeats >= 2) {
        return { done: false, unknowns, reason: 'stuck on: ' + question.slice(0, 120) };
      }
      if (question !== lastAsked) { lastAsked = question; repeats = 0; }

      const chips = chipOptions();
      const ans = LEA.answers.resolve(question, chips.length ? 'radio' : 'text', chips, cfg);

      if (ans.unknown) {
        unknowns.push({ label: question, kind: chips.length ? 'radio' : 'text', options: chips.map((c) => c.label) });
        return { done: false, unknowns, reason: 'no answer for: ' + question.slice(0, 120) };
      }

      if (chips.length) {
        const pick = chips.find((c) => c.value === ans.value)
          || chips.find((c) => c.label === ans.optionLabel);
        if (!pick) {
          unknowns.push({ label: question, kind: 'radio', options: chips.map((c) => c.label) });
          return { done: false, unknowns, reason: 'no matching option for: ' + question.slice(0, 120) };
        }
        await clickEl(pick.el);
        report('field', question.slice(0, 70) + ' = ' + pick.label);
      } else {
        const input = q(SEL.chatTextInput);
        if (!input) return { done: false, unknowns, reason: 'questionnaire had no input to type into' };
        // Naukri's chat box is usually a contenteditable div rather than an
        // <input>; setValue handles both.
        await D.setValue(input, ans.value, cfg);
        report('field', question.slice(0, 70) + ' = ' + ans.value);
      }

      await sleep(D.rand(300, 700));
      const send = q(SEL.chatSend);
      if (send && visible(send)) await clickEl(send);
      else {
        const input = q(SEL.chatTextInput);
        if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      }
    }
    return { done: false, unknowns, reason: 'questionnaire ran past 20 questions' };
  }

  // ------------------------------------------------------------------ apply

  async function quickApply(job, cfg, report) {
    const btn = q(SEL.applyButton);
    if (!btn) {
      return q(SEL.companySiteButton)
        ? { status: 'skipped', reason: 'this posting only applies on the company site' }
        : { status: 'failed', reason: 'no Apply button on the page' };
    }
    if (APPLIED_TEXT.test(text(btn))) return { status: 'skipped', reason: 'already applied' };

    if (cfg.safety.dryRun) {
      return { status: 'dry_run', reason: 'found the Apply button; dry run so nothing was sent' };
    }
    if (cfg.safety.reviewBeforeSubmit) {
      report('confirm', 'waiting for your confirmation');
      const choice = await LEA.easyApply.askUserConfirm(job);
      if (choice !== 'submit') return { status: 'skipped', reason: 'you skipped it at the review step' };
    }

    await clickEl(btn);
    report('naukri', 'clicked Apply');

    // Either it just works, or a questionnaire appears.
    const outcome = await waitFor(() => {
      if (q(SEL.chatbot)) return 'chatbot';
      if (APPLIED_TEXT.test(document.body.innerText || '')) return 'applied';
      return null;
    }, { timeout: 12000 });

    if (outcome === 'applied') return { status: 'applied', reason: 'submitted on Naukri' };

    if (outcome === 'chatbot') {
      const res = await answerChatbot(cfg, report);
      if (res.done) {
        const confirmed = await waitFor(
          () => (APPLIED_TEXT.test(document.body.innerText || '') ? true : null), { timeout: 10000 });
        return confirmed
          ? { status: 'applied', reason: 'submitted on Naukri after the questionnaire' }
          : { status: 'failed', reason: 'questionnaire finished but no confirmation appeared' };
      }
      return {
        status: 'needs_manual',
        reason: res.reason || 'questionnaire needs you',
        unknowns: res.unknowns || [],
        keepTab: true
      };
    }

    return { status: 'failed', reason: 'clicked Apply but nothing confirmed it' };
  }

  async function clickExternalApply() {
    const btn = q(SEL.companySiteButton);
    if (!btn) return { ok: false, reason: 'no company-site Apply button on this posting' };
    await clickEl(btn);
    await sleep(1200);
    return { ok: true };
  }

  LEA.sites.register({
    id: 'naukri',
    name: 'Naukri',
    matches: (host) => /(^|\.)naukri\.com$/.test(host),
    collectJobs,
    readJob,
    openJob: readJob,
    quickApply,
    clickExternalApply,
    async goToNextPage() {
      const next = D.findButton([/^next$/i]);
      if (!next || !visible(next)) return false;
      await clickEl(next);
      await sleep(2500);
      return true;
    },
    async abort() {
      const close = q(['.chatbot_CloseIcon', '[class*="crossIcon"]', 'button[aria-label="Close"]']);
      if (close) await clickEl(close);
    },
    SEL
  });
})(window.LEA);
