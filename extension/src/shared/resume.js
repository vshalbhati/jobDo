// Turns raw resume text into a structured profile. Deliberately conservative:
// everything it guesses is editable on the Options page, and the Options page
// shows exactly what it found so you can correct it before the first run.

export const SKILL_DICTIONARY = [
  // languages
  'javascript', 'typescript', 'python', 'java', 'kotlin', 'scala', 'go', 'golang', 'rust', 'c++', 'c#',
  '.net', 'php', 'ruby', 'swift', 'objective-c', 'perl', 'r', 'matlab', 'dart', 'elixir', 'haskell',
  'sql', 'plsql', 'pl/sql', 't-sql', 'bash', 'shell scripting', 'powershell', 'vba', 'cobol', 'abap',
  // web / frontend
  'react', 'react native', 'next.js', 'angular', 'angularjs', 'vue', 'vue.js', 'nuxt', 'svelte',
  'redux', 'jquery', 'html', 'css', 'sass', 'scss', 'tailwind', 'bootstrap', 'webpack', 'vite',
  'graphql', 'rest api', 'websocket', 'accessibility', 'responsive design',
  // backend / frameworks
  'node.js', 'nodejs', 'express', 'nestjs', 'spring', 'spring boot', 'hibernate', 'jpa', 'micronaut',
  'django', 'flask', 'fastapi', 'rails', 'laravel', 'asp.net', 'grpc', 'microservices', 'kafka',
  'rabbitmq', 'activemq', 'redis', 'elasticsearch', 'solr', 'celery', 'airflow',
  // data
  'postgresql', 'postgres', 'mysql', 'oracle', 'sql server', 'mongodb', 'cassandra', 'dynamodb',
  'snowflake', 'redshift', 'bigquery', 'databricks', 'spark', 'pyspark', 'hadoop', 'hive', 'etl',
  'data warehouse', 'data modeling', 'dbt', 'tableau', 'power bi', 'looker', 'qlik', 'excel',
  'pandas', 'numpy', 'scikit-learn', 'tensorflow', 'pytorch', 'keras', 'nlp', 'computer vision',
  'machine learning', 'deep learning', 'data science', 'statistics', 'a/b testing', 'llm',
  'generative ai', 'langchain', 'rag', 'prompt engineering', 'mlops',
  // cloud / infra
  'aws', 'azure', 'gcp', 'google cloud', 'docker', 'kubernetes', 'openshift', 'terraform', 'ansible',
  'puppet', 'chef', 'jenkins', 'github actions', 'gitlab ci', 'circleci', 'argocd', 'helm',
  'ci/cd', 'devops', 'sre', 'linux', 'unix', 'windows server', 'nginx', 'apache', 'kafka connect',
  'lambda', 'ec2', 's3', 'cloudformation', 'datadog', 'splunk', 'grafana', 'prometheus', 'new relic',
  // security
  'cybersecurity', 'penetration testing', 'owasp', 'iam', 'oauth', 'saml', 'sso', 'encryption',
  'siem', 'soc', 'vulnerability management', 'compliance', 'gdpr', 'pci dss', 'iso 27001',
  // qa
  'selenium', 'cypress', 'playwright', 'jest', 'junit', 'testng', 'pytest', 'cucumber', 'appium',
  'automation testing', 'manual testing', 'performance testing', 'jmeter', 'postman', 'api testing',
  // mobile
  'android', 'ios', 'flutter', 'xamarin', 'jetpack compose', 'swiftui',
  // product / business / ops
  'agile', 'scrum', 'kanban', 'jira', 'confluence', 'product management', 'roadmap', 'stakeholder management',
  'business analysis', 'requirements gathering', 'user stories', 'ux', 'ui design', 'figma', 'sketch',
  'adobe xd', 'wireframing', 'user research', 'salesforce', 'sap', 'servicenow', 'workday',
  'project management', 'pmp', 'budgeting', 'forecasting', 'financial modeling', 'accounting',
  'digital marketing', 'seo', 'sem', 'google analytics', 'content strategy', 'crm', 'hubspot',
  'customer success', 'account management', 'recruiting', 'onboarding', 'payroll', 'hris',
  'supply chain', 'logistics', 'six sigma', 'lean', 'process improvement', 'risk management',
  'kyc', 'aml', 'sanctions screening', 'fraud detection', 'trade finance', 'payments'
];

const TITLE_NOUNS = [
  'engineer', 'developer', 'programmer', 'architect', 'analyst', 'scientist', 'manager', 'lead',
  'consultant', 'administrator', 'specialist', 'designer', 'director', 'associate', 'executive',
  'officer', 'accountant', 'recruiter', 'strategist', 'technician', 'coordinator', 'representative',
  'intern', 'researcher', 'marketer', 'writer', 'editor', 'trainer', 'advisor', 'auditor'
];

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';

