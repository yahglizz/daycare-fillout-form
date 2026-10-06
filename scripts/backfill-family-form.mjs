#!/usr/bin/env node
// One-time backfill: bring every contact that filled the Family Contact Form before
// 2026-10-05 up to the new shape (children_json + readable tags). ADDITIVE ONLY:
// never removes a tag, never overwrites a set field, never adds a family-confirm-*
// tag (past families are NOT texted). Dry run by default.
//
//   GHL_PIT_TOKEN=… GHL_LOCATION_ID=… node scripts/backfill-family-form.mjs          # dry run
//   … node scripts/backfill-family-form.mjs --apply [--only <contactId>]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const f = require('../api/_family.js');

const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
const TOKEN = process.env.GHL_PIT_TOKEN;
const LOC = process.env.GHL_LOCATION_ID;
if (!TOKEN || !LOC) { console.error('set GHL_PIT_TOKEN + GHL_LOCATION_ID'); process.exit(1); }
const IDS = { childName: 'XuWMrMVQSx3W1drZR0e0', childDob: 'WQctVJsId5tRNHqlhwho', childAge: 'KW7sDqefOml0Iym7MH5c', smsConsent: 'pOKARrXbbuf9dF9MduiC' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ghl(path, method = 'GET', body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch('https://services.leadconnectorhq.com' + path, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${TOKEN}`, Version: '2021-07-28', 'Content-Type': 'application/json', 'User-Agent': 'atob-forms-backfill/1.0' } });
    if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }   // never mistake a throttle for data
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
    return d;
  }
  throw new Error(`${method} ${path} still 429 after retries`);
}

const all = [];
for (let page = 1; page < 50; page++) {
  const d = await ghl('/contacts/search', 'POST', { locationId: LOC, pageLimit: 100, page, filters: [{ field: 'tags', operator: 'contains', value: 'family-contact-form' }] });
  all.push(...d.contacts); if (d.contacts.length < 100) break; await sleep(300);
}
let changed = 0; let unresolved = 0;
for (const s of all) {
  if (ONLY && s.id !== ONLY) continue;
  try {
    const c = (await ghl(`/contacts/${s.id}`)).contact;
    const label = `${c.firstName || ''} ${c.lastName || ''}`.trim();
    if (/zztest/i.test(label) || String(c.email || '').startsWith('zztest')) continue; // test contacts
    const hasJson = !!f.fieldOf(c, f.F2.childrenJson);
    let children = f.parseChildren(c, IDS);
    if (!children.length && label) children = [{ name: label }];
    const kids = children.map((k) => ({ ...k, group: k.group || (f.ageConflict(k) ? '' : f.classroomFor(f.ageYears(k.age, k.dob))) }));
    // An existing group tag that the corrected age parser disagrees with (the old
    // parser read "11 months" as 11 years) is flagged, never silently changed.
    const groupReview = kids.some((k) => !f.ageConflict(k) && k.group && (k.age || k.dob)
      && f.classroomFor(f.ageYears(k.age, k.dob)) && f.classroomFor(f.ageYears(k.age, k.dob)) !== k.group);
    const notes = (await ghl(`/contacts/${s.id}/notes`)).notes || [];
    const people = notes.some((n) => /OTHER AUTHORIZED PEOPLE/.test(n.body || '')) ? [{ name: 'x' }] : [];
    const want = f.familyTags(kids, { smsConsent: f.fieldOf(c, IDS.smsConsent) ? 'yes' : '', people });
    if (groupReview && !want.includes('child-age-review')) want.push('child-age-review');
    const tags = (c.tags || []).map((t) => t.toLowerCase());
    const add = want.filter((t) => !tags.includes(t));
    const fields = hasJson ? [] : [{ id: f.F2.childrenJson, value: JSON.stringify(kids) }];
    if (!add.length && !fields.length) { console.log(`ok      ${s.id} ${label}`); continue; }
    changed++;
    console.log(`${APPLY ? 'APPLY ' : 'would '} ${s.id} ${label} | +tags ${add.join(', ') || '—'} | ${fields.length ? 'children_json ' + kids.map((k) => `${k.name}[${k.loc || '?'}/${k.group || '?'}]`).join('; ') : ''}`);
    if (APPLY) {
      if (fields.length) await ghl(`/contacts/${s.id}`, 'PUT', { customFields: fields });
      if (add.length) await ghl(`/contacts/${s.id}/tags`, 'POST', { tags: add });
    }
  } catch (e) { unresolved++; console.error(`ERROR   ${s.id}: ${e.message}`); }
  await sleep(250);
}
console.log(`\n${all.length} form contacts · ${changed} ${APPLY ? 'updated' : 'to update'} · unresolved ${unresolved}`);
if (unresolved) process.exit(2);   // a partial run is never reported as complete
