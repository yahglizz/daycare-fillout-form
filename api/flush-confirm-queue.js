// Releases family-form confirmation texts held overnight.
//
// submit.js tags a family that submits outside 8am–9pm Philadelphia time with
// `family-confirm-queued` instead of a trigger tag. No workflow listens to it.
// This endpoint swaps it for the right trigger once the window is open — that
// swap is what actually sends the text. Same shape as website/api/flush-sms-queue.js:
// Vercel cron runs at 12:00 and 13:00 UTC (Hobby = daily only), straddling the
// DST change so one of the two is 8am ET; inWindow() is the real guard.
const { TAG, F2, AMT_BRAND, AMT_LOC_TAG, fieldOf, triggerForBrand, inWindow, etHour } = require('./_family');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // ponytail: list scan (location holds tens of contacts); move to tag search past ~2000

const tagsOf = (c) => (c?.tags || []).map((t) => String(t).toLowerCase());

// The brand field is written before a family is queued; the location tag is the fallback.
function brandOf(c) {
  const brand = fieldOf(c, F2.smsBrand);
  if (brand) return brand;
  return tagsOf(c).includes(AMT_LOC_TAG) ? AMT_BRAND : 'A Touch of Blessings';
}

// Re-checked at release time — hours may have passed since the family submitted.
// Held contacts keep the queue tag and show in the dry-run for staff.
function holdReason(c) {
  const tags = tagsOf(c);
  if (c.dnd === true || c?.dndSettings?.SMS?.status === 'active') return 'dnd';
  if (tags.includes(TAG.confirmed)) return 'already-confirmed';
  if (!tags.includes('sms-consent')) return 'no-consent-tag';
  const locs = tags.filter((t) => t.startsWith('loc-'));
  if (locs.includes(AMT_LOC_TAG) && locs.some((t) => t !== AMT_LOC_TAG) && !fieldOf(c, F2.smsBrand)) return 'mixed-entities';
  return '';
}

async function listQueued(headers, locationId) {
  const found = [];
  let startAfterId = '';
  let startAfter = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const qs = new URLSearchParams({ locationId, limit: String(PAGE_SIZE) });
    if (startAfterId) { qs.set('startAfterId', startAfterId); qs.set('startAfter', startAfter); }
    const r = await fetch(`${GHL_BASE}/contacts/?${qs}`, { headers });
    if (!r.ok) throw new Error(`contact list ${r.status}`);
    const batch = (await r.json())?.contacts || [];
    for (const c of batch) if (tagsOf(c).includes(TAG.queued)) found.push(c);
    if (batch.length < PAGE_SIZE) break;
    const last = batch[batch.length - 1];
    startAfterId = last?.id || '';
    startAfter = String(last?.dateAdded ?? '');
    if (!startAfterId) break;
  }
  return found;
}

module.exports = async function handler(req, res) {
  // Sends real texts — never publicly triggerable. Vercel Cron sends CRON_SECRET.
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: 'not configured' });
  if ((req.headers.authorization || '') !== `Bearer ${secret}`) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const token = process.env.GHL_PIT_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) return res.status(503).json({ ok: false, error: 'not configured' });
  if (process.env.FAMILY_CONFIRM_SMS_ENABLED === 'false') return res.status(200).json({ ok: true, disabled: true, released: 0 });

  const dry = /(^|&)dry=1(&|$)/.test(String(req.url || '').split('?')[1] || '');
  const hour = etHour();
  // A dry run reports at any hour; a real run only releases inside the window.
  if (!dry && !inWindow()) return res.status(200).json({ ok: true, window: 'closed', etHour: hour, released: 0 });

  const headers = { Authorization: `Bearer ${token}`, Version: '2021-07-28', 'Content-Type': 'application/json', 'User-Agent': 'atob-forms/1.0' };
  let queued;
  try { queued = await listQueued(headers, locationId); }
  catch (err) { console.error('[confirm-flush] list failed:', err.message); return res.status(502).json({ ok: false, error: 'contact lookup failed' }); }

  const held = [];
  const ready = [];
  for (const c of queued) {
    const why = holdReason(c);
    if (why) held.push({ id: c.id, why }); else ready.push(c);
  }
  if (dry) return res.status(200).json({ ok: true, dryRun: true, window: inWindow() ? 'open' : 'closed', etHour: hour, held, wouldRelease: ready.map((c) => ({ id: c.id, trigger: triggerForBrand(brandOf(c)) })) });
  for (const h of held) console.log(`[confirm-flush] ${h.id} held: ${h.why}`);

  const released = [];
  const failed = [];
  for (const c of ready) {
    const trigger = triggerForBrand(brandOf(c));
    // Trigger first, queue tag second: a failed removal re-adds a trigger the
    // contact already has (workflow re-entry is OFF → no second text). The
    // reverse order could strand the family.
    const add = await fetch(`${GHL_BASE}/contacts/${c.id}/tags`, { method: 'POST', headers, body: JSON.stringify({ tags: [trigger] }) });
    if (!add.ok) { console.error(`[confirm-flush] ${c.id} trigger failed`, add.status); failed.push(c.id); continue; }
    const del = await fetch(`${GHL_BASE}/contacts/${c.id}/tags`, { method: 'DELETE', headers, body: JSON.stringify({ tags: [TAG.queued] }) });
    if (!del.ok) console.error(`[confirm-flush] ${c.id} queue tag not cleared`, del.status);
    released.push({ id: c.id, trigger });
  }
  console.log(`[confirm-flush] released ${released.length}, failed ${failed.length}`);
  return res.status(200).json({ ok: failed.length === 0, etHour: hour, released, failed, held });
};
