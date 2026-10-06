// node --test test/family.test.js — pure-logic checks for api/_family.js
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../api/_family');
const IDS = { childName: 'CN', childDob: 'CD', childAge: 'CA' };
const contact = (fields, tags = []) => ({ tags, customFields: Object.entries(fields).map(([id, value]) => ({ id, value })) });

test('ageYears: DOB wins, months and text parse, birthday boundary', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  assert.equal(f.ageYears('', '2023-10-06', now), 2);
  assert.equal(f.ageYears('', '2023-10-05', now), 3);
  assert.equal(f.ageYears('18 months', '', now), 1);
  assert.equal(f.ageYears('4 years', '', now), 4);
  assert.ok(Number.isNaN(f.ageYears('', '', now)));
  assert.equal(f.ageTag(0), 'age-infant');
  assert.equal(f.ageTag(13), '');
});

test('sameChild: case/punctuation-insensitive, first-name-only matches', () => {
  assert.ok(f.sameChild('Mu\'nir Smith', 'munir smith'));
  assert.ok(f.sameChild('Maria', 'Maria Lopez'));
  assert.ok(!f.sameChild('Maria Lopez', 'Maria Diaz'));
  assert.ok(!f.sameChild('Maria Lopez', 'Juan Lopez'));
});

test('sibling is appended, child 0 untouched; resubmit updates in place', () => {
  const c = contact({ CN: 'Maria Lopez', CD: '2022-01-01' });
  const start = f.parseChildren(c, IDS);
  assert.deepEqual(start, [{ name: 'Maria Lopez', dob: '2022-01-01', age: '' }]);
  const r = f.mergeChildren(start, { name: 'Juan Lopez', dob: '2024-05-05', loc: 'loc-921-n-18th' });
  assert.equal(r.index, 1); assert.ok(r.added);
  assert.equal(r.children[0].name, 'Maria Lopez'); assert.equal(r.children[0].dob, '2022-01-01');
  const again = f.mergeChildren(r.children, { name: 'maria lopez', dob: '', shirt: '3T' });
  assert.equal(again.index, 0); assert.ok(!again.added);
  assert.equal(again.children[0].dob, '2022-01-01', 'blank never erases');
  assert.equal(again.children[0].shirt, '3T');
  assert.equal(again.children[0].name, 'Maria Lopez', 'casing of a resubmit never replaces the stored name');
  assert.equal(f.mergeChildren([{ name: 'Maria' }], { name: 'Maria Lopez' }).children[0].name, 'Maria Lopez', 'a fuller name does');
});

test('children_json wins over the legacy comma list; bad JSON falls back', () => {
  const j = JSON.stringify([{ name: 'A B' }, { name: 'C B' }]);
  assert.equal(f.parseChildren(contact({ [f.F2.childrenJson]: j, CN: 'X' }), IDS).length, 2);
  assert.equal(f.parseChildren(contact({ [f.F2.childrenJson]: '{oops', CN: 'A B, C B' }), IDS).length, 2);
});

test('tags cover every child; stale removal never strips a sibling', () => {
  const kids = [
    { name: 'A', dob: '2022-01-01', group: 'Pre-K', loc: 'loc-921-n-18th', shirt: '4T' },
    { name: 'B', age: '1', group: 'Toddlers', loc: 'loc-2318-cecil-b-moore' },
  ];
  const tags = f.familyTags(kids, { smsConsent: 'yes', people: [{ name: 'Gran' }] });
  for (const t of ['loc-921-n-18th', 'loc-2318-cecil-b-moore', 'group-prek', 'group-toddlers', 'age-1',
    'multi-child', 'has-uniform-sizes', 'sms-consent', 'has-authorized-people', 'family-contact-form']) assert.ok(tags.includes(t), t);
  assert.deepEqual(f.staleStateTags(['loc-921-n-18th', 'loc-1923-cecil-b-moore', 'age-9', 'website-lead'], tags),
    ['loc-1923-cecil-b-moore', 'age-9']);
});

test('brand split: only 1923 is A Mother\'s Touch', () => {
  assert.equal(f.triggerForBrand(f.brandForLoc('loc-1923-cecil-b-moore')), 'family-confirm-trigger-amt');
  assert.equal(f.triggerForBrand(f.brandForLoc('loc-921-n-18th')), 'family-confirm-trigger');
});

test('send window is Philadelphia 8am–9pm', () => {
  assert.ok(f.inWindow(new Date('2026-10-05T12:00:00Z')));   // 8am EDT
  assert.ok(!f.inWindow(new Date('2026-10-05T11:59:00Z')));  // 7:59am
  assert.ok(!f.inWindow(new Date('2026-10-06T01:00:00Z')));  // 9pm
});

test('reviewer cases: hyphens, middle names, initials, typos, ages', () => {
  assert.ok(f.sameChild('Oribella Rollins-Richardson', 'Oribella Rollins Richardson'));
  assert.ok(f.sameChild('Maria Elena Lopez', 'Maria Lopez'));
  assert.ok(f.sameChild('Maria L.', 'Maria Lopez'));
  assert.ok(!f.sameChild('Marai Lopez', 'Maria Lopez'));
  assert.ok(f.nearChild('Marai Lopez', 'Maria Lopez'));
  assert.ok(!f.nearChild('Juan Lopez', 'Maria Lopez'));
  for (const [v, y] of [['3 years 6 months', 3], ['8 weeks', 0], ['6 wks', 0], ['18 mos', 1], ['3 years (+1 sibling)', 3]]) assert.equal(f.ageYears(v, ''), y, v);
});

test('parent typing their own name is never added as a child', () => {
  const r = f.mergeChildren([{ name: 'Maria Lopez' }], { name: 'Ana Lopez' }, 'Ana Lopez');
  assert.equal(r.review, true); assert.equal(r.children.length, 1);
  assert.equal(f.mergeChildren([], { name: 'Ana Lopez' }, 'Ana Lopez').children.length, 1, 'first child on a new contact is still saved');
});

test('legacy contact: child 0 inherits the single loc/group tag', () => {
  const c = contact({ CN: 'Maria Lopez, Juan Lopez' }, ['loc-921-n-18th', 'group-prek', 'website-lead']);
  const kids = f.parseChildren(c, IDS);
  assert.equal(kids[0].loc, 'loc-921-n-18th'); assert.equal(kids[0].group, 'Pre-K');
  assert.deepEqual(f.staleStateTags(c.tags, f.familyTags(kids, {})), []);
});
