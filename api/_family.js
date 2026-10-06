// Pure helpers for the Family Contact Form (no I/O). Shared by submit.js and
// flush-confirm-queue.js, and unit-tested by test/family.test.js. The leading
// underscore keeps Vercel from deploying this file as its own function.

// Custom-field ids created 2026-10-05 for the confirmation flow + uniforms.
const F2 = {
  shirtSize: 'YlJ22B5f89vAQBFWBkW5',
  pantsSize: 'HnSCMs702Efn0eNPEEfi',
  confirmSent: 'D1HjF1rkDPhTQsNoPCoc',   // ISO time — one confirmation text per family
  confirmedAt: 'T4h8YJeha9uvQE5MgBNf',   // written by the dashboard poller on a YES
  childrenJson: 'e7YOKwZiHYM5lUnehTGE',  // [{name,dob,age,group,loc,shirt,pants,updatedAt}]
  parentFirst: 'N3T1MeOASolGi2rJbqb6',   // contact.parent_first_name — the workflow greets with it
  smsBrand: 'Tj4Q7LUwMM2QbmSfG1Ud',      // contact.sms_brand — routes a queued text to the right entity
};

const TAG = {
  pending: 'family-confirm-pending',
  queued: 'family-confirm-queued',
  trigger: 'family-confirm-trigger',
  triggerAmt: 'family-confirm-trigger-amt',
  confirmed: 'family-confirmed',
};

const AMT_LOC_TAG = 'loc-1923-cecil-b-moore';
const AMT_BRAND = "A Mother's Touch";
const ATOB_BRAND = 'A Touch of Blessings';

const MAX_CHILDREN = 12;

const GROUP_TAG = { Infants: 'group-infants', Toddlers: 'group-toddlers', 'Pre-K': 'group-prek', 'School-Age': 'group-schoolage' };

// Whole years from DOB (preferred) or the free-text age ("3", "3 years", "18 months").
// Returns NaN when neither says anything usable.
function ageYears(ageText, dob, now = new Date()) {
  // Calendar dates compared in Philadelphia, never via Date parsing: a bare
  // "2023-10-06" parses as UTC midnight and lands on the 5th in Eastern time.
  const d = String(dob || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (d) {
    const [ty, tm, td] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
      .format(now).split('-').map(Number);
    const [by, bm, bd] = [Number(d[1]), Number(d[2]), Number(d[3])];
    let y = ty - by;
    if (tm < bm || (tm === bm && td < bd)) y -= 1;
    if (y >= 0) return y;
  }
  // Free text: the unit next to the FIRST number decides ("3 years 6 months" = 3,
  // "18 mos" = 1, "8 weeks" = under 1). A bare number is years.
  const m = String(ageText || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*([a-z]*)/);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  const unit = m[2];
  if (/^(d|day|days|w|wk|wks|week|weeks)$/.test(unit)) return 0;
  if (/^(m|mo|mos|mon|mons|month|months)$/.test(unit)) return Math.floor(v / 12);
  return Math.floor(v);
}

function classroomFor(years) {
  if (isNaN(years)) return '';
  if (years < 1) return 'Infants';
  if (years < 3) return 'Toddlers';
  if (years < 5) return 'Pre-K';
  return 'School-Age';
}

// Whitelisted age tag: age-infant under 1, age-1 … age-12, nothing outside that.
function ageTag(years) {
  if (isNaN(years) || years < 0 || years > 12) return '';
  return years < 1 ? 'age-infant' : `age-${years}`;
}

// Lowercase, accents stripped, letters (any script) + spaces only. Hyphens become
// spaces so "Rollins-Richardson" and "Rollins Richardson" read the same.
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[-‐]/g, ' ').replace(/[^\p{L} ]/gu, '').replace(/\s+/g, ' ').trim();

// First token + everything after the middle name(s) as one squashed surname.
function nameParts(s) {
  const w = norm(s).split(' ').filter(Boolean);
  return { first: w[0] || '', last: w.length > 1 ? w[w.length - 1] : '', all: w.slice(1).join('') };
}

// Same child? First names equal, and the surnames agree: either side missing,
// equal with spaces/hyphens removed, the same final surname (middle names
// ignored), or an initial ("Maria L.") matching.
function sameChild(a, b) {
  const x = nameParts(a);
  const y = nameParts(b);
  if (!x.first || !y.first || x.first !== y.first) return false;
  if (!x.last || !y.last) return true;
  if (x.all === y.all || x.last === y.last) return true;
  const [s1, s2] = x.last.length <= y.last.length ? [x.last, y.last] : [y.last, x.last];
  return s1.length === 1 && s2.startsWith(s1);
}

