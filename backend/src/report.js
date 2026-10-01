// The email sent when a run ends: what it applied to, what is waiting on you,
// and what did not go through. Built from the account's own records, so it
// says exactly what the dashboard says.
import { config } from './config.js';

const SITE_NAMES = { linkedin: 'LinkedIn', naukri: 'Naukri', indeed: 'Indeed', direct: 'Your job list' };
const LIST_MAX = 40;   // jobs listed per section; the rest are on the dashboard

// How a run ended, as the extension reports it. A code rather than text, so
// nothing a client sends is written into the email as-is.
const ENDINGS = {
  done: 'went through every board',
  maxPerRun: 'reached its limit for one run',
  maxPerDay: 'reached the daily limit',
  stopped: 'stopped by you',
  errors: 'stopped after repeated errors'
};

const C = {
  page: '#f3f3f0', surface: '#ffffff', inset: '#f8f8f6', line: '#e8e7e1',
  text: '#0b0b0b', secondary: '#52514e', muted: '#898781', accent: '#2a78d6',
  good: '#0a7f0a', warn: '#9a6700', bad: '#b42828'
};
// Single quotes: it goes inside style="...".
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function runReport({ records, startedAt, endedAt, tz, ending }) {
  const by = (s) => records.filter((r) => r.status === s);
  const applied = by('applied');
  const needs = by('needs_manual');
  const failed = by('failed');
  const dry = by('dry_run');
  const skipped = by('skipped');
  if (!records.length) return null;

  const counts = {
    applied: applied.length, needsYou: needs.length, failed: failed.length,
    dryRun: dry.length, skipped: skipped.length
  };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  let headline, subject;
  if (applied.length) {
    headline = 'Applied to ' + plural(applied.length, 'job', 'jobs');
    subject = 'jobDo: applied to ' + plural(applied.length, 'job', 'jobs');
  } else if (dry.length) {
    headline = 'Dry run: ' + plural(dry.length, 'job', 'jobs') + ' ready to send';
    subject = 'jobDo dry run: ' + plural(dry.length, 'job', 'jobs') + ' ready to send';
  } else {
    headline = 'No applications this run';
    subject = 'jobDo: no applications this run';
  }
  if (needs.length) subject += ', ' + needs.length + ' need' + (needs.length === 1 ? 's' : '') + ' you';

  const when = span(startedAt, endedAt, tz) + (ENDINGS[ending] ? ' · ' + ENDINGS[ending] : '');

  const sections = [
    { title: 'Waiting on you', note: 'These stopped at a step only you can finish. Open each one to complete it.', rows: needs, reason: true, tone: C.warn },
    { title: 'Applied', rows: applied, tone: C.good },
    { title: 'Ready to send (dry run)', note: 'Dry run is on, so these were filled in but not submitted.', rows: dry },
    { title: 'Did not go through', rows: failed, reason: true, tone: C.bad }
  ].filter((s) => s.rows.length);

  const tiles = [
    applied.length || !dry.length ? ['Applied', applied.length, C.good] : ['Ready to send', dry.length, C.accent],
    ['Waiting on you', needs.length, C.warn],
    ['Did not go through', failed.length, C.bad],
    ['Skipped', skipped.length, C.muted]
  ];

  return {
    subject,
    counts,
    html: page(headline, when, tiles, sections,
      skipped.length ? plural(skipped.length, 'job was', 'jobs were') + ' skipped: below your match threshold, already applied, or not a fit for the filters you set.' : '',
      'You get this email when a run ends. Switch it off in Settings → Daily run, safety and pacing.'),
    text: textVersion(headline, when, sections, counts)
  };
}

// The email after a scheduled favourite-companies check: the new matches it
// put on your job list, and any company it could not read. Null when there is
// nothing to say.
export function companyReport({ result, added, tz }) {
  const failed = result.companies.filter((c) => c.error);
  if (!added.length && !failed.length && !result.error) return null;
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const names = [...new Set(added.map((a) => a.company))];
  const headline = added.length
    ? plural(added.length, 'new match', 'new matches') + ' at your favourite companies'
    : 'Your favourite companies could not all be checked';
  const subject = added.length
    ? 'jobDo: ' + plural(added.length, 'new match', 'new matches') + ' at ' +
      (names.length > 2 ? names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' more' : names.join(' and '))
    : 'jobDo: a favourite-companies check ran into trouble';
  const when = 'Checked ' + moment(result.at, tz);

  const rows = added.map((a) => ({ ...a, site: '', score: typeof a.score === 'number' ? a.score : undefined }));
  const sections = [
    { title: 'Added to your job list', note: 'The extension applies to these on its next run, before it searches the job boards.', rows, tone: C.good }
  ].filter((s) => s.rows.length);
  const tiles = [
    ['Companies checked', result.companies.length - failed.length, C.accent],
    ['New postings', result.companies.reduce((n, c) => n + (c.fresh || 0), 0), C.text],
    ['Ranked', result.ranked || 0, C.text],
    ['Added', added.length, C.good]
  ];
  const problems = [
    ...failed.map((c) => c.name + ': ' + c.error),
    ...(result.error ? [result.error] : [])
  ];
  return {
    subject,
    html: page(headline, when, tiles, sections,
      problems.length ? 'Could not finish: ' + problems.join('; ') + '.' : '',
      'You get this email when a scheduled check finds new matches. Switch it off in Settings → Daily run, safety and pacing.',
      { href: config.webUrl + '/jobs/', label: 'Open your job list' }),
    text: [headline, when, '',
      ...sections.flatMap((s) => [s.title.toUpperCase() + ' (' + s.rows.length + ')', s.note,
        ...s.rows.slice(0, LIST_MAX).flatMap((r) => ['- ' + r.title + ' at ' + r.company, '  ' + (safeUrl(r.url) || '')]), '']),
      ...(problems.length ? ['Could not finish: ' + problems.join('; '), ''] : []),
      'Your job list: ' + config.webUrl + '/jobs/'].join('\n')
  };
}

