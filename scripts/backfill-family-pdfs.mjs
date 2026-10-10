#!/usr/bin/env node
// One-time backfill: a PDF for every Family Contact Form submission made before the
// PDF feature shipped. Each intake Note in GHL is one real submission with its own
// timestamp (submit.js writes one per submit), so one PDF is made per Note, dated at
// the Note. Sends NOTHING: no staff email, no SMS, no CRM write. Idempotent: a path
// already in the Blob store is skipped. Dry run by default.
//
//   BLOB_READ_WRITE_TOKEN=… node scripts/backfill-family-pdfs.mjs            # dry run
//   BLOB_READ_WRITE_TOKEN=… node scripts/backfill-family-pdfs.mjs --apply [--only <contactId>]
//
// GHL credentials: GHL_PIT_TOKEN + GHL_LOCATION_ID, else read from the dashboard's daycare.env.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { renderFamilyPdf, pdfPath } = require('../api/_pdf.js');
const { put, list } = require('@vercel/blob');

const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
const envFile = `${process.env.HOME}/forge rei dash/forge-daycare/config/daycare.env`;
const fileEnv = fs.existsSync(envFile) ? Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n')
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')])) : {};
const TOKEN = process.env.GHL_PIT_TOKEN || fileEnv.GHL_API_KEY;
const LOC = process.env.GHL_LOCATION_ID || fileEnv.GHL_LOCATION_ID;
if (!TOKEN || !LOC) { console.error('no GHL credentials'); process.exit(1); }
if (!process.env.BLOB_READ_WRITE_TOKEN) { console.error('set BLOB_READ_WRITE_TOKEN'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirror of LOCATIONS in api/submit.js (not exported there).
const LOCATIONS = [
  { name: 'A Touch of Blessings', address: '921 N 18th St., Philadelphia, PA 19130', tag: 'loc-921-n-18th' },
  { name: 'A Touch of Blessings 2 & 3', address: '2318 Cecil B. Moore Ave., Philadelphia, PA 19121', tag: 'loc-2318-cecil-b-moore' },
  { name: "A Mother's Touch Inc.", address: '1923 Cecil B. Moore Ave., Philadelphia, PA 19121', tag: 'loc-1923-cecil-b-moore' },
];
const label = (l) => `${l.name} — ${l.address}`;

async function ghl(path, method = 'GET', body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch('https://services.leadconnectorhq.com' + path, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${TOKEN}`, Version: '2021-07-28', 'Content-Type': 'application/json', 'User-Agent': 'atob-forms-backfill-pdf/1.0' } });
    if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }   // never mistake a throttle for data
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${path} ${r.status}`);
    return d;
  }
  throw new Error(`${method} ${path} still 429 after retries`);
}

// summaryText() in submit.js, read back. Headers are ALL-CAPS lines, values are
// "  Label: value". Anything after NOTES up to a REVIEW:/CHILDREN line is the free text.
function parseIntake(body) {
  const b = { people: [], notes: '' };
  const kv = { CHILD: { Name: 'studentName', 'Date of birth': 'studentDob', Age: 'studentAge', Location: '_loc' },
    'PARENT / GUARDIAN': { Name: 'parentName', 'Mobile (SMS)': 'parentPhone', Email: 'parentEmail', Relationship: 'parentRelationship', 'SMS consent': 'smsConsent' },
    'EMERGENCY CONTACT': { Name: 'emergencyName', Phone: 'emergencyPhone', Relationship: 'emergencyRelationship' },
    'UNIFORM SIZES': { Shirt: 'shirtSize', Pants: 'pantsSize' } };
  let section = '';
  const notes = [];
  for (const raw of String(body || '').split('\n')) {
    const t = raw.trim();
    if (/^(REVIEW:|CHILDREN ON THIS FAMILY:)/.test(t)) { section = ''; continue; }
    if (section === 'NOTES' && t !== '' || (section === 'NOTES' && notes.length)) { notes.push(raw.replace(/^ {2}/, '')); continue; }
    if (!t) continue;
    if (/^[A-Z][A-Z /—-]+$/.test(t)) { section = t === 'FAMILY CONTACT FORM — STUDENT INTAKE' ? '' : t; continue; }
    if (section === 'OTHER AUTHORIZED PEOPLE') {
      const m = /^\d+\.\s*(.*?)(?:\s+\(([^)]*)\))?(?:\s+—\s+(.*))?$/.exec(t);
      if (m) b.people.push({ name: m[1], relationship: m[2] || '', phone: m[3] || '' });
      continue;
    }
    const m = /^([^:]+):\s*(.*)$/.exec(t);
    if (m && kv[section] && kv[section][m[1]]) b[kv[section][m[1]]] = m[2] === '—' ? '' : m[2];
  }
  b.notes = notes.join('\n').trim();
  b.smsConsent = b.smsConsent === 'Yes' ? 'yes' : (b.smsConsent || '');
  return b;
}

