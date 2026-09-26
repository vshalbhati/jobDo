/* global window */
// Understands and fills an application form on a company career site.
//
// Unlike the LinkedIn side there is no fixed markup to target, so nothing here
// is selector-driven. It finds the form by where the controls are, derives each
// question's label from whatever the page offers (label/for, aria-*, wrapper
// text, placeholder, finally the field name), and routes the answer through the
// same answer engine the Easy Apply flow uses - so a rule you write once
// applies on both paths.
window.LEA = window.LEA || {};

(function (LEA) {
  const D = LEA.dom;
  const { sleep, rand, text, visible, clickEl, waitFor } = D;

  const SKIP_FIELD = /search|newsletter|subscribe|coupon|promo|captcha|honeypot/i;
  const CONSENT = /\b(i )?(agree|consent|accept|acknowledge|certify|confirm|authorize)\b|privacy (policy|notice)|terms|gdpr|data protection|true and complete/i;
  const COVER_LETTER = /cover letter|why (do|would) you|tell us (about|why)|motivation|additional information|anything else/i;
  const RESUME_FIELD = /resume|r[ée]sum[ée]|\bcv\b|upload/i;
  const SUBMIT_TEXT = /^(submit( application| my application)?|apply( now)?|send( application)?|finish|complete application)$/i;
  const NOT_SUBMIT = /save|cancel|back|previous|draft|sign ?in|log ?in|create (an )?account|register|clear|reset|attach|upload|browse|choose/i;
  const REVEAL_TEXT = /^(apply|apply (now|online|here|today)|apply (for|to) (this|the) (job|position|role|vacancy|opening)|apply for job|i'?m interested|(start|begin)( my| your| the)? application|apply manually|continue( to (the )?application)?)$/i;
  // A form with none of these is a job search or an alerts sign-up, not the
  // application - so the Apply button still needs pressing.
  const APPLICANT_FIELD = /e-?mail|phone|mobile|first.?name|last.?name|full.?name|resume|r[ée]sum[ée]|\bcv\b/i;
  const NOT_APPLICATION = /search|filter|alert|newsletter|subscribe/i;
  const DONE_TEXT = /thank you|thanks for (applying|your)|application (has been )?(received|submitted|sent|complete)|successfully (applied|submitted)|we(’|')?ll be in touch|we have received your/i;

  // ------------------------------------------------------------- discovery

  function isFillable(el) {
    const type = (el.type || '').toLowerCase();
    if (/^(hidden|submit|button|reset|image)$/.test(type)) return false;
    if (el.disabled || el.readOnly) return false;
    if (type === 'search') return false;
    if (SKIP_FIELD.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || ''))) return false;
    if (type === 'file') return true;                 // file inputs are usually hidden
    if (type === 'radio' || type === 'checkbox') return true;  // styled away from view
    return visible(el);
  }

  function controlsIn(root) {
    return Array.from(root.querySelectorAll('input, select, textarea')).filter(isFillable);
  }

  function commonAncestor(els) {
    let node = els[0];
    while (node && node !== document.body) {
      if (els.every((e) => node.contains(e))) return node;
      node = node.parentElement;
    }
    return document.body;
  }

  // Cheap enough to run on every poll: no label walking, just the attributes
  // and an explicit <label for>. Attributes are read with getAttribute because
  // a form's .id or .action is shadowed by any field named "id" or "action".
  function looksLikeApplication(form) {
    return controlsIn(form).some((el) => {
      if (/^(email|tel|file)$/i.test(el.type || '')) return true;
      const lab = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
      return APPLICANT_FIELD.test([
        el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('autocomplete'),
        el.getAttribute('placeholder'), el.getAttribute('aria-label'), text(lab)
      ].join(' '));
    });
  }

  // The application form is whichever container holds the most fillable
  // controls - more reliable than guessing at a class name per ATS - with
  // one that asks for contact details preferred over one that does not.
  function pickForm() {
    const forms = Array.from(document.querySelectorAll('form'))
      .filter((f) => f.getAttribute('role') !== 'search' && !NOT_APPLICATION.test([
        f.getAttribute('id'), f.getAttribute('class'), f.getAttribute('action'), f.getAttribute('name')
      ].join(' ')))
      .map((f) => ({ el: f, n: controlsIn(f).length }))
      .filter((x) => x.n > 1)
      .sort((a, b) => b.n - a.n);
    if (forms.length) return (forms.find((x) => looksLikeApplication(x.el)) || forms[0]).el;
    const all = controlsIn(document.body);
    if (all.length < 2) return null;
    return commonAncestor(all);
  }

  function applicationForm() {
    const form = pickForm();
    return form && looksLikeApplication(form) ? form : null;
  }

  const buttonLabel = (el) => (text(el) || el.value || el.getAttribute('aria-label') || '')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');       // "Apply now →"

  // Something that opens the form rather than belonging to one. A button inside
  // a form that already has fields is that form's own submit, and pressing it
  // on an empty form is the last thing wanted. Labels already pressed are left
  // out, so a second "Apply" further down the page is not pressed again.
  function revealButton(tried) {
    const found = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"]'))
      .filter((el) => visible(el) && REVEAL_TEXT.test(buttonLabel(el)))
      .filter((el) => !tried.has(buttonLabel(el).toLowerCase()))
      .filter((el) => !/^mailto:/i.test(el.getAttribute('href') || ''))
      .filter((el) => { const f = el.closest('form'); return !f || controlsIn(f).length < 2; });
    // "Continue" also closes cookie banners, so anything that says apply goes
    // first, and the job's own button before a site-wide one in the header.
    const rank = (el) => (/apply|interested|application/i.test(buttonLabel(el)) ? 0 : 2) +
      (el.closest('nav, header, footer') ? 1 : 0);
    return found.sort((a, b) => rank(a) - rank(b))[0] || null;
  }

  // Career pages often embed the real form from an ATS (Greenhouse's
  // grnhse_iframe, say). This script runs only in the top frame, so the frame's
  // own address is opened instead. atsHosts are the recognised ATS host
  // patterns, sent by the background so the list lives in one place.
  function atsFrame(atsHosts) {
    const hosts = (atsHosts || []).map((s) => new RegExp(s));
    for (const f of document.querySelectorAll('iframe[src]')) {
      let host = '';
      try { host = new URL(f.src).hostname; } catch { continue; }
      if (host !== location.hostname && hosts.some((re) => re.test(host))) return f.src;
    }
    return '';
  }

  // Many career pages show the job description first and the form only behind
  // an Apply button - sometimes two in a row (Workday: "Apply", then "Apply
  // Manually"). Single-page apps render that button a few seconds after load,
  // so it is waited for rather than looked for once.
  // Returns { form }, { moved: url } when this tab is on its way elsewhere, or {}.
  async function revealForm(report, atsHosts) {
    const tried = new Set();
    for (let step = 0; step < 3; step++) {
      const next = await waitFor(() => {
        if (applicationForm()) return { form: true };
        const frame = atsFrame(atsHosts);
        if (frame) return { frame };
        const btn = revealButton(tried);
        return btn ? { btn } : null;
      }, { timeout: step ? 8000 : 15000 });
      if (!next) break;
      if (next.form) return { form: true };
      if (next.frame) {
        report('portal', 'the form is embedded from another site; opening it directly: ' + next.frame.slice(0, 100));
        location.assign(next.frame);
        return { moved: next.frame };
      }

      const btn = next.btn;
      tried.add(buttonLabel(btn).toLowerCase());
      // A scripted click is not a user gesture, so Chrome's popup blocker stops
      // a link that opens a new tab. Following it in this tab instead lets the
      // run carry on to whatever site it leads to.
      const href = btn.tagName === 'A' ? btn.href : '';
      if (btn.target === '_blank' && /^https?:/i.test(href) && href.split('#')[0] !== location.href.split('#')[0]) {
        report('portal', 'following "' + text(btn) + '" to ' + href.slice(0, 100));
        location.assign(href);
        return { moved: href };
      }
      report('portal', 'clicking "' + text(btn) + '" to open the form');
      await clickEl(btn);
      if (await waitFor(() => applicationForm(), { timeout: 8000 })) return { form: true };
    }
    return pickForm() ? { form: true } : {};
  }

  function emailApply() {
    const a = Array.from(document.querySelectorAll('a[href^="mailto:" i]'))
      .find((el) => visible(el) && /apply|resume|r[ée]sum[ée]|\bcv\b|career|job|\bhr\b|recruit/i.test(text(el) + ' ' + el.getAttribute('href')));
    return a ? a.getAttribute('href').slice(7).split('?')[0] : '';
  }

  // Named in the hand-off reason, so a page it could not work out can be
  // looked into without reopening it.
  function applyButtonsSeen() {
    return Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .filter(visible).map(text)
      .filter((t) => t && t.length <= 40 && /apply|application/i.test(t))
      .filter((t, i, all) => all.indexOf(t) === i)
      .slice(0, 3);
  }

  // ----------------------------------------------------------------- labels

  function humanize(name) {
    return String(name || '')
      .replace(/\[|\]/g, ' ')                 // job_application[first_name]
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')    // firstName
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanLabel(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .replace(/[*✱]/g, '')
      .replace(/\(\s*(required|optional)\s*\)/ig, '')
      .replace(/\b(required|optional)\b\s*$/i, '')
      .trim();
  }

  const LABELISH = 'label, legend, .label, [class*="label"], [class*="Label"], [class*="question"], [class*="title"]';

  function labelFor(el) {
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (text(lab)) return cleanLabel(text(lab));
    }
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const s = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(text).join(' ');
      if (s.trim()) return cleanLabel(s);
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return cleanLabel(aria);

    const wrapping = el.closest('label');
    if (text(wrapping)) return cleanLabel(text(wrapping));

    // Walk up a few levels looking for a label-ish element that isn't the
    // whole form. Stops as soon as the container holds another control, which
    // would mean we've climbed past this field's own wrapper.
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      if (controlsIn(node).filter((c) => c !== el && c.type !== 'hidden').length > 1) break;
      const cand = Array.from(node.querySelectorAll(LABELISH))
        .map(text).map(cleanLabel).filter((t) => t && t.length < 220)[0];
      if (cand) return cand;
    }
    if (el.placeholder) return cleanLabel(el.placeholder);
    return cleanLabel(humanize(el.name || el.id));
  }

  function isRequired(el, label) {
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    const wrap = el.closest('[class*="required"], [data-required="true"]');
    if (wrap) return true;
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab && /[*✱]|\brequired\b/i.test(text(lab))) return true;
    }
    return /[*✱]/.test(label || '');
  }

  // ------------------------------------------------------------- questions

  function classify(el) {
    const type = (el.type || '').toLowerCase();
    if (type === 'file') return 'file';
    if (el.tagName === 'SELECT') return 'select';
    if (el.tagName === 'TEXTAREA') return 'textarea';
    if (type === 'radio') return 'radio';
    if (type === 'checkbox') return 'checkbox';
    // react-select and friends: a text input wired to a listbox.
    if (el.getAttribute('role') === 'combobox' ||
        el.getAttribute('aria-autocomplete') === 'list' ||
        el.closest('[class*="select__control"], [class*="Select-control"], [class*="select-shell"], [role="combobox"]')) {
      return 'custom';
    }
    if (type === 'number') return 'number';
    return 'text';
  }

  function optionsOfSelect(sel) {
    return Array.from(sel.options).map((o) => ({ value: o.value, label: o.text }));
  }

  // Turns raw controls into one entry per question, folding radio groups and
  // multi-checkbox groups back together by name.
  function questions(form) {
    const controls = controlsIn(form);
    const out = [];
    const grouped = new Map();

    for (const el of controls) {
      const kind = classify(el);
      if ((kind === 'radio' || kind === 'checkbox') && el.name) {
        const key = kind + ':' + el.name;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(el);
        continue;
      }
      const label = labelFor(el);
      out.push({
        kind, el, label,
        required: isRequired(el, label),
        // Without these the answer engine has nothing to choose between, and
        // every dropdown on the form looks unanswerable.
        options: kind === 'select' ? optionsOfSelect(el) : undefined
      });
    }

    for (const [key, els] of grouped) {
      const kind = key.split(':')[0];
      if (kind === 'checkbox' && els.length === 1) {
        const el = els[0];
        out.push({ kind: 'checkbox', el, label: labelFor(el), required: isRequired(el, labelFor(el)) });
        continue;
      }
      const fieldset = els[0].closest('fieldset, [role="radiogroup"], [class*="question"]');
      const legend = fieldset && text(fieldset.querySelector('legend, .label, [class*="label"]'));
      const label = cleanLabel(legend) || labelFor(els[0]);
      out.push({
        kind: 'group', multi: kind === 'checkbox', els, label,
        required: els.some((e) => isRequired(e, label)),
        options: els.map((e) => ({ value: e.value, label: labelFor(e) || e.value, el: e }))
      });
    }
    return out;
  }

  function valueOf(qn) {
    if (qn.kind === 'group') return (qn.els.find((e) => e.checked) || {}).value || '';
    if (qn.kind === 'checkbox') return qn.el.checked ? 'on' : '';
    if (qn.kind === 'file') return qn.el.files && qn.el.files.length ? qn.el.files[0].name : '';
    if (qn.kind === 'select') {
      const o = qn.el.selectedOptions[0];
      const t = (o ? o.text : '').toLowerCase().trim();
      if (!qn.el.value || /^(select|choose|please select|--|^$)/.test(t)) return '';
      return qn.el.value;
    }
    return (qn.el.value || '').trim();
  }

  // ---------------------------------------------------------------- filling

  function dataUrlToFile(dataUrl, name, mime) {
    const comma = dataUrl.indexOf(',');
    const meta = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    const bytes = meta.includes(';base64')
      ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(body));
    return new File([bytes], name || 'resume.pdf', { type: mime || 'application/pdf' });
  }

  async function attachResume(el, cfg, report) {
    if (!cfg.resume || !cfg.resume.dataUrl) {
      report('warn', 'this form wants a file but no resume is stored');
      return false;
    }
    const file = dataUrlToFile(cfg.resume.dataUrl, cfg.resume.fileName, cfg.resume.mime);
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1500);

    // Drag-and-drop widgets ignore a change event on their hidden input, so
    // fall back to a synthetic drop only if the name never showed up.
    if (!document.body.innerText.includes(file.name)) {
      const zone = el.closest('[class*="drop"], [class*="dropzone"], [class*="upload"], [class*="attach"]') || el.parentElement;
      if (zone) {
        zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await sleep(1800);
      }
    }
    const landed = document.body.innerText.includes(file.name);
    report(landed ? 'portal' : 'warn', (landed ? 'attached ' : 'could not confirm attachment of ') + file.name);
    return landed;
  }

  async function fillCustom(el, value, cfg, report) {
    await clickEl(el);
    await D.setValue(el, value, cfg);
    await sleep(rand(500, 900));
    const menu = Array.from(document.querySelectorAll(
      '[role="option"], [class*="select__option"], [class*="Select-option"], [class*="menu"] li, [class*="dropdown"] li'
    )).filter(visible);
    if (!menu.length) return false;
    const want = String(value).toLowerCase().trim();
    const hit = menu.find((o) => text(o).toLowerCase().trim() === want)
      || menu.find((o) => text(o).toLowerCase().includes(want))
      || menu[0];
    report('portal', 'picked "' + text(hit) + '" from the dropdown');
    await clickEl(hit);
    await sleep(400);
    return true;
  }

  function coverLetterText(cfg, job) {
    const tpl = (cfg.portal && cfg.portal.coverLetter) || '';
    if (!tpl.trim()) return '';
    const p = cfg.profile || {};
    return tpl
      .replace(/\{\{\s*title\s*\}\}/gi, job.title || '')
      .replace(/\{\{\s*company\s*\}\}/gi, job.company || '')
      .replace(/\{\{\s*firstName\s*\}\}/gi, p.firstName || '')
      .replace(/\{\{\s*lastName\s*\}\}/gi, p.lastName || '')
      .replace(/\{\{\s*name\s*\}\}/gi, [p.firstName, p.lastName].filter(Boolean).join(' '))
      .replace(/\{\{\s*years\s*\}\}/gi, String(p.defaultYears ?? ''))
      .replace(/\{\{\s*skills\s*\}\}/gi, Object.keys(p.skills || {}).slice(0, 6).join(', '));
  }

  async function fillOne(qn, cfg, job, report) {
    if (qn.kind === 'file') {
      if (valueOf(qn)) return { filled: false };
      if (RESUME_FIELD.test(qn.label) || !qn.label) {
        return { filled: await attachResume(qn.el, cfg, report) };
      }
      return { filled: false };       // cover-letter/portfolio file slots are left alone
    }

    if (qn.kind === 'checkbox') {
      if (CONSENT.test(qn.label)) {
        if (!qn.el.checked) {
          await clickEl(qn.el);
          if (!qn.el.checked) { qn.el.checked = true; qn.el.dispatchEvent(new Event('change', { bubbles: true })); }
          report('consent', 'ticked: ' + qn.label.slice(0, 120));
        }
        return { filled: true };
      }
    }

    if (qn.kind === 'textarea' && COVER_LETTER.test(qn.label)) {
      const letter = coverLetterText(cfg, job);
      if (!letter) return { filled: false, unknown: qn.required ? qn : null };
      await D.setValue(qn.el, letter, cfg);
      report('portal', 'wrote the cover letter into "' + qn.label.slice(0, 60) + '"');
      return { filled: true };
    }

    if (valueOf(qn)) return { filled: false };     // already populated

    const kindForEngine =
      qn.kind === 'group' ? 'radio' :
      qn.kind === 'custom' ? 'text' :
      qn.kind === 'checkbox' ? 'checkbox' : qn.kind;

    const ans = LEA.answers.resolve(qn.label, kindForEngine, qn.options, cfg);
    if (ans.unknown) return { filled: false, unknown: qn.required ? qn : null };

    if (qn.kind === 'group') {
      const target = qn.options.find((o) => o.value === ans.value)
        || qn.options.find((o) => o.label === ans.optionLabel);
      if (!target) return { filled: false, unknown: qn.required ? qn : null };
      const lab = target.el.id ? document.querySelector('label[for="' + CSS.escape(target.el.id) + '"]') : null;
      await clickEl(lab && visible(lab) ? lab : target.el);
      if (!target.el.checked) {
        target.el.checked = true;
        target.el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (qn.kind === 'select') {
      D.setSelect(qn.el, ans.value);
    } else if (qn.kind === 'custom') {
      const ok = await fillCustom(qn.el, ans.value, cfg, report);
      if (!ok) return { filled: false, unknown: qn.required ? qn : null };
    } else if (qn.kind === 'checkbox') {
      if (!!qn.el.checked !== !!ans.value) await clickEl(qn.el);
    } else {
      await D.setValue(qn.el, ans.value, cfg);
    }

    report('field', qn.label.slice(0, 70) + ' = ' + (ans.optionLabel || ans.value));
    return { filled: true };
  }

  async function fillForm(form, cfg, job, report) {
    const unknowns = [];
    let filled = 0;
    for (const qn of questions(form)) {
      if (!qn.label && qn.kind !== 'file') continue;
      try {
        const r = await fillOne(qn, cfg, job, report);
        if (r.filled) { filled++; await D.humanPause(cfg); }
        if (r.unknown) {
          unknowns.push({
            label: qn.label, kind: qn.kind,
            options: (qn.options || []).map((o) => o.label)
          });
        }
      } catch (e) {
        report('warn', 'could not fill "' + qn.label.slice(0, 60) + '": ' + e.message);
      }
    }
    return { filled, unknowns };
  }

  // Anything still empty and marked required after a fill pass would fail the
  // form's own validation, so it is reported rather than submitted.
  function stillMissing(form) {
    return questions(form)
      .filter((qn) => qn.required && !valueOf(qn))
      .map((qn) => ({ label: qn.label, kind: qn.kind, options: (qn.options || []).map((o) => o.label) }));
  }

  // ---------------------------------------------------------------- submit

  function findSubmit(form) {
    const buttons = Array.from(form.querySelectorAll('button, input[type="submit"], [role="button"]'))
      .filter(visible)
      .filter((b) => !b.disabled);
    const label = (b) => cleanLabel(text(b) || b.value || b.getAttribute('aria-label'));
    const usable = buttons.filter((b) => !NOT_SUBMIT.test(label(b)));
    return usable.find((b) => SUBMIT_TEXT.test(label(b)))
      || usable.find((b) => /submit|apply|send/i.test(label(b)))
      || null;
  }

  async function confirmed(beforeUrl) {
    const hit = await waitFor(() => {
      if (DONE_TEXT.test(document.body.innerText || '')) return 'message';
      if (location.href !== beforeUrl && /thank|success|confirm|complete|submitted/i.test(location.href)) return 'url';
      return null;
    }, { timeout: 25000, interval: 700 });
    return hit;
  }

  function visibleErrors() {
    return Array.from(document.querySelectorAll('[class*="error"], [role="alert"]'))
      .filter(visible).map(text).filter(Boolean).slice(0, 3);
  }

  // For when Submit took the tab to a new page: a thank-you page, or the form
  // back again with the site's complaints on it.
  async function afterSubmit(ats) {
    const how = await confirmed('');
    if (how) return { status: 'applied', reason: 'submitted on ' + ats.name + ' (confirmed by ' + how + ')' };
    const errs = visibleErrors();
    return {
      status: 'failed',
      reason: errs.length ? 'form rejected: ' + errs.join('; ') : 'submitted, but the page that followed did not confirm it',
      keepTab: true
    };
  }

  // ------------------------------------------------------------- entrypoint

  // opts.atsHosts: recognised ATS host patterns, for embedded forms.
  // opts.submitting(): resolves once the background knows Submit is about to
  // be pressed.
  async function apply(job, cfg, ats, report, opts = {}) {
    await sleep(rand(1200, 2200));
    const shown = await revealForm(report, opts.atsHosts);
    // The background follows the tab and runs this again on the next page.
    if (shown.moved) return { status: 'moved', reason: 'went on to ' + shown.moved };

    const form = pickForm();
    if (!form) {
      const email = emailApply();
      if (email) return { status: 'needs_manual', reason: 'this job takes applications by email (' + email + '), not a form', noForm: true };
      const seen = applyButtonsSeen();
      return {
        status: 'needs_manual',
        reason: 'no application form found on ' + location.hostname + (seen.length ? ' (buttons seen: "' + seen.join('", "') + '")' : ''),
        noForm: true
      };
    }

    // A short form with a password box is a sign-in or sign-up page. Filling
    // it would create an account in the employer's recruiting system for you.
    const passwords = Array.from(form.querySelectorAll('input[type="password"]')).filter(visible);
    if (passwords.length && controlsIn(form).length <= 6) {
      return {
        status: 'needs_manual',
        reason: ats.name + ' wants you to sign in or create an account before it shows the application',
        keepTab: true
      };
    }

    report('portal', ats.name + ': found a form with ' + controlsIn(form).length + ' fields');

    const { filled, unknowns } = await fillForm(form, cfg, job, report);
    report('portal', 'filled ' + filled + ' field(s)');

    const missing = stillMissing(form);
    const blocking = [...unknowns, ...missing.filter((m) => !unknowns.some((u) => u.label === m.label))];

    if (blocking.length) {
      return {
        status: 'needs_manual',
        reason: 'left for you - unanswered required field(s): ' + blocking.map((b) => b.label).slice(0, 4).join(' | '),
        unknowns: blocking,
        keepTab: true
      };
    }

    const allowed = ats.mode === 'auto' || (ats.mode === 'unknown' && cfg.portal.submitUnknown);
    if (!allowed) {
      return {
        status: 'needs_manual',
        reason: ats.mode === 'unknown'
          ? 'form is filled in; submitting on unrecognised sites is off (website: Settings → 6. Company sites)'
          : ats.name + ' needs an account or a multi-step wizard - filled in as far as possible',
        keepTab: true
      };
    }

    const submit = findSubmit(form);
    if (!submit) return { status: 'needs_manual', reason: 'form filled but no submit button found', keepTab: true };

    if (cfg.safety.dryRun) {
      return { status: 'dry_run', reason: 'form filled and "' + cleanLabel(text(submit)) + '" located; dry run so nothing was sent' };
    }

    const before = location.href;
    report('portal', 'submitting');
    // Many sites answer Submit with a new page, and this script goes with the
    // old one. Telling the background first lets it read that as the form
    // being sent and check the new page, rather than as a failure.
    if (opts.submitting) await opts.submitting();
    await clickEl(submit);

    const how = await confirmed(before);
    if (!how) {
      const errs = visibleErrors();
      return {
        status: 'failed',
        reason: errs.length ? 'form rejected: ' + errs.join('; ') : 'submitted but no confirmation appeared',
        keepTab: true
      };
    }
    return { status: 'applied', reason: 'submitted on ' + ats.name + ' (confirmed by ' + how + ')' };
  }

  LEA.portal = { apply, afterSubmit, pickForm, questions, labelFor, findSubmit, controlsIn };
})(window.LEA);
