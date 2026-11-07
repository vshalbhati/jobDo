// Why jobs were skipped, grouped so that the setting behind each group is
// obvious. The backend's report email (backend/src/report.js) groups the same
// way; keep the two in step.
export const SKIP_KINDS = [
  { id: 'portalOff', test: /portal mode is off/i, label: 'on company sites, which are switched off', fix: 'Switch on company sites in Settings → 6. Company sites to apply to these.' },
  { id: 'below', test: /^ranked \d+/i, label: 'below your match bar', fix: 'Lower the match bar in Settings → 4. Matching & ranking to apply to more of these.' },
  { id: 'portalBudget', test: /company-portal budget/i, label: 'over the company-site limit for one run', fix: 'Raise "max per run" in Settings → 6. Company sites.' },
  { id: 'filters', test: /^(title excluded|title missing all of|company blocklisted|description excluded)/i, label: 'ruled out by your filters', fix: 'Check the title, company and description lists in Settings → 4. Matching & ranking.' },
  { id: 'already', test: /already applied/i, label: 'already applied to' },
  { id: 'noButton', test: /no easy apply button|no indeed apply button|only applies on the company site/i, label: 'with no quick-apply button' },
  { id: 'level', test: /^entry-level posting/i, label: 'internships or trainee roles' },
  { id: 'noText', test: /description did not load/i, label: 'whose description did not load' },
  { id: 'you', test: /you skipped it/i, label: 'skipped by you' },
  { id: 'noStart', test: /could not start the application/i, label: 'that would not start' }
];

// [{ id, label, fix, n }], largest first; reasons that fit no group are "other".
export function skipBreakdown(reasons) {
  const counts = new Map();
  for (const reason of reasons) {
    const kind = SKIP_KINDS.find((k) => k.test.test(String(reason || ''))) || { id: 'other', label: 'for other reasons' };
    const c = counts.get(kind.id) || { id: kind.id, label: kind.label, fix: kind.fix || '', n: 0 };
    c.n++;
    counts.set(kind.id, c);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n);
}

// "12 below your match bar, 6 already applied to" - and the fix for the
// biggest group, when a setting decides it.
export function describeSkips(reasons) {
  const groups = skipBreakdown(reasons);
  if (!groups.length) return { text: '', tip: '' };
  const text = groups.map((g) => g.n + ' ' + g.label).join(', ');
  const top = groups[0];
  return { text, tip: top.fix && top.n >= Math.max(2, reasons.length / 3) ? top.fix : '' };
}
