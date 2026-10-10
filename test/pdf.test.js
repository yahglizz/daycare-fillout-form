// node --test test/pdf.test.js — api/_pdf.js: structure, escaping, pagination, paths
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderFamilyPdf, pdfPath, parsePath, slug, enc } = require('../api/_pdf');

const AT = new Date('2026-10-09T18:32:05.000Z');
const base = {
  studentName: 'Maria Lopez', studentDob: '2022-03-04', studentAge: '4',
  parentName: 'Ana Lopez', parentPhone: '(215) 555-0147', parentEmail: 'ana@example.org',
  parentRelationship: 'Mother', smsConsent: 'yes',
  emergencyName: 'Carlos Lopez', emergencyPhone: '215-555-0199', emergencyRelationship: 'Uncle',
  shirtSize: '4T', pantsSize: '4T', people: [{ name: 'Rosa Diaz', relationship: 'Aunt', phone: '215-555-0111' }], notes: '',
};
const render = (b = base) => renderFamilyPdf(b, { brandName: 'A Touch of Blessings', locLabel: '921 N 18th St.', at: AT, ref: 'abc123' });

// Every xref entry must point at "<n> 0 obj", startxref at "xref" — what a PDF reader checks first.
function assertValid(buf) {
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4\n'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  const sx = +/startxref\n(\d+)\n%%EOF/.exec(s)[1];
  assert.equal(s.slice(sx, sx + 4), 'xref');
  const n = +/xref\n0 (\d+)\n/.exec(s.slice(sx))[1];
  const lines = s.slice(sx).split('\n').slice(3, 2 + n);
  lines.forEach((ln, i) => assert.equal(s.slice(+ln.slice(0, 10), +ln.slice(0, 10) + String(i + 1).length + 6), `${i + 1} 0 obj`));
  // /Length must equal the real stream byte count
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) assert.equal(+m[1], m[2].length);
  return s;
}

test('valid single page with every field present', () => {
  const s = assertValid(render());
  for (const t of ['Maria Lopez', 'Ana Lopez', 'Carlos Lopez', 'Uncle', 'Rosa Diaz', 'EMERGENCY CONTACT', 'Page 1 of 1']) assert.ok(s.includes(t), t);
  assert.ok(!s.includes('?'), 'no replaced characters in a plain-ASCII form');
});

test('parentheses, backslashes, accents and smart quotes survive; other scripts become ?', () => {
  const s = assertValid(render({ ...base, studentName: 'Zoë (Zo) O’Brien \\ Jr', parentName: '王小明' }));
  assert.ok(s.includes('Zo\xEB \\(Zo\\) O\x92Brien \\\\ Jr'));
  assert.ok(s.includes('???'));
});

test('ICU narrow-no-break-space in the date never prints as ?', () => {
  assert.ok(!enc(AT.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' })).includes('?'));
});

test('long notes and 10 people paginate, with continuation header and page count', () => {
  const people = Array.from({ length: 10 }, (_, i) => ({ name: `Person ${i} ${'Long'.repeat(8)}`, relationship: 'Friend', phone: '215-555-0100' }));
  const s = assertValid(render({ ...base, people, notes: 'Allergic to peanuts. '.repeat(100) + '\n\n' + 'x'.repeat(300) }));
  const pages = (s.match(/\/Type \/Page /g) || []).length;
  assert.ok(pages >= 2, `expected >=2 pages, got ${pages}`);
  assert.ok(s.includes(`Page ${pages} of ${pages}`));
  assert.ok(s.includes('continued'));
});

test('blob path round-trips and carries only slug-safe characters', () => {
  const p = pdfPath({ brandKey: 'amt', at: AT, contactId: 'a1B2c3', child: "Mu'nir O’Neil", parent: 'Ana López' });
  assert.equal(p, 'family-forms/amt/2026-10/20261009T183205Z__a1B2c3__Mu_nir_O_Neil__Ana_Lopez.pdf');
  assert.deepEqual(parsePath(p), { path: p, brand: 'amt', submittedAt: '2026-10-09T18:32:05Z', contactId: 'a1B2c3', child: 'Mu nir O Neil', parent: 'Ana Lopez' });
  assert.equal(slug(''), 'unknown');
});

test('parsePath rejects anything that is not exactly what submit.js writes', () => {
  for (const bad of ['', null, '../secrets.pdf', 'family-forms/atob/2026-10/x.pdf', 'family-forms/xyz/2026-10/20261009T183205Z__a__b__c.pdf',
    'family-forms/atob/2026-10/20261009T183205Z__a__b__c.pdf/../../x', 'other/atob/2026-10/20261009T183205Z__a__b__c.pdf'])
    assert.equal(parsePath(bad), null, String(bad));
});

test('source line appears only when asked for (backfilled PDFs say where they came from)', () => {
  const plain = render().toString('latin1');
  const restored = renderFamilyPdf(base, { brandName: 'A Touch of Blessings', locLabel: 'x', at: AT, ref: 'abc', source: 'Rebuilt from the CRM intake note' }).toString('latin1');
  assert.ok(!plain.includes('Source'));
  assert.ok(restored.includes('Rebuilt from the CRM intake note'));
});

test('smart quotes and em dashes in BODY text survive (enc runs twice: wrap then text)', () => {
  const buf = renderFamilyPdf({ ...base, studentName: 'Lani\u2019Ali Grice', emergencyName: 'Nicole O\u2019Neil', notes: 'Pick up \u2014 not Fri\u2026' },
    { brandName: "A Mother\u2019s Touch Inc.", locLabel: "A Mother\u2019s Touch Inc. \u2014 1923 Cecil B. Moore Ave.", at: AT, ref: 'r' });
  const shown = [...buf.toString('latin1').matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]).join('\n');
  assert.ok(!shown.includes('?'), 'no replacement characters in any drawn text');
  assert.ok(shown.includes('Lani\x92Ali Grice') && shown.includes('Inc. \x97 1923') && shown.includes('Fri\x85'));
  assert.equal(enc(enc('\u2014\u2019\u201c')), '\x97\x92\x93', 'enc is idempotent');
});
