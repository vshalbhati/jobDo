// Job links out of a spreadsheet, read in the browser so the file never goes
// to a server: .xlsx (Excel, or Google Sheets and Numbers saved as .xlsx),
// .csv, or text with a link on each line. Columns are found by their
// headings when there are any ("Link", "Job title", "Company"); without
// headings, any cell holding a link will do.
import { readZipEntry } from '../settings/extract.js';
import { jobFromUrl } from '../shared/sites.js';

const MAX_ROWS = 5000;
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// -> rows of cells, each { text, link }: link is a hyperlink's target, if the
// cell has one.
export async function readSheet(file) {
  const name = (file.name || '').toLowerCase();
  if (/\.xls[xm]$/.test(name)) return readXlsx(new Uint8Array(await file.arrayBuffer()));
  if (/\.(xls|ods|numbers)$/.test(name)) {
    throw new Error('That kind of spreadsheet cannot be read here. Open it and save it as .xlsx or .csv.');
  }
  return readText(await file.text());
}

// Pasted text: a column copied out of Excel or Sheets arrives tab-separated.
export function readText(text) {
  const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // Just links: a comma inside one must not split it.
  if (lines.every(looksLikeLink)) return lines.slice(0, MAX_ROWS).map((l) => [{ text: l, link: '' }]);
  const firstLine = lines[0] || '';
  const count = (c) => firstLine.split(c).length - 1;
  const delim = ['\t', ',', ';'].sort((a, b) => count(b) - count(a))[0];
  return parseDelimited(String(text), count(delim) ? delim : '\u0000');
}

// --------------------------------------------------------------------- xlsx

async function readXlsx(buf) {
  const xml = async (path) => {
    const bytes = await readZipEntry(buf, path);
    return bytes ? new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml') : null;
  };
  const all = (doc, tag) => (doc ? [...doc.getElementsByTagNameNS('*', tag)] : []);
  const relsOf = async (path) => {
    const map = new Map();
    for (const r of all(await xml(path), 'Relationship')) map.set(r.getAttribute('Id'), r.getAttribute('Target'));
    return map;
  };
  const rid = (el) => el.getAttribute('r:id') || el.getAttributeNS(REL_NS, 'id');

  const workbook = await xml('xl/workbook.xml');
  if (!workbook) throw new Error('That .xlsx has no workbook inside it.');
  // The first sheet, wherever the workbook keeps it.
  const first = all(workbook, 'sheet')[0];
  const target = (first && (await relsOf('xl/_rels/workbook.xml.rels')).get(rid(first))) || 'worksheets/sheet1.xml';
  const sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  const sheet = await xml(sheetPath);
  if (!sheet) throw new Error('That .xlsx has no sheet inside it.');

  const strings = all(await xml('xl/sharedStrings.xml'), 'si')
    .map((si) => all(si, 't').filter((t) => t.parentNode.localName !== 'rPh').map((t) => t.textContent).join(''));

  // Links set with Insert → Link live apart from the cells, keyed by cell.
  const sheetRels = await relsOf(sheetPath.replace(/([^/]+)$/, '_rels/$1.rels'));
  const links = new Map();
  for (const h of all(sheet, 'hyperlink')) {
    const href = sheetRels.get(rid(h));
    if (!href) continue;
    for (const ref of cellsIn(h.getAttribute('ref') || '')) links.set(ref, href);
  }

  const rows = [];
  for (const row of all(sheet, 'row').slice(0, MAX_ROWS)) {
    const cells = [];
    for (const c of all(row, 'c')) {
      const ref = c.getAttribute('r') || '';
      const col = ref ? colIndex(ref) : cells.length;
      const type = c.getAttribute('t');
      const v = all(c, 'v')[0];
      const f = all(c, 'f')[0];
      let text = '';
      if (type === 's') text = strings[Number(v && v.textContent)] || '';
      else if (type === 'inlineStr') text = all(c, 't').map((t) => t.textContent).join('');
      else text = v ? v.textContent : '';
      // =HYPERLINK("https://...", "Apply")
      const formula = f && /HYPERLINK\(\s*"([^"]+)"/i.exec(f.textContent);
      cells[col] = { text: text.trim(), link: links.get(ref) || (formula ? formula[1] : '') };
    }
    rows.push(Array.from(cells, (c) => c || { text: '', link: '' }));
  }
  return rows;
}

