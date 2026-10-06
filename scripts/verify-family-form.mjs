#!/usr/bin/env node
// End-to-end health check for the Family Contact Form system. Exits non-zero on any failure.
//
//   node scripts/verify-family-form.mjs            # full run against production
//   DASH=http://localhost:7799 node scripts/...    # also checks the dashboard API (SSH tunnel)
//
// What it proves, every run, with a throwaway family (fictional 555-01xx phone, zztest names):
//   1. both form pages are up and still post the fields submit.js reads
//   2. a submission creates exactly ONE contact with every tag + field
//   3. a sibling submission is appended to the SAME contact, child 1 untouched
//   4. the public response leaks nothing; a bad phone is refused
//   5. the confirmation is armed / queued / blocked exactly as the kill switch + clock say
//   6. the 8am release endpoint is locked (401) and its dry run answers
//   7. (DASH set) the dashboard shows one card per child for that family
// Then deletes the test contact. Credentials: GHL_PIT_TOKEN + GHL_LOCATION_ID, else read from
// ~/forge rei dash/forge-daycare/config/daycare.env. CRON_SECRET optional (dry-run check).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const f = require('../api/_family.js');

const SITE = process.env.SITE || 'https://daycare-fillout-form.vercel.app';
const DASH = process.env.DASH || '';
const envFile = `${process.env.HOME}/forge rei dash/forge-daycare/config/daycare.env`;
const fileEnv = fs.existsSync(envFile) ? Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n')
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')])) : {};
const TOKEN = process.env.GHL_PIT_TOKEN || fileEnv.GHL_API_KEY;
const LOC = process.env.GHL_LOCATION_ID || fileEnv.GHL_LOCATION_ID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

async function ghl(path, method = 'GET', body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch('https://services.leadconnectorhq.com' + path, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${TOKEN}`, Version: '2021-07-28', 'Content-Type': 'application/json', 'User-Agent': 'atob-forms-verify/1.0' } });
    if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
    return { status: r.status, data: await r.json().catch(() => null) };
  }
  return { status: 429, data: null };
}
const field = (c, id) => f.fieldOf(c, id);
const post = (body) => fetch(`${SITE}/api/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const run = Date.now().toString().slice(-6);
const phone = `21555501${String(20 + (Number(run) % 80)).padStart(2, '0')}`; // fictional 555-0120..0199, never delivered
const base = {
  studentName: `Zztest Check${run}`, studentDob: '2022-04-04', studentAge: '', location: 'atb-921',
  parentName: 'Verify Parent', parentPhone: phone, parentEmail: `zztest.verify.${run}@example.com`, parentRelationship: 'Mother',
  emergencyName: 'Zztest Em', emergencyPhone: '2155550199', emergencyRelationship: 'Aunt', shirtSize: '4T', pantsSize: '5T',
  notes: '', smsConsent: 'yes', company: '', people: [{ name: 'Zztest Aunt', relationship: 'Aunt', phone: '2155550198' }], attr: '{}',
};
let contactId = '';
try {
  for (const p of ['', 'mothers-touch']) {
    const html = await (await fetch(`${SITE}/${p}`)).text();
    ok(['studentName', 'parentPhone', 'smsConsent', 'shirtSize', 'pantsSize', 'location'].every((n) => html.includes(`name="${n}"`)), `form /${p} up with all fields`);
  }
  const bad = await post({ ...base, parentPhone: '12' });
  ok(bad.status === 400, 'bad phone refused (400)');

  const r1 = await post(base);
  ok(r1.status === 200 && JSON.stringify(await r1.json()) === '{"ok":true}', 'submit 200, response leaks nothing');
  await sleep(2500);
  const dup = await ghl(`/contacts/search/duplicate?locationId=${LOC}&number=${encodeURIComponent('+1' + phone)}`);
  contactId = dup.data?.contact?.id || '';
  ok(!!contactId, `contact created (${contactId})`);
  let c = (await ghl(`/contacts/${contactId}`)).data?.contact || {};
  for (const t of ['family-contact-form', 'existing-student', 'enrolled', 'loc-921-n-18th', 'group-prek', 'family-form-complete', 'sms-consent', 'has-uniform-sizes', 'has-authorized-people'])
    ok((c.tags || []).includes(t), `tag ${t}`);
  ok(field(c, f.F2.shirtSize) === '4T' && field(c, f.F2.pantsSize) === '5T', 'uniform sizes saved');
  ok(JSON.parse(field(c, f.F2.childrenJson) || '[]').length === 1, 'children_json has 1 child');

  // Confirmation state must match the kill switch + clock: marker present only if armed/queued.
  const marker = field(c, f.F2.confirmSent);
  const tags = c.tags || [];
  const armedOrQueued = tags.includes('family-confirm-trigger') || tags.includes('family-confirm-queued') || tags.includes('family-confirm-pending');
  ok(Boolean(marker) === armedOrQueued, `confirm state consistent (marker ${marker ? 'set' : 'none'}, ${armedOrQueued ? 'armed/queued' : 'not armed'})`);
  console.log(`INFO  confirmation ${armedOrQueued ? (tags.includes('family-confirm-queued') ? 'QUEUED for 8am' : 'ARMED (text sends in ~3 min)') : 'NOT armed (kill switch off or blocked)'}`);

  const r2 = await post({ ...base, studentName: `Zztest Sib${run}`, location: 'amt-1923', studentDob: '2024-02-02' });
  ok(r2.status === 200, 'sibling submit 200');
  await sleep(1500);
  c = (await ghl(`/contacts/${contactId}`)).data?.contact || {};
  const kids = JSON.parse(field(c, f.F2.childrenJson) || '[]');
  ok(kids.length === 2 && kids[0].name === base.studentName, 'sibling appended to SAME contact, child 1 untouched');
  ok((c.tags || []).includes('multi-child') && (c.tags || []).includes('loc-1923-cecil-b-moore'), 'multi-child + sibling location tags');
  const again = await ghl(`/contacts/search/duplicate?locationId=${LOC}&number=${encodeURIComponent('+1' + phone)}`);
  ok(again.data?.contact?.id === contactId, 'still one contact for this phone');

  const lock = await fetch(`${SITE}/api/flush-confirm-queue`);
  ok(lock.status === 401, '8am release endpoint locked without the secret');
  if (process.env.CRON_SECRET) {
    const dry = await fetch(`${SITE}/api/flush-confirm-queue?dry=1`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
    ok(dry.status === 200, `release dry run answers (${JSON.stringify(await dry.json()).slice(0, 120)})`);
  }

  if (DASH) {
    await sleep(8000); // GHL's contact list lags writes by a few seconds
    const d = await (await fetch(`${DASH}/api/daycare/ghl/pending-families`)).json();
    const cards = (d.families || []).filter((x) => x.contact_id === contactId);
    ok(cards.length === 2 && cards[1].card_id === `${contactId}#1`, `dashboard: one card per child (${cards.map((x) => x.card_id).join(', ')})`);
    ok(cards.every((x) => x.ready), 'dashboard: both children ready for Create login');
  }
} catch (e) {
  ok(false, `crashed: ${e.message}`);
} finally {
  if (contactId) {
    const g = (await ghl(`/contacts/${contactId}`)).data?.contact || {};
    if (String(g.email || '').startsWith('zztest.verify.')) {
      const d = await ghl(`/contacts/${contactId}`, 'DELETE');
      console.log(`CLEAN deleted test contact ${contactId} (${d.status})`);
    }
  }
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