const existing = new Set();
let cursor;
do { const p = await list({ prefix: 'family-forms/', limit: 1000, cursor }); p.blobs.forEach((x) => existing.add(x.pathname)); cursor = p.hasMore ? p.cursor : undefined; } while (cursor);

const all = [];
for (let page = 1; page < 50; page++) {
  const d = await ghl('/contacts/search', 'POST', { locationId: LOC, pageLimit: 100, page, filters: [{ field: 'tags', operator: 'contains', value: 'family-contact-form' }] });
  all.push(...d.contacts); if (d.contacts.length < 100) break; await sleep(300);
}

const stat = { contacts: all.length, notes: 0, made: 0, skippedExisting: 0, noNote: [], bad: [], test: 0 };
const byBrand = {};
for (const s of all) {
  if (ONLY && s.id !== ONLY) continue;
  try {
    const c = (await ghl(`/contacts/${s.id}`)).contact;
    const tags = (c.tags || []).map((t) => t.toLowerCase());
    if (/zztest/i.test(`${c.firstName} ${c.lastName} ${c.email}`)) { stat.test++; continue; }
    const notes = ((await ghl(`/contacts/${s.id}/notes`)).notes || [])
      .filter((n) => /^FAMILY CONTACT FORM — STUDENT INTAKE/.test(String(n.body || '').trim()));
    if (!notes.length) { stat.noNote.push(s.id); continue; }
    for (const n of notes) {
      stat.notes++;
      const b = parseIntake(n.body);
      const at = new Date(n.dateAdded || n.createdAt || '');
      if (!b.studentName || !b.emergencyName || isNaN(at)) { stat.bad.push(`${s.id} note ${n.id}`); continue; }
      const loc = LOCATIONS.find((l) => label(l) === b._loc || l.name === b._loc)
        || LOCATIONS.find((l) => tags.includes(l.tag)) || LOCATIONS[0];
      const brandKey = loc.tag === 'loc-1923-cecil-b-moore' ? 'amt' : 'atob';
      const path = pdfPath({ brandKey, at, contactId: s.id, child: b.studentName, parent: b.parentName });
      if (existing.has(path)) { stat.skippedExisting++; continue; }
      const buf = renderFamilyPdf(b, { brandName: loc.name, locLabel: label(loc), at, ref: s.id,
        source: 'Rebuilt from the CRM intake note saved at the time of submission' });
      byBrand[brandKey] = (byBrand[brandKey] || 0) + 1;
      console.log(`${APPLY ? 'WRITE' : 'would'}  ${brandKey}  ${at.toISOString().slice(0, 16)}Z  ${b.studentName}  (${buf.length}B)`);
      if (APPLY) { await put(path, buf, { access: 'private', contentType: 'application/pdf', addRandomSuffix: false }); existing.add(path); }
      stat.made++;
    }
  } catch (e) { stat.bad.push(`${s.id}: ${e.message}`); }
  await sleep(250);
}
console.log(`\ncontacts ${stat.contacts} · intake notes ${stat.notes} · ${APPLY ? 'written' : 'to write'} ${stat.made} ${JSON.stringify(byBrand)}`
  + ` · already stored ${stat.skippedExisting} · test contacts skipped ${stat.test}`);
if (stat.noNote.length) console.log(`no intake note on ${stat.noNote.length} contact(s): ${stat.noNote.join(', ')}`);
if (stat.bad.length) { console.error(`UNRESOLVED ${stat.bad.length}:\n  ` + stat.bad.join('\n  ')); process.exit(2); }