// "B12" -> 1
function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// "A2:B3" -> A2 A3 B2 B3 (a link can cover several cells)
function cellsIn(range) {
  const [a, b] = range.split(':');
  if (!b) return [a];
  const m = (x) => /^([A-Z]+)(\d+)$/i.exec(x);
  const [, c1, r1] = m(a) || [];
  const [, c2, r2] = m(b) || [];
  if (!c1 || !c2) return [a];
  const out = [];
  for (let r = Number(r1); r <= Math.min(Number(r2), Number(r1) + MAX_ROWS); r++) {
    for (let c = colIndex(c1); c <= colIndex(c2); c++) out.push(colName(c) + r);
  }
  return out;
}

function colName(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// ---------------------------------------------------------------------- csv

function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < MAX_ROWS; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delim) {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((t) => ({ text: t.trim(), link: '' })));
}

// ------------------------------------------------------------ rows -> jobs

const HEADINGS = {
  url: /^(job\s*)?(url|link|links|apply\s*(link|url|here)?|application\s*(link|url)|posting(\s*(link|url))?|href|career\s*(page|link))$/i,
  title: /^(job\s*)?(title|role|position|designation|job|job\s*name|opening|post)$/i,
  company: /^(company|employer|organi[sz]ation|company\s*name|firm|brand)$/i,
  location: /^(location|city|place|job\s*location)$/i
};

const looksLikeLink = (s) => /^(https?:\/\/|www\.)\S+$/i.test(String(s || '').trim());
const asLink = (s) => {
  const t = String(s || '').trim();
  return looksLikeLink(t) ? (/^www\./i.test(t) ? 'https://' + t : t) : '';
};

// -> { jobs: [{ url, title, company, location }], noLink: rows with text but
//      no link, repeats: links that appeared more than once }
export function jobsFromRows(rows) {
  const filled = rows.filter((r) => r.some((c) => c.text || c.link));
  if (!filled.length) return { jobs: [], noLink: 0, repeats: 0 };

  // A heading row names its columns and holds no links.
  const cols = {};
  const head = filled[0];
  if (!head.some((c) => c.link || looksLikeLink(c.text))) {
    head.forEach((c, i) => {
      for (const [key, re] of Object.entries(HEADINGS)) {
        if (cols[key] === undefined && re.test(c.text.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim())) cols[key] = i;
      }
    });
  }
  const body = Object.keys(cols).length ? filled.slice(1) : filled;

  const jobs = [];
  const seen = new Set();
  let noLink = 0;
  let repeats = 0;
  for (const row of body) {
    const at = (key) => (cols[key] !== undefined && row[cols[key]]) || { text: '', link: '' };
    let url = asLink(at('url').link) || asLink(at('url').text);
    let linkCell = url ? at('url') : null;
    if (!url) {
      linkCell = row.find((c) => asLink(c.link) || asLink(c.text)) || null;
      url = linkCell ? asLink(linkCell.link) || asLink(linkCell.text) : '';
    }
    const job = url ? jobFromUrl(url) : null;
    if (!job) { noLink++; continue; }
    if (seen.has(job.url)) { repeats++; continue; }
    seen.add(job.url);
    // A link set on a job's name ("Senior Engineer" -> the posting) names it.
    const named = linkCell && linkCell.link && !looksLikeLink(linkCell.text) ? linkCell.text : '';
    jobs.push({
      url: job.url,
      title: (at('title').text || named).slice(0, 300),
      company: at('company').text.slice(0, 200),
      location: at('location').text.slice(0, 200)
    });
  }
  return { jobs, noLink, repeats };
}
