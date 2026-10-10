// Family Contact Form -> PDF. Pure functions, no I/O, no dependencies: built-in
// Helvetica, WinAnsi bytes, hand-written xref. Shared by submit.js (render) and
// family-forms.js (path parsing); unit-tested by test/pdf.test.js. The leading
// underscore keeps Vercel from deploying this file as its own function.
//
// ponytail: Latin-1 only (anything else prints "?"; the original text stays in the
// GHL note and the email) and no logo (the logo is WebP, PDF can't embed it
// without a decoder). Add an embedded TTF + PNG logo if either ever matters.

const W = 612, H = 792, M = 54; // US Letter, 0.75in margins
const LABEL_W = 150;
const LEAD = 14;

const PURPLE = [0.357, 0.173, 0.557]; // #5B2C8E
const GOLD = [0.788, 0.588, 0.169];   // #C9962B
const INK = [0.106, 0.071, 0.188];    // #1B1230
const SLATE = [0.290, 0.267, 0.345];  // #4A4458
const MIST = [0.929, 0.894, 0.961];   // #EDE4F5
const CREAM = [1, 0.980, 0.949];      // #FFFAF2
const WHITE = [1, 1, 1];

// Helvetica advance widths (1/1000 em) for ASCII 32..126, used only to wrap text.
const HW = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
// Typographic punctuation -> its WinAnsi byte (everything else > 255 becomes "?").
const WIN = {
  '‘': '\x91', '’': '\x92', '“': '\x93', '”': '\x94',
  '–': '\x96', '—': '\x97', '…': '\x85', '•': '\x95',
  ' ': ' ', ' ': ' ', ' ': ' ',
};
const WIN_BYTES = new Set(Object.values(WIN)); // enc() runs twice (wrap, then text): its own output must pass through
const WIDE = { '\x85': 1000, '\x91': 222, '\x92': 222, '\x93': 333, '\x94': 333, '\x95': 350, '\x96': 556, '\x97': 1000 };

// Any string -> a Latin-1 string safe to drop into a PDF literal. Newlines survive
// (the wrapper splits on them), every other control character becomes a space.
function enc(s) {
  let out = '';
  for (const ch of String(s == null ? '' : s).normalize('NFC')) {
    const c = ch.codePointAt(0);
    if (c === 10) out += '\n';
    else if (c === 13) continue;
    else if (c < 32 || c === 127) out += ' ';
    else if (c <= 126 || (c >= 161 && c <= 255)) out += ch;
    else out += WIN_BYTES.has(ch) ? ch : (WIN[ch] || '?');
  }
  return out;
}

const cw = (ch) => {
  const c = ch.charCodeAt(0);
  return c >= 32 && c <= 126 ? HW[c - 32] : (WIDE[ch] || 556);
};
const tw = (s, size) => { let n = 0; for (const ch of s) n += cw(ch); return n * size / 1000; };
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (c) => c.map((v) => num(v)).join(' ');