export function parseResumeText(text) {
  const raw = String(text || '');
  const clean = raw.replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const lower = clean.toLowerCase();
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);

  const email = (clean.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/) || [''])[0];
  const phone = guessPhone(clean);
  const linkedin = firstUrl(clean, /(?:https?:\/\/)?(?:[\w]+\.)?linkedin\.com\/in\/[\w%-]+/i);
  const github = firstUrl(clean, /(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+/i);
  const website = firstUrl(clean, /https?:\/\/(?!.*(?:linkedin|github)\.com)[\w.-]+\.[a-z]{2,}(?:\/\S*)?/i);

  const { firstName, lastName } = guessName(lines, email);
  const { city, country } = guessLocation(lines);

  const totalYears = estimateYears(lower, lines);
  const skillNames = SKILL_DICTIONARY.filter((s) => hasTerm(lower, s));
  const skills = {};
  for (const s of skillNames) skills[s] = totalYears || 1;

  const titles = guessTitles(lines);

  return {
    firstName, lastName, email, phone, city, country,
    linkedin: linkedin ? ensureHttps(linkedin) : '',
    github: github ? ensureHttps(github) : '',
    website: website || '',
    defaultYears: totalYears || 2,
    currentTitle: titles[0] || '',
    titles,
    skills
  };
}

// Keywords for the LinkedIn search box: the strongest title plus a couple of
// its most distinctive skills, which is roughly how a person would search.
export function searchKeywordsFrom(profile) {
  const title = (profile.titles && profile.titles[0]) || '';
  const skills = Object.keys(profile.skills || {});
  const top = skills.slice(0, 2);
  return [title, ...top].filter(Boolean).join(' ').trim();
}

// Phone numbers are written a dozen different ways, so rather than one rigid
// pattern this collects every digit-ish run and validates by digit count. The
// count is also what keeps date ranges like "2018 - 2021" out.
function guessPhone(clean) {
  const candidates = clean.match(/[+(]?\d[\d\s().-]{7,18}\d/g) || [];
  for (const raw of candidates) {
    const c = raw.trim();
    if (/^(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}$/.test(c)) continue;  // a date range
    const digits = c.replace(/\D/g, '');
    if (digits.length > 15) continue;
    if (digits.length >= 10) return c;
    if (c.startsWith('+') && digits.length >= 8) return c;
  }
  return '';
}

function firstUrl(text, re) {
  const m = text.match(re);
  return m ? m[0].replace(/[).,;]+$/, '') : '';
}

function ensureHttps(u) {
  return /^https?:\/\//i.test(u) ? u : 'https://' + u;
}

export function hasTerm(haystackLower, term) {
  const t = term.toLowerCase();
  // Terms with regex-significant characters (c++, .net, node.js) can't use \b.
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundaryLeft = /^[a-z0-9]/.test(t) ? '(?<![a-z0-9+#.])' : '(?<![a-z0-9])';
  const boundaryRight = /[a-z0-9]$/.test(t) ? '(?![a-z0-9+#])' : '(?![a-z0-9])';
  try {
    return new RegExp(boundaryLeft + esc + boundaryRight, 'i').test(haystackLower);
  } catch {
    return haystackLower.includes(t);
  }
}

