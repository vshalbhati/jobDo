// Pulls plain text out of a resume file. PDF goes through the bundled pdf.js
// (no remote code - MV3 forbids it); DOCX is unzipped with the platform's own
// DecompressionStream, so there is no third-party zip library either.

export async function extractText(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return extractPdf(file);
  if (name.endsWith('.docx')) return extractDocx(file);
  if (name.endsWith('.doc')) throw new Error('Old .doc files are not supported - save as PDF or .docx.');
  return file.text();
}

async function extractPdf(file) {
  const pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('src/vendor/pdf.worker.min.mjs');
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Rebuild lines from item positions; a naive join loses every line break,
    // which is what the name/title heuristics rely on.
    let line = [];
    let lastY = null;
    const out = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) { out.push(line.join('')); line = []; }
      line.push(item.str + (item.hasEOL ? '\n' : ''));
      lastY = y;
    }
    out.push(line.join(''));
    pages.push(out.join('\n'));
  }
  await doc.destroy();
  return pages.join('\n\n').replace(/\n{3,}/g, '\n\n');
}

async function extractDocx(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const xml = await readZipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('That .docx has no word/document.xml inside it.');
  const text = new TextDecoder().decode(xml);
  return text
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- just enough of the ZIP format to find one file -------------------------

async function readZipEntry(buf, wantName) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = findSignature(dv, 0x06054b50);
  if (eocd < 0) throw new Error('Not a valid .docx (no zip directory).');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));

    if (name === wantName) {
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) return raw;
      if (method === 8) return inflateRaw(raw);
      throw new Error('Unsupported zip compression method ' + method + '.');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function findSignature(dv, sig) {
  for (let i = dv.byteLength - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === sig) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
