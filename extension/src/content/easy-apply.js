/* global window */
// Drives the Easy Apply modal: fill -> next -> ... -> review -> submit.
// Every exit path either submits or discards; it never leaves a half-filled
// modal open, because a stuck modal blocks the next job.
window.LEA = window.LEA || {};

(function (LEA) {
  const D = LEA.dom;
  const { q, qa, text, visible, waitFor, clickEl, sleep, labelOf } = D;
  const SEL = LEA.SEL;
  const BTN = LEA.BTN;

  const MAX_STEPS = 16;

  // ---------------------------------------------------------------- widgets

  function modalRoot() {
    const m = q(SEL.modal);
    return m && visible(m) ? m : null;
  }

  function optionsOfSelect(sel) {
    return Array.from(sel.options).map((o) => ({ value: o.value, label: o.text }));
  }

  function radiosIn(group) {
    return Array.from(group.querySelectorAll('input[type="radio"]'));
  }

  function optionsOfRadios(radios) {
    return radios.map((r) => ({ value: r.value, label: labelOf(r) || r.value, el: r }));
  }

  // Classifies one form group into a single fillable widget.
  function widgetOf(group) {
    const sel = group.querySelector('select');
    if (sel) return { kind: 'select', el: sel, options: optionsOfSelect(sel) };

    const radios = radiosIn(group);
    if (radios.length) return { kind: 'radio', el: radios[0], radios, options: optionsOfRadios(radios) };

    const ta = group.querySelector('textarea');
    if (ta) return { kind: 'textarea', el: ta };

    const cbs = Array.from(group.querySelectorAll('input[type="checkbox"]'));
    if (cbs.length === 1) return { kind: 'checkbox', el: cbs[0] };
    if (cbs.length > 1) return { kind: 'radio', el: cbs[0], radios: cbs, options: optionsOfRadios(cbs), multi: true };

    const input = group.querySelector('input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"])');
    if (input) {
      const typeahead = input.getAttribute('role') === 'combobox' || input.getAttribute('aria-autocomplete') === 'list';
      const numeric = input.type === 'number' || /^\d*$/.test(input.getAttribute('pattern') || '') && input.inputMode === 'numeric';
      return { kind: typeahead ? 'typeahead' : (numeric ? 'number' : 'text'), el: input };
    }
    return null;
  }

  // For a radio group, labelOf(input) returns the *option* text ("Yes"), not
  // the question. The question lives in the fieldset's legend.
  function questionLabel(group, w) {
    if (w.kind === 'radio') {
      const fs = w.el.closest('fieldset') || group;
      const legend = fs.querySelector('legend');
      const fromLegend = text(legend);
      if (fromLegend) return fromLegend.replace(/\s*required\s*$/i, '').trim();
      const lab = group.querySelector('.fb-dash-form-element__label, .artdeco-text-input--label');
      if (text(lab)) return text(lab);
      return text(group).slice(0, 160);
    }
    return labelOf(w.el, group);
  }

  function isRequired(group, w) {
    if (w && w.el && (w.el.required || w.el.getAttribute('aria-required') === 'true')) return true;
    return /\*/.test(text(group).slice(0, 200)) || !!q(SEL.fieldError, group);
  }

  function currentValue(w) {
    if (!w) return '';
    if (w.kind === 'radio') return (w.radios.find((r) => r.checked) || {}).value || '';
    if (w.kind === 'checkbox') return w.el.checked ? 'on' : '';
    if (w.kind === 'select') {
      const v = w.el.value;
      const lab = LEA.answers.norm(w.el.selectedOptions[0] ? w.el.selectedOptions[0].text : '');
      if (!v || /^(select an option|choose|please select)/.test(lab)) return '';
      return v;
    }
    return (w.el.value || '').trim();
  }

  async function writeWidget(w, ans, cfg) {
    if (w.kind === 'select') return D.setSelect(w.el, ans.value);

    if (w.kind === 'radio') {
      const target = w.radios.find((r) => r.value === ans.value)
        || w.radios.find((r) => LEA.answers.norm(labelOf(r)) === LEA.answers.norm(ans.optionLabel));
      if (!target) return false;
      const lab = target.id ? document.querySelector('label[for="' + CSS.escape(target.id) + '"]') : null;
      await clickEl(lab && visible(lab) ? lab : target);
      if (!target.checked) { target.checked = true; target.dispatchEvent(new Event('change', { bubbles: true })); }
      return true;
    }

    if (w.kind === 'checkbox') {
      if (!!w.el.checked !== !!ans.value) await clickEl(w.el);
      return true;
    }

    if (w.kind === 'typeahead') {
      await D.setValue(w.el, ans.value, cfg);
      const opt = await waitFor(() => {
        const o = q(SEL.typeaheadOption);
        return o && visible(o) ? o : null;
      }, { timeout: 3500 });
      if (opt) { await clickEl(opt); await sleep(300); }
      return true;
    }

    return D.setValue(w.el, ans.value, cfg);
  }

  // ------------------------------------------------------------- one screen

  async function fillStep(cfg, report) {
    const modal = modalRoot();
    if (!modal) return { unknowns: [], filled: 0 };

    const groups = qa(SEL.formGroup, modal);
    const unknowns = [];
    let filled = 0;

    for (const group of groups) {
      const w = widgetOf(group);
      if (!w) continue;
      // Radio and checkbox inputs are visually replaced by styled labels, so
      // the input itself often measures as invisible - probe the group.
      if (!visible(w.kind === 'radio' || w.kind === 'checkbox' ? group : w.el)) continue;
      // Skip LinkedIn's own controls that aren't questions.
      if (w.el.closest(SEL.resumeCard.join(','))) continue;
      if (/follow/i.test(w.el.id || '')) continue;

      const label = questionLabel(group, w);
      if (!label) continue;

      const existing = currentValue(w);
      if (existing && w.kind !== 'checkbox') continue;   // already prefilled by LinkedIn

      const ans = LEA.answers.resolve(label, w.kind === 'typeahead' ? 'text' : w.kind, w.options, cfg);
      if (ans.unknown) {
        if (isRequired(group, w)) unknowns.push({ label, kind: w.kind, options: (w.options || []).map((o) => o.label) });
        continue;
      }

      const ok = await writeWidget(w, ans, cfg);
      if (ok) {
        filled++;
        report('field', label + ' = ' + (ans.optionLabel || ans.value) + ' [' + (ans.source || w.kind) + ']');
        await D.humanPause(cfg);
      }
    }

    await handleResume(cfg, report);
    await unfollowCompany();

    return { unknowns, filled };
  }

  async function handleResume(cfg, report) {
    const modal = modalRoot();
    if (!modal) return;
    const card = q(SEL.resumeCard, modal);
    if (!card) return;

    const radios = Array.from(modal.querySelectorAll('input[type="radio"]'))
      .filter((r) => r.closest(SEL.resumeCard.join(',')));
    const wantUpload = cfg.resume && cfg.resume.strategy === 'upload' && cfg.resume.dataUrl;

    if (!wantUpload && radios.length) {
      if (!radios.some((r) => r.checked)) {
        await clickEl(radios[0]);
        report('resume', 'selected saved resume');
      }
      return;
    }

    if (wantUpload) {
      const input = q(SEL.resumeFileInput, modal);
      if (!input) return;
      try {
        const blob = await (await fetch(cfg.resume.dataUrl)).blob();
        const file = new File([blob], cfg.resume.fileName || 'resume.pdf', {
          type: cfg.resume.mime || 'application/pdf'
        });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        report('resume', 'uploaded ' + file.name);
        await sleep(2500);
      } catch (e) {
        report('warn', 'resume upload failed: ' + e.message);
      }
    } else if (radios.length === 0) {
      report('warn', 'no saved resume found on this step');
    }
  }

  async function unfollowCompany() {
    const cb = q(SEL.followCompany);
    if (cb && cb.checked && visible(cb)) await clickEl(cb);
  }

  // A fingerprint of the current screen, used to tell "the Next click worked"
  // from "the Next click was rejected and we're looking at the same screen".
  function stepSignature() {
    const modal = modalRoot();
    if (!modal) return 'none';
    const meter = q(SEL.progressMeter, modal);
    const pct = meter ? (meter.getAttribute('aria-valuenow') || meter.value || '') : '';
    const labels = qa(SEL.formGroup, modal).map((g) => text(g).slice(0, 40)).join('|');
    return pct + '::' + text(q('h3, h2', modal)).slice(0, 60) + '::' + labels.slice(0, 400);
  }

  function errorsOnScreen() {
    const modal = modalRoot();
    if (!modal) return [];
    return qa(SEL.fieldError, modal).map(text).filter(Boolean);
  }

  // ---------------------------------------------------------------- closing

  async function discard(report) {
    const modal = modalRoot();
    if (!modal) return;
    const x = q(SEL.dismiss, modal) || q(SEL.dismiss);
    if (x) await clickEl(x);
    await sleep(700);
    const confirm = D.findButton(BTN.discard) || q(SEL.discardConfirm);
    if (confirm) await clickEl(confirm);
    await sleep(600);
    if (modalRoot()) {
      const x2 = q(SEL.dismiss);
      if (x2) { await clickEl(x2); await sleep(400); }
      const c2 = D.findButton(BTN.discard);
      if (c2) await clickEl(c2);
    }
    report('modal', 'discarded');
  }

  async function closeConfirmation() {
    await sleep(900);
    const done = D.findButton(BTN.done) || q(SEL.dismiss);
    if (done) await clickEl(done);
    await sleep(500);
    const stillOpen = q(SEL.dismiss);
    if (stillOpen && visible(stillOpen)) await clickEl(stillOpen);
  }

  // ------------------------------------------------------- confirm overlay

  function askUserConfirm(job) {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.id = 'lea-confirm';
      host.innerHTML = [
        '<div class="lea-box">',
        '<div class="lea-t">Ready to submit</div>',
        '<div class="lea-j"></div>',
        '<div class="lea-b">',
        '<button class="lea-yes">Submit</button>',
        '<button class="lea-no">Skip this job</button>',
        '</div></div>'
      ].join('');
      Object.assign(host.style, {
        position: 'fixed', inset: 'auto 16px 16px auto', zIndex: 2147483647,
        font: '14px -apple-system, Segoe UI, Roboto, sans-serif'
      });
      const box = host.querySelector('.lea-box');
      Object.assign(box.style, {
        background: '#fff', color: '#1b1f23', border: '1px solid #0a66c2',
        borderRadius: '10px', padding: '14px 16px', width: '300px',
        boxShadow: '0 8px 28px rgba(0,0,0,.25)'
      });
      host.querySelector('.lea-t').style.fontWeight = '600';
      host.querySelector('.lea-j').textContent = job.title + ' - ' + job.company;
      Object.assign(host.querySelector('.lea-j').style, { margin: '6px 0 12px', fontSize: '13px', color: '#56687a' });
      host.querySelector('.lea-b').style.display = 'flex';
      host.querySelector('.lea-b').style.gap = '8px';
      for (const b of host.querySelectorAll('button')) {
        Object.assign(b.style, {
          flex: '1', padding: '8px 10px', borderRadius: '16px', cursor: 'pointer',
          border: '1px solid #0a66c2', background: '#fff', color: '#0a66c2', fontWeight: '600'
        });
      }
      const yes = host.querySelector('.lea-yes');
      Object.assign(yes.style, { background: '#0a66c2', color: '#fff' });

      const finish = (v) => { host.remove(); clearTimeout(timer); resolve(v); };
      yes.onclick = () => finish('submit');
      host.querySelector('.lea-no').onclick = () => finish('skip');
      const timer = setTimeout(() => finish('skip'), 5 * 60 * 1000);
      document.body.appendChild(host);
    });
  }

  // ------------------------------------------------------------- main flow

  async function applyToJob(job, cfg, report) {
    const btn = LEA.scrape.easyApplyButton();
    if (!btn) return { status: 'skipped', reason: 'no Easy Apply button (company portal job)' };

    await clickEl(btn);
    const modal = await waitFor(() => modalRoot(), { timeout: 12000 });
    if (!modal) return { status: 'failed', reason: 'Easy Apply modal never opened' };
    report('modal', 'opened');

    let repeats = 0;

    for (let step = 1; step <= MAX_STEPS; step++) {
      await sleep(D.rand(400, 900));
      if (!modalRoot()) return { status: 'failed', reason: 'modal closed unexpectedly at step ' + step };

      const { unknowns, filled } = await fillStep(cfg, report);
      report('step', 'step ' + step + ': filled ' + filled + ' field(s)');

      if (unknowns.length && cfg.safety.stopOnUnknownQuestion) {
        await discard(report);
        return {
          status: 'needs_manual',
          reason: 'unanswered required question: ' + unknowns.map((u) => u.label).join(' | '),
          unknowns
        };
      }

      const submit = D.findButton(BTN.submit, modalRoot());
      if (submit) {
        if (cfg.safety.dryRun) {
          await discard(report);
          return { status: 'dry_run', reason: 'reached Submit; dry run enabled so nothing was sent' };
        }
        if (cfg.safety.reviewBeforeSubmit) {
          report('confirm', 'waiting for your confirmation');
          const choice = await askUserConfirm(job);
          if (choice !== 'submit') {
            await discard(report);
            return { status: 'skipped', reason: 'you skipped it at the review step' };
          }
        }
        await clickEl(submit);
        const gone = await waitFor(() => (!D.findButton(BTN.submit, modalRoot()) ? true : null), { timeout: 15000 });
        await closeConfirmation();
        if (!gone) return { status: 'failed', reason: 'Submit clicked but the form did not close' };
        return { status: 'applied', reason: 'submitted' };
      }

      const nextBtn = D.findButton(BTN.review, modalRoot()) || D.findButton(BTN.next, modalRoot());
      if (!nextBtn) {
        const errs = errorsOnScreen();
        await discard(report);
        return {
          status: 'failed',
          reason: errs.length ? 'no Next/Submit button; errors: ' + errs.join('; ') : 'no Next/Submit button on step ' + step
        };
      }

      const sig = stepSignature();
      await clickEl(nextBtn);
      await sleep(D.rand(900, 1600));

      const newSig = stepSignature();
      if (newSig === sig) {
        repeats++;
        const errs = errorsOnScreen();
        report('warn', 'step did not advance' + (errs.length ? ': ' + errs.join('; ') : ''));
        if (repeats >= 2) {
          await discard(report);
          return {
            status: errs.length ? 'needs_manual' : 'failed',
            reason: errs.length ? 'form rejected our answers: ' + errs.join('; ') : 'stuck on step ' + step,
            unknowns: errs.map((e) => ({ label: e, kind: 'error', options: [] }))
          };
        }
      } else {
        repeats = 0;
      }
    }

    await discard(report);
    return { status: 'failed', reason: 'more than ' + MAX_STEPS + ' steps; gave up' };
  }

  // askUserConfirm is shared: every board's apply flow needs the same
  // "ready to submit" prompt when review-before-submit is on.
  LEA.easyApply = { applyToJob, discard, modalRoot, askUserConfirm };
})(window.LEA);
