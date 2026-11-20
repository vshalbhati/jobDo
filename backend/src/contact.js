// Email addresses a job posting gives for applying ("send your CV to
// hr@acme.com"). Only these are ever mailed from the dashboard: someone who
// published an address for applications has asked to be written to.
//
// A copy lives in extension/src/shared/contact.js for the extension's own
// dashboard; keep the two the same.

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;

// Not people: automated senders, placeholders, and file names that look like
// addresses (logo@2x.png).
const NOT_A_PERSON = /(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster)([._-]|@)|@(example|domain|email|yourcompany|company)\.(com|org|net)$|\.(png|jpe?g|gif|svg|webp|pdf)$/i;

// "hr [at] acme [dot] com", "hr(at)acme(dot)com", "hr at acme dot com".
function unhide(text) {
  return String(text || '')
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@')
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, '.')
    .replace(/\b([a-z0-9._%+-]+)\s+at\s+([a-z0-9-]+)\s+dot\s+([a-z]{2,24})\b/gi, '$1@$2.$3');
}

export const MAX_CONTACTS = 3;

// Distinct, lower-cased, in the order the posting gives them.
export function emailsIn(text) {
  const out = [];
  for (const m of unhide(text).matchAll(EMAIL)) {
    const e = m[0].toLowerCase().replace(/\.+$/, '');
    if (NOT_A_PERSON.test(e) || out.includes(e)) continue;
    out.push(e);
    if (out.length === MAX_CONTACTS) break;
  }
  return out;
}

// Stored as one comma-separated column.
export const joinEmails = (list) => list.join(',');
export const splitEmails = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