// Greedy wrap to maxW points; hard-breaks a single word that is wider than the line.
function wrap(text, size, maxW) {
  const lines = [];
  for (const para of enc(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      let w = word;
      while (tw(w, size) > maxW) { // a word wider than the column (a long email, a URL)
        let cut = 1;
        while (cut < w.length && tw(w.slice(0, cut + 1), size) <= maxW) cut++;
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const next = line ? line + ' ' + w : w;
      if (line && tw(next, size) > maxW) { lines.push(line); line = w; } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

const etDate = (d) => enc(d.toLocaleString('en-US', {
  timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short',
}));

// b = the validated form body from submit.js. opts: { brandName, locLabel, at, ref, source? }.
function renderFamilyPdf(b, opts) {
  const { brandName, locLabel, at, ref } = opts;
  const pages = [];
  let ops = null;
  let y = 0;

  const newPage = (first) => {
    ops = [];
    pages.push(ops);
    if (first) {
      ops.push(`${rgb(PURPLE)} rg 0 ${H - 92} ${W} 92 re f`);
      ops.push(`${rgb(GOLD)} rg 0 ${H - 96} ${W} 4 re f`);
      text(M, H - 36, 'EXISTING FAMILY', 9, true, GOLD);
      text(M, H - 62, 'Family Contact Form', 24, true, WHITE);
      text(M, H - 80, brandName, 11, false, WHITE);
      y = H - 96 - 26;
    } else {
      text(M, H - 40, `Family Contact Form  -  ${b.studentName}  (continued)`, 9, false, SLATE);
      y = H - 40 - 22;
    }
  };
  function text(x, yy, s, size, bold, color) {
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg ${num(x)} ${num(yy)} Td (${esc(enc(s).replace(/\n/g, ' '))}) Tj ET`);
  }
  const need = (h) => { if (y - h < 64) newPage(false); };

  const heading = (title) => {
    need(46);
    y -= 12;
    text(M, y, title.toUpperCase(), 9, true, PURPLE);
    y -= 6;
    ops.push(`${rgb(MIST)} rg ${M} ${num(y)} ${W - 2 * M} 1.2 re f`);
    y -= 16;
  };
  const rowLines = (value) => wrap(value || '-', 10.5, W - 2 * M - LABEL_W);
  const row = (label, value) => {
    const lines = rowLines(value);
    need(lines.length * LEAD + 4);
    text(M, y, label, 10, true, INK);
    lines.forEach((ln, i) => text(M + LABEL_W, y - i * LEAD, ln, 10.5, false, SLATE));
    y -= lines.length * LEAD + 4;
  };

  newPage(true);

  // Meta block under the header.
  const stamp = etDate(at);
  text(M, y, 'Submitted', 10, true, INK);
  text(M + LABEL_W, y, `${stamp} ET`, 10.5, false, SLATE);
  y -= LEAD + 4;
  row('Location', locLabel);
  if (ref) row('Reference', ref);
  if (opts.source) row('Source', opts.source); // backfill: says the PDF was rebuilt from the CRM note

  heading('Child');
  row('Name', b.studentName);
  row('Date of birth', b.studentDob);
  row('Age', b.studentAge);

  heading('Parent / Guardian');
  row('Name', b.parentName);
  row('Mobile (SMS)', b.parentPhone);
  row('Email', b.parentEmail);
  row('Relationship', b.parentRelationship);
  row('SMS consent', b.smsConsent === 'yes' ? 'Yes' : 'No');

  // Emergency contact is the point of this document: boxed so it is the first thing seen.
  const emerg = [['Name', b.emergencyName], ['Phone', b.emergencyPhone], ['Relationship', b.emergencyRelationship]];
  const boxH = 14 + 18 + emerg.reduce((n, [, v]) => n + rowLines(v).length * LEAD + 4, 0);
  need(boxH + 24);
  y -= 12;
  ops.push(`${rgb(CREAM)} rg ${M - 10} ${num(y - boxH + 14)} ${W - 2 * M + 20} ${num(boxH)} re f`);
  ops.push(`${rgb(GOLD)} rg ${M - 10} ${num(y - boxH + 14)} 4 ${num(boxH)} re f`);
  text(M, y, 'EMERGENCY CONTACT', 9, true, PURPLE);
  y -= 22;
  emerg.forEach(([l, v]) => row(l, v));
  y -= 6;

  const people = (Array.isArray(b.people) ? b.people : []).filter((p) => p && (p.name || p.phone));
  if (people.length) {
    heading('Other authorized people');
    people.forEach((p, i) => row(`Person ${i + 1}`,
      [p.name, p.relationship ? `(${p.relationship})` : '', p.phone ? `- ${p.phone}` : ''].filter(Boolean).join(' ')));
  }
  if (b.shirtSize || b.pantsSize) {
    heading('Uniform sizes');
    row('Shirt', b.shirtSize);
    row('Pants', b.pantsSize);
  }
  if (b.notes) {
    heading('Additional notes');
    for (const ln of wrap(b.notes, 10.5, W - 2 * M)) {
      need(LEAD + 2);
      text(M, y, ln, 10.5, false, SLATE);
      y -= LEAD;
    }
  }

  // Footer + page numbers (second pass: total is known now).
  const total = pages.length;
  pages.forEach((p, i) => {
    ops = p;
    ops.push(`${rgb(MIST)} rg ${M} 52 ${W - 2 * M} 1 re f`);
    text(M, 38, `${brandName}  -  Confidential: contains children's personal information.`, 8, false, SLATE);
    const pg = `Page ${i + 1} of ${total}`;
    text(W - M - tw(pg, 8), 38, pg, 8, false, SLATE);
  });

  return assemble(pages, `Family Contact Form - ${b.studentName}`, at);
}

// Objects: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 info, then
// (content, page) pairs from 6. Offsets are byte offsets (string is all Latin-1).
function assemble(pages, title, at) {
  const objs = {};
  const kids = pages.map((_, i) => `${7 + 2 * i} 0 R`);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  const d = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  objs[5] = `<< /Title (${esc(enc(title).replace(/\n/g, ' '))}) /Producer (A Touch of Blessings forms) /CreationDate (D:${d}) >>`;
  pages.forEach((ops, i) => {
    const content = ops.join('\n');
    objs[6 + 2 * i] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    objs[7 + 2 * i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`;
  });
  const n = 5 + 2 * pages.length;
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offs = [];
  for (let i = 1; i <= n; i++) { offs[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= n; i++) out += `${String(offs[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${n + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ── Blob pathnames ────────────────────────────────────────────────────────────
// The list endpoint reads everything it shows out of the pathname, so there is no
// second index to keep in sync:
//   family-forms/<atob|amt>/<YYYY-MM>/<YYYYMMDDTHHMMSSZ>__<contactId>__<child>__<parent>.pdf
const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'unknown';

function pdfPath({ brandKey, at, contactId, child, parent }) {
  const iso = at.toISOString();
  const stamp = iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `family-forms/${brandKey}/${iso.slice(0, 7)}/${stamp}__${slug(contactId)}__${slug(child)}__${slug(parent)}.pdf`;
}

const PATH_RE = /^family-forms\/(atob|amt)\/(\d{4}-\d{2})\/(\d{8}T\d{6}Z)__([A-Za-z0-9]+)__([A-Za-z0-9_]+)__([A-Za-z0-9_]+)\.pdf$/;

function parsePath(p) {
  const m = PATH_RE.exec(String(p || ''));
  if (!m) return null;
  const [, brand, , s, contactId, child, parent] = m;
  const submittedAt = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  return { path: p, brand, submittedAt, contactId, child: child.replace(/_/g, ' '), parent: parent.replace(/_/g, ' ') };
}

module.exports = { renderFamilyPdf, pdfPath, parsePath, slug, enc, wrap };
