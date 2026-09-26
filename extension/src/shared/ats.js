// Which applicant tracking system is behind a career-site URL, and how far we
// are willing to go on it.
//
//   auto     - a public, single-page form. We can fill it and submit it.
//   assisted - needs an account, a multi-step wizard, or both. We fill what we
//              can and hand the tab to you rather than guessing our way
//              through a signup flow.
//   unknown  - some company's own careers page. Treated as assisted unless you
//              explicitly allow submitting on unknown sites.

export const ATS_LIST = [
  { id: 'greenhouse', name: 'Greenhouse', host: /(^|\.)greenhouse\.io$/, mode: 'auto' },
  { id: 'lever', name: 'Lever', host: /(^|\.)lever\.co$/, mode: 'auto' },
  { id: 'ashby', name: 'Ashby', host: /(^|\.)ashbyhq\.com$/, mode: 'auto' },
  { id: 'workable', name: 'Workable', host: /(^|\.)workable\.com$/, mode: 'auto' },
  { id: 'smartrecruiters', name: 'SmartRecruiters', host: /(^|\.)smartrecruiters\.com$/, mode: 'auto' },
  { id: 'recruitee', name: 'Recruitee', host: /(^|\.)recruitee\.com$/, mode: 'auto' },
  { id: 'teamtailor', name: 'Teamtailor', host: /(^|\.)teamtailor\.com$/, mode: 'auto' },
  { id: 'bamboohr', name: 'BambooHR', host: /(^|\.)bamboohr\.(com|co\.uk)$/, mode: 'auto' },
  { id: 'jazzhr', name: 'JazzHR', host: /(^|\.)applytojob\.com$/, mode: 'auto' },
  { id: 'breezy', name: 'Breezy HR', host: /(^|\.)breezy\.hr$/, mode: 'auto' },
  { id: 'personio', name: 'Personio', host: /(^|\.)personio\.(de|com)$/, mode: 'auto' },
  { id: 'rippling', name: 'Rippling', host: /(^|\.)rippling(ats)?\.com$/, mode: 'auto' },

  // Where "Indeed Apply" actually happens. Assisted by default because Indeed
  // watches for automation harder than anywhere else; the Indeed site setting
  // can promote it to auto.
  { id: 'indeed-smartapply', name: 'Indeed Apply', host: /(^|\.)smartapply\.indeed\.com$/, mode: 'assisted' },

  { id: 'workday', name: 'Workday', host: /(^|\.)myworkdayjobs\.com$/, mode: 'assisted' },
  { id: 'icims', name: 'iCIMS', host: /(^|\.)icims\.com$/, mode: 'assisted' },
  { id: 'taleo', name: 'Taleo', host: /(^|\.)taleo\.net$/, mode: 'assisted' },
  { id: 'successfactors', name: 'SAP SuccessFactors', host: /(^|\.)successfactors\.(com|eu)$/, mode: 'assisted' },
  { id: 'brassring', name: 'Kenexa BrassRing', host: /(^|\.)brassring\.com$/, mode: 'assisted' },
  { id: 'avature', name: 'Avature', host: /(^|\.)avature\.net$/, mode: 'assisted' },
  { id: 'oracle', name: 'Oracle Recruiting', host: /(^|\.)oraclecloud\.com$/, mode: 'assisted' },
  { id: 'zoho', name: 'Zoho Recruit', host: /(^|\.)zohorecruit\.(com|in|eu)$/, mode: 'assisted' },
  { id: 'naukri', name: 'Naukri', host: /(^|\.)naukri\.com$/, mode: 'assisted' },
  { id: 'eightfold', name: 'Eightfold', host: /(^|\.)eightfold\.ai$/, mode: 'assisted' }
];

// Declared in the manifest so the portal content scripts load without asking
// for access to the whole web. Unknown sites need the optional permission.
export const ATS_MATCHES = [
  'https://smartapply.indeed.com/*',
  'https://*.greenhouse.io/*',
  'https://*.lever.co/*',
  'https://*.ashbyhq.com/*',
  'https://*.workable.com/*',
  'https://*.smartrecruiters.com/*',
  'https://*.recruitee.com/*',
  'https://*.teamtailor.com/*',
  'https://*.bamboohr.com/*',
  'https://*.applytojob.com/*',
  'https://*.breezy.hr/*',
  'https://*.personio.de/*',
  'https://*.personio.com/*',
  'https://*.rippling.com/*',
  'https://*.myworkdayjobs.com/*',
  'https://*.icims.com/*',
  'https://*.taleo.net/*',
  'https://*.successfactors.com/*',
  'https://*.brassring.com/*',
  'https://*.avature.net/*',
  'https://*.zohorecruit.com/*',
  'https://*.eightfold.ai/*'
];

// The optional permission that lets the extension work on career sites it does
// not recognise. Chrome only grants it from a click on an extension page.
export const ANY_SITE = { origins: ['https://*/*'] };

export function detectAts(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* not a url */ }
  for (const a of ATS_LIST) {
    if (a.host.test(host)) return { id: a.id, name: a.name, mode: a.mode, host };
  }
  return { id: 'unknown', name: host || 'unknown site', mode: 'unknown', host };
}

// LinkedIn bounces external applies through its own redirector; the real
// destination only shows up after that hop resolves.
export function isLinkedInRedirect(url) {
  return /^https:\/\/(www\.)?linkedin\.com\/(jobs\/view\/externalApply|redir|safety\/go)/.test(url || '');
}