// Probably a typo of an existing child ("Marai Lopez" vs "Maria Lopez"): same
// surname, first names one edit apart. Never auto-merged, never auto-appended.
function nearChild(a, b) {
  // Bounded: names are capped in submit.js, and this never runs on long input.
  if (String(a || '').length > 60 || String(b || '').length > 60) return false;
  const x = nameParts(a);
  const y = nameParts(b);
  if (!x.last || x.last !== y.last || x.first === y.first) return false;
  const [p, q] = [x.first, y.first];
  if (Math.abs(p.length - q.length) > 1) return false;
  const d = Array.from({ length: p.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= q.length; j++) d[0][j] = j;
  for (let i = 1; i <= p.length; i++) {
    for (let j = 1; j <= q.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (p[i - 1] === q[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && p[i - 1] === q[j - 2] && p[i - 2] === q[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[p.length][q.length] <= 1;
}

function fieldOf(contact, id) {
  const f = (contact?.customFields || []).find((x) => x && x.id === id);
  const v = f ? (f.value ?? f.fieldValue) : '';
  return v == null ? '' : v;
}

// The children already on a contact. children_json wins; contacts written before
// it existed fall back to the child-name comma list ("Maria Lopez, Juan Lopez",
// the website form's multi-child shape) with the contact-level DOB/age on the first.
function parseChildren(contact, ids) {
  const raw = fieldOf(contact, F2.childrenJson);
  if (raw) {
    try {
      const arr = String(raw).length < 20000 ? JSON.parse(raw) : null;
      if (Array.isArray(arr) && arr.length) return arr.filter((c) => c && c.name).slice(0, MAX_CHILDREN);
    } catch { /* fall through to the legacy shape */ }
  }
  const names = String(fieldOf(contact, ids.childName) || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Child 0 inherits the centre/age group the contact already carries (when it
  // has exactly one), so merging a sibling never strips those tags.
  const tags = (contact?.tags || []).map((t) => String(t).toLowerCase());
  const locs = tags.filter((t) => t.startsWith('loc-'));
  const groups = Object.entries(GROUP_TAG).filter(([, t]) => tags.includes(t)).map(([g]) => g);
  return names.map((name, i) => (i === 0
    ? { name, dob: fieldOf(contact, ids.childDob) || '', age: fieldOf(contact, ids.childAge) || '',
      ...(locs.length === 1 ? { loc: locs[0] } : {}), ...(groups.length === 1 ? { group: groups[0] } : {}) }
    : { name }));
}

// Add or update one child. Never removes or reorders: child 0 stays the contact's
// identity so GHL search and the dashboard's first card do not move under staff.
// parentName: a child name equal to the parent's is almost always the parent
// typing their own name — on a family that already has children it is never
// added as a new child; the submission is flagged for review instead.
function mergeChildren(existing, entry, parentName = '') {
  const children = existing.map((c) => ({ ...c }));
  const i = children.findIndex((c) => sameChild(c.name, entry.name));
  // A family is a handful of children; past MAX_CHILDREN a submission is flagged,
  // never appended (keeps children_json and every per-child loop bounded).
  if (i === -1 && children.length >= MAX_CHILDREN) return { children, index: -1, added: false, review: true };
  if (i === -1) {
    if (existing.length && (sameChild(entry.name, parentName) || children.some((c) => nearChild(c.name, entry.name)))) {
      return { children, index: -1, added: false, review: true };
    }
    children.push(entry);
    return { children, index: children.length - 1, added: existing.length > 0 };
  }
  // Latest submission wins per field, but a blank never erases what we had.
  // The name is the exception: "maria LOPEZ" must not replace "Maria Lopez".
  // It only changes when the new one adds a word (a last name the first lacked).
  for (const [k, v] of Object.entries(entry)) {
    if (v === '' || v == null) continue;
    if (k === 'name' && norm(v).split(' ').length <= norm(children[i].name).split(' ').length) continue;
    children[i][k] = v;
  }
  return { children, index: i, added: false };
}

// Every tag this form owns, computed from ALL children so a second child can
// never strip the first child's location/age tags.
function familyTags(children, b) {
  const tags = new Set(['existing-student', 'enrolled', 'family-contact-form', 'form-type-existing-family']);
  // Complete = every child has an age (DOB or typed) and a known centre.
  if (children.length && children.every((c) => (c.dob || c.age) && c.loc && c.loc !== 'loc-unknown')) tags.add('family-form-complete');
  for (const c of children) {
    if (c.loc) tags.add(c.loc);
    if (c.group && GROUP_TAG[c.group]) tags.add(GROUP_TAG[c.group]);
    const at = ageTag(ageYears(c.age, c.dob));
    if (at) tags.add(at);
    if (c.shirt || c.pants) tags.add('has-uniform-sizes');
  }
  if (children.length > 1) tags.add('multi-child');
  if (b.smsConsent === 'yes') tags.add('sms-consent');
  if (Array.isArray(b.people) && b.people.some((p) => p && (p.name || p.phone))) tags.add('has-authorized-people');
  return [...tags];
}

// Current-state tag families: a value no longer computed for ANY child is removed.
const STATE_PREFIXES = ['loc-', 'group-', 'age-'];
function staleStateTags(existing, next) {
  const want = new Set(next);
  return (existing || []).map(String).filter((t) => !want.has(t)
    && STATE_PREFIXES.some((p) => t.startsWith(p)));
}

function brandForLoc(locTag) {
  return locTag === AMT_LOC_TAG ? AMT_BRAND : ATOB_BRAND;
}

function triggerForBrand(brand) {
  return brand === AMT_BRAND ? TAG.triggerAmt : TAG.trigger;
}

// Hour in Philadelphia. The GHL location's clock is America/Cancun, so the send
// window is enforced here, never in the workflow.
function etHour(at = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(at)) % 24;
}
const inWindow = (at = new Date()) => { const h = etHour(at); return h >= 8 && h < 21; };

module.exports = {
  MAX_CHILDREN, F2, TAG, AMT_LOC_TAG, AMT_BRAND, ATOB_BRAND, GROUP_TAG,
  ageYears, classroomFor, ageTag, sameChild, nearChild, fieldOf, parseChildren, mergeChildren,
  familyTags, staleStateTags, brandForLoc, triggerForBrand, etHour, inWindow,
};
