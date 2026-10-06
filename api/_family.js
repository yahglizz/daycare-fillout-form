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
  const s = String(ageText || '').toLowerCase();
  const n = s.match(/\d+(\.\d+)?/);
  if (!n) return NaN;
  const v = parseFloat(n[0]);
  return /month|mo\b/.test(s) ? Math.floor(v / 12) : Math.floor(v);
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

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

// Same child? Full names match, or first names match and one side has no last
// name / the last names match. Case, accents and punctuation are ignored.
function sameChild(a, b) {
  const x = norm(a).split(' ');
  const y = norm(b).split(' ');
  if (!x[0] || !y[0]) return false;
  if (x.join(' ') === y.join(' ')) return true;
  if (x[0] !== y[0]) return false;
  const lx = x.slice(1).join(' ');
  const ly = y.slice(1).join(' ');
  return !lx || !ly || lx === ly;
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
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr.filter((c) => c && c.name);
    } catch { /* fall through to the legacy shape */ }
  }
  const names = String(fieldOf(contact, ids.childName) || '').split(',').map((s) => s.trim()).filter(Boolean);
  return names.map((name, i) => (i === 0
    ? { name, dob: fieldOf(contact, ids.childDob) || '', age: fieldOf(contact, ids.childAge) || '' }
    : { name }));
}

// Add or update one child. Never removes or reorders: child 0 stays the contact's
// identity so GHL search and the dashboard's first card do not move under staff.
function mergeChildren(existing, entry) {
  const children = existing.map((c) => ({ ...c }));
  const i = children.findIndex((c) => sameChild(c.name, entry.name));
  if (i === -1) {
    children.push(entry);
    return { children, index: children.length - 1, added: existing.length > 0 };
  }
  // Latest submission wins per field, but a blank never erases what we had.
  for (const [k, v] of Object.entries(entry)) if (v !== '' && v != null) children[i][k] = v;
  return { children, index: i, added: false };
}

// Every tag this form owns, computed from ALL children so a second child can
// never strip the first child's location/age tags.
function familyTags(children, b) {
  const tags = new Set(['existing-student', 'enrolled', 'family-contact-form', 'form-type-existing-family', 'family-form-complete']);
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
  F2, TAG, AMT_LOC_TAG, AMT_BRAND, ATOB_BRAND, GROUP_TAG,
  ageYears, classroomFor, ageTag, sameChild, fieldOf, parseChildren, mergeChildren,
  familyTags, staleStateTags, brandForLoc, triggerForBrand, etHour, inWindow,
};