// --------------------------------------------------------------------- html

function page(headline, when, tiles, sections, footnote, why, button) {
  const link = button || { href: config.webUrl + '/app/', label: 'Open the dashboard' };
  return `<!doctype html><html><body style="margin:0;padding:0;background:${C.page}">
<div style="background:${C.page};padding:24px 12px;font-family:${FONT};color:${C.text}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:${C.surface};border:1px solid ${C.line};border-radius:14px">
<tr><td style="padding:24px 28px 8px">
  <div style="font-size:14px;font-weight:700;color:${C.accent};letter-spacing:.2px">jobDo</div>
  <h1 style="font-size:22px;line-height:1.3;margin:14px 0 4px;font-weight:700">${esc(headline)}</h1>
  <p style="margin:0;color:${C.secondary};font-size:14px">${esc(when)}</p>
</td></tr>
<tr><td style="padding:16px 22px 4px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>
  ${tiles.map(([label, n, tone]) => `<td width="25%" style="background:${C.inset};border-radius:10px;padding:10px 12px;vertical-align:top">
    <div style="font-size:22px;font-weight:700;color:${n ? tone : C.muted}">${n}</div>
    <div style="font-size:12px;color:${C.secondary}">${esc(label)}</div></td>`).join('')}
  </tr></table>
</td></tr>
${sections.map(section).join('')}
<tr><td style="padding:12px 28px 4px">
  ${footnote ? `<p style="margin:0 0 16px;font-size:13px;color:${C.secondary}">${esc(footnote)}</p>` : ''}
  <a href="${esc(link.href)}" style="display:inline-block;background:${C.accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px">${esc(link.label)}</a>
</td></tr>
<tr><td style="padding:20px 28px 24px;font-size:12px;color:${C.muted}">${esc(why)}</td></tr>
</table></div></body></html>`;
}

function section({ title, note, rows, reason, tone }) {
  const shown = rows.slice(0, LIST_MAX);
  const more = rows.length - shown.length;
  return `<tr><td style="padding:18px 28px 0">
  <h2 style="font-size:15px;margin:0 0 4px;color:${tone || C.text}">${esc(title)} <span style="color:${C.muted};font-weight:400">${rows.length}</span></h2>
  ${note ? `<p style="margin:0 0 6px;font-size:13px;color:${C.secondary}">${esc(note)}</p>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  ${shown.map((r) => jobRow(r, reason)).join('')}
  </table>
  ${more > 0 ? `<p style="margin:8px 0 0;font-size:13px;color:${C.secondary}">and ${more} more on the dashboard.</p>` : ''}
</td></tr>`;
}

function jobRow(r, withReason) {
  const href = safeUrl(r.url);
  const title = esc(r.title || 'Untitled job');
  const meta = [r.company, SITE_NAMES[r.site] || r.site, r.location, typeof r.score === 'number' ? 'match ' + r.score : '']
    .filter(Boolean).map(esc).join(' · ');
  return `<tr><td style="padding:9px 0;border-top:1px solid ${C.line}">
    <div style="font-size:14px;font-weight:600">${href ? `<a href="${esc(href)}" style="color:${C.text};text-decoration:none">${title}</a>` : title}</div>
    <div style="font-size:13px;color:${C.secondary}">${meta}</div>
    ${withReason && r.reason ? `<div style="font-size:12px;color:${C.muted};margin-top:2px">${esc(cap(r.reason))}</div>` : ''}
  </td></tr>`;
}

// --------------------------------------------------------------------- text

function textVersion(headline, when, sections, counts) {
  const out = [headline, when, '',
    'Applied ' + counts.applied + (counts.dryRun ? ' · ready to send ' + counts.dryRun : '') +
    ' · waiting on you ' + counts.needsYou + ' · did not go through ' + counts.failed + ' · skipped ' + counts.skipped, ''];
  for (const s of sections) {
    out.push(s.title.toUpperCase() + ' (' + s.rows.length + ')');
    if (s.note) out.push(s.note);
    for (const r of s.rows.slice(0, LIST_MAX)) {
      out.push('- ' + (r.title || 'Untitled job') + (r.company ? ' at ' + r.company : '') +
        (s.reason && r.reason ? ' (' + r.reason + ')' : ''));
      const href = safeUrl(r.url);
      if (href) out.push('  ' + href);
    }
    if (s.rows.length > LIST_MAX) out.push('  and ' + (s.rows.length - LIST_MAX) + ' more on the dashboard.');
    out.push('');
  }
  out.push('Dashboard: ' + config.webUrl + '/app/');
  return out.join('\n');
}

// ------------------------------------------------------------------ helpers

export const esc = (v) => String(v === undefined || v === null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Only web links: a record's URL came from a job page.
export const safeUrl = (u) => {
  const s = String(u || '').trim();
  return /^https?:\/\/[^\s]+$/i.test(s) && s.length <= 2000 ? s : '';
};

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

export function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function moment(ms, tz) {
  const zone = validZone(tz || 'UTC');
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  }).format(ms) + (zone === 'UTC' ? ' UTC' : '');
}

function span(from, to, tz) {
  const zone = validZone(tz || 'UTC');
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' });
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' });
  const sameDay = day.format(from) === day.format(to);
  return 'Run on ' + day.format(from) + ', ' + time.format(from) + '–' +
    (sameDay ? '' : day.format(to) + ', ') + time.format(to) + (zone === 'UTC' ? ' UTC' : '');
}
