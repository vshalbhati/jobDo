// Central schema + factory defaults. Everything the extension does is driven by
// this object, persisted under chrome.storage.local key "config".

export const STORAGE_KEY = 'config';
export const HISTORY_KEY = 'history';
export const LOG_KEY = 'log';
export const RUN_KEY = 'run';

// Questions LinkedIn asks over and over. First matching pattern wins, so order
// matters: put the narrow patterns above the broad ones.
const RAW_RULES = [
  { p: 'require (visa )?sponsorship|need sponsorship|sponsorship (now|in the future)|require.*work (visa|permit)', a: 'No' },
  { p: 'legally authorized|authorized to work|right to work|eligible to work', a: 'Yes' },
  { p: 'willing to relocate|open to relocation', a: 'Yes' },
  { p: 'comfortable commuting|able to commute|commute to (the )?office', a: 'Yes' },
  { p: 'comfortable working (in|with)? ?(a )?(remote|hybrid|onsite|on-site)', a: 'Yes' },
  { p: 'background check|background screening', a: 'Yes' },
  { p: 'drug (test|screen)', a: 'Yes' },
  { p: 'valid driver.?s? licen[cs]e', a: 'Yes' },
  { p: 'notice period|how (long|much) (is your )?notice', a: '30' },
  { p: 'when can you (start|join)|earliest start date|available to start', a: 'Immediately' },
  { p: 'expected (salary|ctc|compensation)|desired (salary|compensation)|salary expectation', a: '' },
  { p: 'current (salary|ctc|compensation)', a: '' },
  { p: 'how did you hear about', a: 'LinkedIn' },
  { p: 'highest level of education|education level', a: 'Bachelor’s Degree' },
  { p: '(bachelor.?s?|undergraduate) degree', a: 'Yes' },
  { p: 'english (proficiency|level)|proficient in english|speak english', a: 'Professional' },
  { p: 'hispanic or latino', a: 'No' },
  { p: 'protected veteran|veteran status', a: 'I am not a protected veteran' },
  { p: 'disability', a: 'I do not wish to answer' },
  { p: '\\bgender\\b', a: 'Decline to self identify' },
  // \b matters here: an unanchored "race" also matches "tracing", and an
  // unanchored "city" matches "capacity".
  { p: '\\brace\\b|ethnicity', a: 'Decline to self identify' },
  { p: 'linkedin (profile|url)', a: '' },
  { p: 'github', a: '' },
  { p: 'portfolio|personal website', a: '' },
  { p: '\\bcity\\b|current location|where are you (currently )?located', a: '' },
  { p: 'phone|mobile number', a: '' },
  { p: 'email', a: '' },
  { p: 'first name|given name', a: '' },
  { p: 'last name|surname|family name', a: '' },
  { p: 'full name', a: '' },
  // Catch-all: any "how many years ..." question falls back to defaultYears
  // unless the skill named in the question is found in the resume profile.
  { p: 'years? of (work |professional |industry )?experience|how many years', a: '' }
];

export const DEFAULT_RULES = RAW_RULES.map((r, i) => ({
  id: 'd' + i, pattern: r.p, answer: r.a, enabled: true, builtin: true
}));

export function defaultConfig() {
  return {
    version: 1,
    enabled: false,

    // Which job boards to work through. Each keeps its own per-run budget,
    // because they differ a lot in how fast and how reliable they are.
    sites: {
      linkedin: { enabled: true, maxPerRun: 20 },
      naukri: { enabled: false, maxPerRun: 15 },
      indeed: { enabled: false, maxPerRun: 10, domain: 'www.indeed.com', autoSubmit: false }
    },

    search: {
      keywords: '',            // blank = derived from the resume
      location: '',
      geoId: '',
      remote: [],              // '1' onsite, '2' remote, '3' hybrid
      datePosted: 'r604800',   // r86400 | r604800 | r2592000 | ''
      experience: [],          // '1'..'6'
      sortBy: 'DD',            // DD recent | R relevance
      extraQuery: ''
    },

    match: {
      // The ranking threshold. The copy that counts lives on your jobDo
      // account (so the web dashboard can change it); this is its local
      // cache, and the bar for the built-in scorer when the server is away.
      minScore: 60,
      titleInclude: [],
      titleExclude: ['director', 'vice president', 'intern', 'unpaid'],
      companyBlocklist: [],
      descriptionExclude: [],
      requireEasyApply: true
    },

    // Ranking: every run reads a larger pool of postings than it will apply
    // to, has the ranker on your server score each one, then applies to the
    // best first. Without a server connection it uses the built-in scorer.
    rank: {
      poolFactor: 3,     // read this many times as many jobs as the run can apply to
      maxPool: 150,      // but never more than this per board
      useServer: true
    },

    // One run a day on fresh postings - early applicants get seen first. If
    // Chrome is closed at that time it runs as soon as Chrome opens, the same day.
    schedule: {
      enabled: true,
      time: '14:00',     // local time, 24-hour
      lastRunDay: ''     // Date.toDateString() of the last day it started
    },

    safety: {
      dryRun: true,              // walk the whole flow but never press Submit
      reviewBeforeSubmit: false, // stop on the review step and wait for you
      maxPerRun: 20,
      maxPerDay: 50,
      minDelayMs: 25000,         // between applications
      maxDelayMs: 70000,
      actionMinMs: 500,          // between clicks/keystrokes inside a form
      actionMaxMs: 1600,
      longBreakEvery: 10,        // applications
      longBreakMinutes: 12,
      stopOnUnknownQuestion: true,
      skipIfDescriptionMissing: false
    },

    resume: {
      fileName: '',
      mime: '',
      dataUrl: '',      // base64 of the original file, for re-upload
      text: '',         // extracted plain text
      uploadedAt: 0,
      strategy: 'saved' // 'saved' = reuse a resume already on LinkedIn, 'upload' = push the file
    },

    profile: {
      firstName: '', lastName: '', email: '', phone: '',
      city: '', country: '',
      linkedin: '', github: '', website: '',
      defaultYears: 3,
      education: 'Bachelor’s Degree',
      expectedSalary: '',
      currentSalary: '',
      noticePeriodDays: 30,
      currentTitle: '',
      currentCompany: '',
      titles: [],
      skills: {}        // { skill: yearsOfExperience }
    },

    // Mode 2: applications that leave LinkedIn for the company's own site.
    portal: {
      enabled: false,
      submitUnknown: false,    // press Submit on sites we don't recognise
      closeTabWhenDone: true,  // close the career-site tab after a clean submit
      maxPerRun: 10,           // separate, smaller budget - portals are slow
      coverLetter: ''          // supports {{title}} {{company}} {{name}} {{years}} {{skills}}
    },

    // Optional: mirror history and resumes to your own server so they survive
    // an uninstall and can be read from any browser.
    sync: {
      enabled: false,
      serverUrl: '',
      webUrl: '',        // where the web dashboard is hosted
      email: '',
      token: '',
      refreshToken: '',
      expiresAt: 0,
      autoPush: true,
      lastPushAt: 0,
      lastError: '',
      pending: 0
    },

    answers: {
      rules: DEFAULT_RULES,
      unknownAsk: true  // record unseen questions instead of guessing at them
    },

    stats: { day: '', appliedToday: 0 }
  };
}