function guessName(lines, email) {
  for (const line of lines.slice(0, 6)) {
    const t = line.replace(/[^A-Za-z '.-]/g, ' ').trim();
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) continue;
    if (/resume|curriculum|vitae|profile|summary/i.test(t)) continue;
    const looksLikeName = words.every((w) => /^[A-Z][a-z'.-]*$/.test(w) || /^[A-Z.]{1,3}$/.test(w));
    if (looksLikeName) {
      return { firstName: words[0], lastName: words[words.length - 1] };
    }
  }
  // Fall back to the local part of the email: vishal.bhati@... -> Vishal Bhati
  const local = (email.split('@')[0] || '').split(/[._-]/).filter((p) => /^[a-z]{2,}$/i.test(p));
  return {
    firstName: cap(local[0] || ''),
    lastName: cap(local[1] || '')
  };
}

function guessLocation(lines) {
  const re = /([A-Z][a-zA-Z.-]+(?:\s[A-Z][a-zA-Z.-]+)?)\s*,\s*([A-Z][a-zA-Z.-]+(?:\s[A-Z][a-zA-Z.-]+)?)/;
  for (const line of lines.slice(0, 12)) {
    if (line.length > 80) continue;
    const m = line.match(re);
    if (m) return { city: m[1], country: m[2] };
  }
  return { city: '', country: '' };
}

function guessTitles(lines) {
  const found = [];
  for (const line of lines) {
    if (line.length > 70) continue;
    const l = line.toLowerCase();
    if (!TITLE_NOUNS.some((n) => l.includes(n))) continue;
    const t = line.replace(/[|•·,].*$/, '').replace(/\s*[-–—]\s*.*(present|\d{4}).*$/i, '').trim();
    if (t.length < 4 || t.length > 60) continue;
    if (/@|http|\d{4}/.test(t)) continue;
    const norm = t.replace(/\s+/g, ' ');
    if (!found.some((f) => f.toLowerCase() === norm.toLowerCase())) found.push(norm);
    if (found.length >= 6) break;
  }
  return found;
}

// Headings are matched whole, not by prefix: "Experience with Kafka" is a
// bullet, "EXPERIENCE" is a heading, and prefix matching can't tell them apart.
const EXPERIENCE_HEADS = new Set([
  'experience', 'work experience', 'professional experience', 'working experience',
  'employment', 'employment history', 'work history', 'career history',
  'relevant experience', 'industry experience', 'professional background',
  'professional experience and projects', 'experience summary'
]);

const OTHER_HEADS = new Set([
  'education', 'educational qualifications', 'educational qualification', 'academic qualifications',
  'academic background', 'academics', 'qualifications', 'skills', 'technical skills',
  'core competencies', 'competencies', 'projects', 'project', 'personal projects',
  'academic projects', 'key projects', 'certifications', 'certification', 'courses',
  'coursework', 'training', 'awards', 'honors', 'publications', 'achievements',
  'accomplishments', 'interests', 'hobbies', 'languages', 'references', 'summary',
  'professional summary', 'objective', 'career objective', 'profile', 'about me',
  'volunteer experience', 'volunteering', 'extracurricular', 'activities',
  'additional information', 'personal details', 'declaration'
]);

// Lines about a degree carry dates that are not employment.
const EDU_HINT = /\b(b\.?\s?tech|b\.?\s?e\b|b\.?\s?sc|b\.?\s?com|b\.?\s?a\b|bachelor|master|m\.?\s?tech|m\.?\s?sc|m\.?\s?com|mba|ph\.?\s?d|doctorate|diploma|university|college|institute of technology|high school|senior secondary|cgpa|gpa|percentage|12th|10th|\bxii\b|\bintermediate\b)/i;

function headingKey(line) {
  const k = line.replace(/[^a-z& ]/gi, ' ').replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  return k.length <= 45 ? k : '';
}

// Keeps only the lines under an employment heading. If the resume has no such
// heading, every line survives except the obviously educational ones.
function employmentLines(lines) {
  let sawExperienceHead = false;
  let inExperience = false;
  const kept = [];
  for (const line of lines) {
    const key = headingKey(line);
    if (key && EXPERIENCE_HEADS.has(key)) { sawExperienceHead = true; inExperience = true; continue; }
    if (key && OTHER_HEADS.has(key)) { inExperience = false; continue; }
    if (inExperience) kept.push(line);
  }
  const pool = sawExperienceHead ? kept : lines;
  return pool.filter((l) => !EDU_HINT.test(l));
}

// Someone who writes "2 years of experience" has told us the answer; trust it
// over anything inferred from dates.
function statedYears(lower) {
  const forms = [
    /(\d{1,2})(?:\.\d)?\s*\+?\s*(?:years?|yrs?)\b[^.\n]{0,24}\bexperience\b/,
    /\bexperience\b[^.\n]{0,24}?(\d{1,2})(?:\.\d)?\s*\+?\s*(?:years?|yrs?)\b/
  ];
  for (const re of forms) {
    const m = lower.match(re);
    if (m) {
      const n = +m[1];
      if (n >= 0 && n <= 45) return n;
    }
  }
  return null;
}

// Union of employment date ranges, so overlapping roles aren't double counted.
function estimateYears(lower, lines) {
  const stated = statedYears(lower);
  if (stated !== null) return stated;

  const scope = employmentLines(lines).join('\n').toLowerCase();
  const re = new RegExp(
    '(?:(' + MONTHS + ')[a-z]*\\.?\\s*)?(\\d{4})\\s*(?:-|–|—|to|until)\\s*(?:(present|current|now|till date)|(?:(' + MONTHS + ')[a-z]*\\.?\\s*)?(\\d{4}))',
    'gi'
  );
  const now = new Date();
  const spans = [];
  let m;
  while ((m = re.exec(scope))) {
    const startY = +m[2];
    if (startY < 1970 || startY > now.getFullYear()) continue;
    const start = startY * 12 + monthIndex(m[1]);
    const end = m[3]
      ? now.getFullYear() * 12 + now.getMonth()
      : (+m[5]) * 12 + monthIndex(m[4]);
    if (!Number.isFinite(end) || end < start) continue;
    spans.push([start, end]);
  }
  if (!spans.length) return 0;
  spans.sort((a, b) => a[0] - b[0]);
  let months = 0, cursor = -Infinity;
  for (const [s, e] of spans) {
    const from = Math.max(s, cursor);
    if (e > from) { months += e - from; cursor = e; }
  }
  return Math.max(0, Math.round(months / 12));
}

function monthIndex(name) {
  if (!name) return 0;
  const i = ('jan feb mar apr may jun jul aug sep oct nov dec').split(' ')
    .indexOf(name.slice(0, 3).toLowerCase());
  return i < 0 ? 0 : i;
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
}
