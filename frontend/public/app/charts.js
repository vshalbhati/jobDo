// Small SVG chart set, written by hand so the dashboard carries no chart
// library. Every chart follows the same contract: thin marks, a 2px surface gap
// between touching marks, rounded data-ends squared at the baseline, hairline
// recessive gridlines, colours referenced as CSS custom properties so light and
// dark swap in one place, and a hover tooltip on every mark.

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

// A bar with its data-end rounded and its baseline end square.
function barPath(x, y, w, h, r, side) {
  const rad = Math.max(0, Math.min(r, w / 2, h));
  if (h <= 0.5) return '';
  if (side === 'top') {
    return `M${x},${y + h} L${x},${y + rad} Q${x},${y} ${x + rad},${y}` +
           ` L${x + w - rad},${y} Q${x + w},${y} ${x + w},${y + rad} L${x + w},${y + h} Z`;
  }
  // side === 'right'
  const rr = Math.max(0, Math.min(r, h / 2, w));
  return `M${x},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr}` +
         ` L${x + w},${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} L${x},${y + h} Z`;
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k' : String(n));

// One tooltip per chart container, positioned against the container box.
function tooltipFor(container) {
  let tip = container.querySelector('.viz-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.setAttribute('role', 'status');
    container.appendChild(tip);
  }
  return tip;
}

function attachTip(container, target, html) {
  const tip = tooltipFor(container);
  const show = (e) => {
    tip.innerHTML = html;
    tip.classList.add('on');
    const box = container.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    tip.style.left = Math.max(4, Math.min(x + 12, box.width - tip.offsetWidth - 4)) + 'px';
    tip.style.top = Math.max(4, y - tip.offsetHeight - 10) + 'px';
  };
  target.addEventListener('mouseenter', show);
  target.addEventListener('mousemove', show);
  target.addEventListener('mouseleave', () => tip.classList.remove('on'));
  target.addEventListener('focus', show);
  target.addEventListener('blur', () => tip.classList.remove('on'));
}

// viewBoxWidth lets a chart size its own coordinate space (the calendar knows
// exactly how wide it needs to be) and still scale down to fit the container.
function frame(container, height, viewBoxWidth) {
  container.querySelectorAll('svg').forEach((s) => s.remove());
  const width = viewBoxWidth || Math.max(320, container.clientWidth || 640);
  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`, width: '100%', height,
    preserveAspectRatio: viewBoxWidth ? 'xMinYMid meet' : 'xMidYMid meet', role: 'img'
  }, container);
  return { svg, width, height };
}

function empty(container, message) {
  container.querySelectorAll('svg').forEach((s) => s.remove());
  const p = container.querySelector('.viz-empty') || document.createElement('p');
  p.className = 'viz-empty';
  p.textContent = message;
  if (!p.parentElement) container.appendChild(p);
  return true;
}

function clearEmpty(container) {
  const p = container.querySelector('.viz-empty');
  if (p) p.remove();
}

// ---------------------------------------------------------------------------
// Columns over time. One series, so no legend - the card title names it. Only
// the tallest column is direct-labelled; the axis carries the rest.
export function columnChart(container, data, opts = {}) {
  if (!data.length || data.every((d) => !d.value)) {
    return empty(container, opts.emptyText || 'Nothing in this period yet.');
  }
  clearEmpty(container);

  const H = opts.height || 220;
  const { svg, width } = frame(container, H);
  const pad = { top: 18, right: 8, bottom: 26, left: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const max = Math.max(...data.map((d) => d.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const y = (v) => pad.top + plotH - (v / top) * plotH;

  for (const t of ticks) {
    el('line', {
      x1: pad.left, x2: width - pad.right, y1: y(t), y2: y(t),
      class: t === 0 ? 'viz-axis' : 'viz-grid'
    }, svg);
    const label = el('text', { x: pad.left - 8, y: y(t) + 4, class: 'viz-tick', 'text-anchor': 'end' }, svg);
    label.textContent = fmt(t);
  }

  const band = plotW / data.length;
  const barW = Math.max(2, Math.min(24, band - 2));   // 2px surface gap
  const peak = data.reduce((a, b) => (b.value > a.value ? b : a), data[0]);

  data.forEach((d, i) => {
    const x = pad.left + i * band + (band - barW) / 2;
    const h = (d.value / top) * plotH;
    const g = el('g', { tabindex: '0', class: 'viz-mark' }, svg);
    // Full-height hit target: a 4px column is far too small to hover.
    el('rect', { x: pad.left + i * band, y: pad.top, width: band, height: plotH, class: 'viz-hit' }, g);
    if (d.value > 0) {
      el('path', { d: barPath(x, y(d.value), barW, h, 4, 'top'), class: 'viz-bar' }, g);
    }
    attachTip(container, g, `<b>${d.value}</b> ${opts.unit || 'applications'}<br>${d.tip || d.label}`);
  });

  // x labels: spaced by measured distance, never by index alone. The last
  // column is always labelled, and anything that would crowd it is dropped
  // rather than nudged - a nudged label detaches from its column.
  const MIN_GAP = 58;
  const xOf = (i) => pad.left + i * band + band / 2;
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / MIN_GAP))));
  const kept = [];
  for (let i = 0; i < data.length; i += every) {
    if (!kept.length || xOf(i) - xOf(kept[kept.length - 1]) >= MIN_GAP) kept.push(i);
  }
  const last = data.length - 1;
  if (kept[kept.length - 1] !== last) {
    while (kept.length && xOf(last) - xOf(kept[kept.length - 1]) < MIN_GAP) kept.pop();
    kept.push(last);
  }
  for (const i of kept) {
    const t = el('text', { x: xOf(i), y: H - 8, class: 'viz-tick', 'text-anchor': 'middle' }, svg);
    t.textContent = data[i].label;
  }

  if (peak.value > 0) {
    const i = data.indexOf(peak);
    const t = el('text', {
      x: pad.left + i * band + band / 2, y: y(peak.value) - 7,
      class: 'viz-value', 'text-anchor': 'middle'
    }, svg);
    t.textContent = String(peak.value);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Part-to-whole, horizontal. Status colours never carry meaning alone: every
// segment appears in the legend with its name and count, and wide-enough
// segments are direct-labelled too.
export function stackedBar(container, segments, opts = {}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (!total) return empty(container, opts.emptyText || 'Nothing recorded yet.');
  clearEmpty(container);

  const H = 40;
  const { svg, width } = frame(container, H);
  const barH = 28;
  const yTop = 6;
  const gap = 2;                                  // surface gap between segments
  const shown = segments.filter((s) => s.value > 0);
  const usable = width - gap * Math.max(0, shown.length - 1);

  let x = 0;
  shown.forEach((s, i) => {
    const w = (s.value / total) * usable;
    const first = i === 0;
    const last = i === shown.length - 1;
    const g = el('g', { tabindex: '0', class: 'viz-mark' }, svg);
    const path = el('path', {
      d: last ? barPath(x, yTop, w, barH, 4, 'right')
        : first ? barPath(x, yTop, w, barH, 0, 'right')
          : barPath(x, yTop, w, barH, 0, 'right')
    }, g);
    path.style.fill = s.color;
    const pct = Math.round((s.value / total) * 100);
    attachTip(container, g, `<b>${s.value}</b> ${s.label}<br>${pct}% of ${total}`);

    // Only label inside the segment when the text genuinely fits.
    const label = el('text', {
      x: x + w / 2, y: yTop + barH / 2 + 4, 'text-anchor': 'middle', class: 'viz-inbar'
    }, g);
    label.textContent = String(s.value);
    label.style.fill = s.ink || '#ffffff';
    if (label.getComputedTextLength() + 16 > w) label.remove();

    x += w + gap;
  });

  const legend = container.querySelector('.viz-legend') || document.createElement('div');
  legend.className = 'viz-legend';
  legend.innerHTML = '';
  for (const s of segments) {
    const item = document.createElement('span');
    item.className = 'viz-legend-item';
    const dot = document.createElement('i');
    dot.style.background = s.color;
    const txt = document.createElement('span');
    txt.textContent = s.label + ' ' + s.value;
    item.append(dot, txt);
    legend.appendChild(item);
  }
  if (!legend.parentElement) container.appendChild(legend);
  return true;
}

// ---------------------------------------------------------------------------
// Ranked horizontal bars. Magnitude comparison -> one hue, not categorical.
export function barChart(container, data, opts = {}) {
  if (!data.length) return empty(container, opts.emptyText || 'Nothing to rank yet.');
  clearEmpty(container);

  const rowH = 26;
  const H = data.length * rowH + 10;
  const { svg, width } = frame(container, H);
  const labelW = Math.min(180, Math.max(90, Math.round(width * 0.34)));
  const plotW = width - labelW - 44;
  const max = Math.max(...data.map((d) => d.value));

  data.forEach((d, i) => {
    const y = i * rowH + 5;
    const barH = Math.min(24, rowH - 2);          // 2px gap between neighbours
    const w = Math.max(2, (d.value / max) * plotW);
    const g = el('g', { tabindex: '0', class: 'viz-mark' }, svg);
    el('rect', { x: 0, y, width, height: rowH, class: 'viz-hit' }, g);

    const name = el('text', { x: 0, y: y + barH / 2 + 4, class: 'viz-rowlabel' }, g);
    name.textContent = d.label;
    if (name.getComputedTextLength() > labelW - 10) {
      let s = d.label;
      while (s.length > 4 && name.getComputedTextLength() > labelW - 16) {
        s = s.slice(0, -1);
        name.textContent = s + '…';
      }
    }
    el('path', { d: barPath(labelW, y, w, barH, 4, 'right'), class: 'viz-bar' }, g);
    const val = el('text', { x: labelW + w + 7, y: y + barH / 2 + 4, class: 'viz-value' }, g);
    val.textContent = String(d.value);
    attachTip(container, g, `<b>${d.value}</b> ${opts.unit || 'applications'}<br>${d.label}`);
  });
  return true;
}

// ---------------------------------------------------------------------------
// Calendar heatmap: sequential one-hue ramp, light means near-zero.
const RAMP = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];

export function heatmap(container, days, opts = {}) {
  if (!days.length) return empty(container, 'No activity yet.');
  clearEmpty(container);

  const cell = 14, gap = 2, topPad = 16, leftPad = 26;
  const weeks = Math.ceil(days.length / 7);
  const H = topPad + 7 * (cell + gap);
  // The grid has a fixed natural width; give the viewBox exactly that so it
  // scales down on a narrow card instead of overflowing the card's edge.
  const { svg } = frame(container, H, leftPad + weeks * (cell + gap));
  const max = Math.max(1, ...days.map((d) => d.value));

  const dayNames = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];
  dayNames.forEach((n, i) => {
    if (!n) return;
    const t = el('text', { x: 0, y: topPad + i * (cell + gap) + cell - 2, class: 'viz-tick' }, svg);
    t.textContent = n;
  });

  let lastMonth = -1;
  days.forEach((d, i) => {
    const col = Math.floor(i / 7);
    const row = i % 7;
    const x = leftPad + col * (cell + gap);
    const y = topPad + row * (cell + gap);
    const step = d.value === 0 ? -1 : Math.min(RAMP.length - 1, Math.floor((d.value / max) * RAMP.length));
    const g = el('g', { tabindex: '0', class: 'viz-mark' }, svg);
    const r = el('rect', { x, y, width: cell, height: cell, rx: 3 }, g);
    r.style.fill = step < 0 ? 'var(--cell-empty)' : RAMP[step];
    attachTip(container, g,
      `<b>${d.value}</b> ${opts.unit || 'applications'}<br>${d.date.toDateString()}`);

    const m = d.date.getMonth();
    if (row === 0 && m !== lastMonth) {
      lastMonth = m;
      const t = el('text', { x, y: topPad - 5, class: 'viz-tick' }, svg);
      t.textContent = d.date.toLocaleString(undefined, { month: 'short' });
    }
  });

  const key = container.querySelector('.viz-key') || document.createElement('div');
  key.className = 'viz-key';
  key.innerHTML = '<span>Less</span>' +
    ['var(--cell-empty)', ...RAMP].map((c) => `<i style="background:${c}"></i>`).join('') +
    '<span>More</span>';
  if (!key.parentElement) container.appendChild(key);
  return true;
}

export { fmt };
