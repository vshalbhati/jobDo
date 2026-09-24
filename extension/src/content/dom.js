/* global window */
// Low-level DOM helpers shared by the scraper and the Easy Apply driver.
// LinkedIn is an Ember app: values set straight onto .value are ignored, so
// every write goes through the native setter plus input/change events.
window.LEA = window.LEA || {};

(function (LEA) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * Math.max(0, b - a));

  // Pause the way a person would between two form interactions.
  function humanPause(cfg) {
    const s = (cfg && cfg.safety) || {};
    return sleep(rand(s.actionMinMs ?? 500, s.actionMaxMs ?? 1600));
  }

  function q(sels, root) {
    const scope = root || document;
    for (const s of [].concat(sels)) {
      const el = scope.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function qa(sels, root) {
    const scope = root || document;
    for (const s of [].concat(sels)) {
      const els = Array.from(scope.querySelectorAll(s));
      if (els.length) return els;
    }
    return [];
  }

  function visible(el) {
    if (!el) return false;
    if (el.disabled) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function text(el) {
    return (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  async function waitFor(fn, { timeout = 12000, interval = 220 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let v;
      try { v = await fn(); } catch { v = null; }
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(interval);
    }
  }

  async function waitGone(fn, opts) {
    return waitFor(async () => !(await fn()), opts);
  }

  async function clickEl(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch { el.scrollIntoView(); }
    await sleep(rand(80, 220));
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2)
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
    return true;
  }

  function isEditable(el) {
    return !!el && (el.isContentEditable
      || el.getAttribute('contenteditable') === 'true'
      || el.getAttribute('contenteditable') === '');
  }

  // React/Ember track the value through the prototype setter; assigning
  // el.value directly leaves their internal state stale and the field reverts.
  function nativeSet(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : el instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;
    if (!proto) {
      // Not a form control at all - a contenteditable div, say. The prototype
      // setter would throw here, so write the text directly.
      el.textContent = value;
      return;
    }
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  async function setValue(el, value, cfg) {
    if (!el) return false;
    el.focus();
    if (isEditable(el) && !('value' in el)) {
      el.textContent = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (cfg) await humanPause(cfg);
      return true;
    }
    nativeSet(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(rand(40, 120));
    nativeSet(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (cfg) await humanPause(cfg);
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  function setSelect(el, optionValue) {
    if (!el) return false;
    nativeSet(el, optionValue);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // Finds a <button> whose visible text or aria-label matches any pattern.
  function findButton(patterns, root) {
    const scope = root || document;
    const buttons = Array.from(scope.querySelectorAll('button, a[role="button"]'));
    for (const re of [].concat(patterns)) {
      for (const b of buttons) {
        if (!visible(b)) continue;
        const label = (b.getAttribute('aria-label') || '').trim();
        if (re.test(text(b)) || re.test(label)) return b;
      }
    }
    return null;
  }

  // Scrolls a virtualised list to force LinkedIn to render every card.
  async function scrollThrough(container, steps = 12) {
    if (!container) return;
    const el = container.scrollHeight > container.clientHeight ? container : document.scrollingElement;
    for (let i = 0; i <= steps; i++) {
      el.scrollTo({ top: (el.scrollHeight * i) / steps, behavior: 'instant' });
      await sleep(rand(160, 320));
    }
    el.scrollTo({ top: 0, behavior: 'instant' });
    await sleep(300);
  }

  function labelOf(el, group) {
    if (!el) return '';
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab && text(lab)) return text(lab);
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/)
        .map((id) => document.getElementById(id)).filter(Boolean).map(text);
      if (parts.join(' ').trim()) return parts.join(' ').trim();
    }
    const wrap = el.closest('label');
    if (wrap && text(wrap)) return text(wrap);
    if (group) {
      const legend = group.querySelector('legend, .fb-dash-form-element__label, .artdeco-text-input--label');
      if (legend && text(legend)) return text(legend);
      return text(group).slice(0, 160);
    }
    return el.getAttribute('placeholder') || el.name || '';
  }

  LEA.dom = {
    sleep, rand, humanPause, q, qa, visible, text, waitFor, waitGone,
    clickEl, setValue, setSelect, findButton, scrollThrough, labelOf, isEditable
  };
})(window.LEA);
