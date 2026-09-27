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

  // Like text(), but keeps line breaks. Job descriptions need them: the
  // ranker tells "Requirements" from "Nice to have" by the headings, and a
  // heading is only recognisable on a line of its own.
  function blockText(el) {
    return (el && (el.innerText || el.textContent) || '')
      .replace(/\r/g, '')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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

  // ----------------------------------------------------------------- files

  // The résumé as the extension stores it - a data: URL - as a File a form
  // input can take. Decoded by hand, so it depends on nothing the page allows.
  function fileFromDataUrl(dataUrl, name, mime) {
    const comma = dataUrl.indexOf(',');
    const meta = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    const bytes = meta.includes(';base64')
      ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(body));
    return new File([bytes], name || 'resume.pdf', { type: mime || 'application/pdf' });
  }

  // Whether a page's rendering of a file name is this file. Sites drop the
  // extension, change the case, swap spaces for underscores, or cut a long
  // name short.
  function sameFileName(shown, name) {
    const norm = (s) => String(s || '').toLowerCase()
      .replace(/(…|\.\.\.)\s*$/, '')
      .replace(/\.(pdf|docx?|txt|rtf|odt)$/i, '')
      .replace(/[^a-z0-9]+/g, '');
    const a = norm(shown);
    const b = norm(name);
    if (!a || !b) return false;
    return a === b || (a.length >= 8 && b.startsWith(a)) || (b.length >= 8 && a.startsWith(b));
  }

  // ---------------------------------------------------------- page panels
  //
  // The cards jobDo shows on a job site's own page: "Ready to submit" and
  // "Over to you". Drawn in a shadow root so the site's CSS cannot restyle
  // them and theirs cannot leak onto the site, and styled through a
  // constructed stylesheet, which a site's Content-Security-Policy does not
  // block the way it can a <style> element.

  const PANEL_CSS = `
    :host { all: initial; }
    .p {
      box-sizing: border-box; width: 330px; position: relative; overflow: hidden;
      padding: 16px 16px 16px; border-radius: 14px;
      font: 13px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
      color: #0b0b0b; background: #ffffff; border: 1px solid rgba(11, 11, 11, .12);
      box-shadow: 0 20px 44px -14px rgba(0, 0, 0, .38);
      animation: in .18s ease-out;
    }
    .p::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: linear-gradient(90deg, #3b8cea, #2554c7); }
    .p.warn::before { background: #fab219; }
    @keyframes in { from { opacity: 0; transform: translateY(6px); } }
    @media (prefers-reduced-motion: reduce) { .p { animation: none; } }
    .top { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; }
    .top svg { width: 22px; height: 22px; flex: none; }
    .top span b { color: #2a78d6; }
    .x { margin-left: auto; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 8px; background: none; color: #898781; cursor: pointer; font: inherit; font-size: 17px; line-height: 1; }
    .x:hover { background: rgba(11, 11, 11, .06); color: #0b0b0b; }
    .t { margin: 10px 0 2px; font-size: 14.5px; font-weight: 650; letter-spacing: -.005em; }
    .b { color: #52514e; font-size: 12.5px; }
    .n { margin-top: 6px; color: #898781; font-size: 12px; }
    .acts { display: flex; gap: 8px; margin-top: 14px; }
    .acts button { flex: 1; height: 36px; border-radius: 10px; cursor: pointer; font: inherit; font-size: 13px; font-weight: 650; }
    .primary { border: 0; color: #ffffff; background: linear-gradient(135deg, #3b8cea, #2554c7); box-shadow: 0 6px 14px -6px rgba(37, 84, 199, .7); }
    .primary:hover { filter: brightness(1.07); }
    .secondary { color: #0b0b0b; background: #ffffff; border: 1px solid rgba(11, 11, 11, .16); }
    .secondary:hover { background: #f5f5f3; }
    button:focus-visible { outline: 2px solid rgba(42, 120, 214, .7); outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .p { color: #ffffff; background: #1a1a19; border-color: rgba(255, 255, 255, .12); }
      .b { color: #c3c2b7; }
      .top span b { color: #3987e5; }
      .x:hover { background: rgba(255, 255, 255, .08); color: #ffffff; }
      .secondary { color: #ffffff; background: #222221; border-color: rgba(255, 255, 255, .16); }
      .secondary:hover { background: #2a2a29; }
    }`;

  const PANEL_LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#4f9bf0"/><stop offset="1" stop-color="#2554c7"/></linearGradient></defs>' +
    '<rect width="32" height="32" rx="9" fill="url(#g)"/><path d="M9.5 16.5l4.2 4.2 8.8-9.4" fill="none" stroke="#fff"' +
    ' stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // opts: { id, where: 'top' | 'bottom', tone: 'accent' | 'warn', title, body,
  //         note, actions: [{ label, primary, onClick }], onClose }
  // Returns close(). A panel with the same id is replaced.
  function panel(opts) {
    const old = document.getElementById(opts.id);
    if (old) old.remove();
    const host = document.createElement('div');
    host.id = opts.id;
    host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;' + (opts.where === 'top' ? 'top:16px;' : 'bottom:16px;');
    const root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(PANEL_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = PANEL_CSS;
      root.appendChild(style);
    }

    const el = (tag, cls, txt) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (txt !== undefined) n.textContent = txt;
      return n;
    };
    const box = el('div', 'p' + (opts.tone === 'warn' ? ' warn' : ''));
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'jobDo: ' + opts.title);
    const top = el('div', 'top');
    top.innerHTML = PANEL_LOGO + '<span>job<b>Do</b></span>';
    const close = () => { host.remove(); if (opts.onClose) opts.onClose(); };
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.onclick = close;
    top.appendChild(x);
    box.append(top, el('div', 't', opts.title));
    if (opts.body) box.appendChild(el('div', 'b', opts.body));
    if (opts.note) box.appendChild(el('div', 'n', opts.note));
    if (opts.actions && opts.actions.length) {
      const acts = el('div', 'acts');
      for (const a of opts.actions) {
        const b = el('button', a.primary ? 'primary' : 'secondary', a.label);
        b.type = 'button';
        b.onclick = () => { host.remove(); if (a.onClick) a.onClick(); };
        acts.appendChild(b);
      }
      box.appendChild(acts);
    }
    root.appendChild(box);
    (document.body || document.documentElement).appendChild(host);
    return () => host.remove();
  }

  LEA.dom = {
    sleep, rand, humanPause, q, qa, visible, text, blockText, waitFor, waitGone,
    clickEl, setValue, setSelect, findButton, scrollThrough, labelOf, isEditable,
    fileFromDataUrl, sameFileName, panel
  };
})(window.LEA);
