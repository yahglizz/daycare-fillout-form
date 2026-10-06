// Family Contact Form -> GHL CRM (existing-student intake).
// Upserts a contact into the daycare GHL location, tags + organizes by location,
// fills custom fields, and writes a Note with the full intake. No opportunity card
// (these are current students, not sales leads). Dependency-free (Node 18+ fetch).

const GHL_BASE = 'https://services.leadconnectorhq.com';
const {
  F2, TAG, ageYears, ageConflict, classroomFor, fieldOf, parseChildren, mergeChildren,
  familyTags, staleStateTags, brandForLoc, triggerForBrand, inWindow,
} = require('./_family');

// Custom-field ids for location 4JIvZEmkY5EjTsDRnjBN (plain identifiers, not secrets).
const F = {
  childName: 'XuWMrMVQSx3W1drZR0e0',
  childDob: 'WQctVJsId5tRNHqlhwho',
  childAge: 'KW7sDqefOml0Iym7MH5c',
  preferredLocation: 'AisthOsgTO46if6ebAvB',
  parentRelationship: 'r6AYcBQuFvyfNum0gZDZ',
  emergencyName: 'pF09l1zZhPh1zOi7CWLc',
  emergencyPhone: 'ZidoyoCzWfoNVak9G494',
  emergencyRelationship: 'eKCWiJmLhRwbHyeO0Rkh',
  classroom: 'TSMLTeehtQL262xkLBCS',
  enrollStatus: 'd7sKOSmyfbxmXnuIOtNr',
  smsConsent: 'pOKARrXbbuf9dF9MduiC',
  parentName: '68zgbWrCHH0e9OIyuRJx',
  // Ad attribution, same four fields the enrollment form writes so both funnels
  // report through one set of columns.
  adCampaign: 'ZsP48g59eB7Hl9vKhbAA',
  adSource: 'Rakc5bf2JKGxzKnJVOpQ',
  adContent: 'IOPkNcVg3LmGhgGiTxBt',
  adClickId: 'TzYC7B2KtKIub5t8VidE',
};

// Where the family came from, as one filterable tag. Mirrors website/api/enroll.js
// deliberately: an ad pointed at this form should report the same way an ad
// pointed at the enrollment form does.
//   source-meta-ad     paid Facebook / Instagram click
//   source-google-ad   paid Google click
//   source-campaign    any other tagged link — an organic post, an email, a partner
//   source-organic     no attribution at all — someone sent them the link
function sourceTag(adSource, adClickId) {
  const s = String(adSource || '').toLowerCase();
  if (!s) return 'source-organic';
  const paid = /paid|cpc|ppc/.test(s) || !!adClickId;
  if (/facebook|instagram|meta/.test(s)) return paid ? 'source-meta-ad' : 'source-campaign';
  if (/google/.test(s)) return paid ? 'source-google-ad' : 'source-campaign';
  return 'source-campaign';
}

// The upsert response names custom field values `fieldValue` on create and
// `value` on update. Reading only one loses first touch on a resubmit.
function mergedField(contact, id) {
  const f = (contact?.customFields || []).find((x) => x.id === id);
  return f?.value ?? f?.fieldValue ?? '';
}

function parseAttr(raw) {
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

const LOCATIONS = {
  'atb-921': { name: 'A Touch of Blessings', address: '921 N 18th St., Philadelphia, PA 19130', tag: 'loc-921-n-18th' },
  'atb-2318': { name: 'A Touch of Blessings 2 & 3', address: '2318 Cecil B. Moore Ave., Philadelphia, PA 19121', tag: 'loc-2318-cecil-b-moore' },
  'amt-1923': { name: "A Mother's Touch Inc.", address: '1923 Cecil B. Moore Ave., Philadelphia, PA 19121', tag: 'loc-1923-cecil-b-moore' },
};


function toE164(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return d ? `+${d}` : '';
}


function summaryText(b, locLabel) {
  const lines = [
    'FAMILY CONTACT FORM — STUDENT INTAKE',
    '',
    'CHILD',
    '  Name: ' + b.studentName,
    '  Date of birth: ' + (b.studentDob || '—'),
    '  Age: ' + (b.studentAge || '—'),
    '  Location: ' + locLabel,
    '',
    'PARENT / GUARDIAN',
    '  Name: ' + b.parentName,
    '  Mobile (SMS): ' + b.parentPhone,
    '  Email: ' + b.parentEmail,
    '  Relationship: ' + (b.parentRelationship || '—'),
    '  SMS consent: ' + (b.smsConsent === 'yes' ? 'Yes' : 'No'),
    '',
    'EMERGENCY CONTACT',
    '  Name: ' + b.emergencyName,
    '  Phone: ' + b.emergencyPhone,
    '  Relationship: ' + b.emergencyRelationship,
  ];
  if (b.shirtSize || b.pantsSize) {
    lines.push('', 'UNIFORM SIZES', '  Shirt: ' + (b.shirtSize || '—'), '  Pants: ' + (b.pantsSize || '—'));
  }
  const people = Array.isArray(b.people) ? b.people : [];
  if (people.length) {
    lines.push('', 'OTHER AUTHORIZED PEOPLE');
    people.forEach((p, i) => {
      lines.push('  ' + (i + 1) + '. ' + (p.name || '—') +
        (p.relationship ? ' (' + p.relationship + ')' : '') +
        (p.phone ? ' — ' + p.phone : ''));
    });
  }
  if (b.notes) lines.push('', 'NOTES', '  ' + b.notes);
  return lines.join('\n');
}

async function ghl(path, method, token, payload) {
  const resp = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
      // services.leadconnectorhq.com's WAF 403s some default agents.
      'User-Agent': 'atob-forms/1.0',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, data };
}

// Same visual system as the enrollment notification in website/api/enroll.js —
// purple gradient header, gold eyebrow, ruled label/value rows, gold-bordered
// notes block. These two emails land in the same inbox, and having one arrive as
// a designed card and the other as raw text made the family form look like the
// afterthought it is not.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function intakeHtml(b, locLabel, brandName) {
  const submittedAt = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short',
  });
  const row = (label, value) => `
    <tr>
      <td style="padding:10px 0;font-weight:600;width:42%;color:#1B1230;border-bottom:1px solid #EDE4F5;">${escapeHtml(label)}</td>
      <td style="padding:10px 0;color:#4A4458;border-bottom:1px solid #EDE4F5;">${value}</td>
    </tr>`;
  const heading = (text) => `
    <div style="margin:26px 0 4px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#5B2C8E;">${escapeHtml(text)}</div>`;

  const people = Array.isArray(b.people) ? b.people : [];
  const peopleRows = people.map((p, i) => row(
    `Person ${i + 1}`,
    `${escapeHtml(p.name || '—')}${p.relationship ? ` <span style="color:#7D7592;">(${escapeHtml(p.relationship)})</span>` : ''}${p.phone ? ` &middot; ${escapeHtml(p.phone)}` : ''}`,
  )).join('');

  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#F6F0FB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F0FB;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(91,44,142,0.12);">
          <tr><td style="background:linear-gradient(135deg,#5B2C8E 0%,#7B4DAE 100%);padding:32px 32px 28px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#DBAB3A;margin-bottom:8px;">Existing Family</div>
            <h1 style="margin:0;font-family:Georgia,serif;font-size:26px;color:#FFFFFF;line-height:1.2;">Family Contact Form</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">${escapeHtml(brandName)}</p>
          </td></tr>
          <tr><td style="padding:28px 32px;">
            ${heading('Child')}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
              ${row('Name', escapeHtml(b.studentName))}
              ${row('Date of Birth', escapeHtml(b.studentDob || '—'))}
              ${row('Age', escapeHtml(b.studentAge || '—'))}
              ${row('Location', escapeHtml(locLabel))}
            </table>
            ${heading('Parent / Guardian')}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
              ${row('Name', escapeHtml(b.parentName))}
              ${row('Mobile (SMS)', `<a href="tel:${escapeHtml(b.parentPhone)}" style="color:#5B2C8E;text-decoration:none;">${escapeHtml(b.parentPhone)}</a>`)}
              ${row('Email', `<a href="mailto:${escapeHtml(b.parentEmail)}" style="color:#5B2C8E;text-decoration:none;">${escapeHtml(b.parentEmail)}</a>`)}
              ${row('Relationship', escapeHtml(b.parentRelationship || '—'))}
              ${row('SMS Consent', b.smsConsent === 'yes' ? 'Yes' : 'No')}
            </table>
            ${heading('Emergency Contact')}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
              ${row('Name', escapeHtml(b.emergencyName))}
              ${row('Phone', `<a href="tel:${escapeHtml(b.emergencyPhone)}" style="color:#5B2C8E;text-decoration:none;">${escapeHtml(b.emergencyPhone)}</a>`)}
              ${row('Relationship', escapeHtml(b.emergencyRelationship))}
            </table>
            ${(b.shirtSize || b.pantsSize) ? heading('Uniform Sizes') + `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
              ${row('Shirt', escapeHtml(b.shirtSize || '—'))}
              ${row('Pants', escapeHtml(b.pantsSize || '—'))}
            </table>` : ''}
            ${peopleRows ? heading('Other Authorized People') + `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">${peopleRows}</table>` : ''}
            ${b.notes ? `
              <div style="margin-top:24px;padding:16px 18px;background:#FFFAF2;border-left:3px solid #C9962B;border-radius:6px;">
                <div style="font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#A67C1F;margin-bottom:6px;">Additional Notes</div>
                <div style="color:#4A4458;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(b.notes)}</div>
              </div>` : ''}
            <div style="margin-top:28px;padding-top:20px;border-top:1px solid #EDE4F5;text-align:center;color:#7D7592;font-size:12px;">
              Submitted ${escapeHtml(submittedAt)} ET<br>
              Reply directly to this email to contact ${escapeHtml(b.parentName)}.
            </div>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

// Optional email notification (OFF unless RESEND_API_KEY + NOTIFY_EMAIL are set).
async function notifyEmail(b, locLabel, brandName) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL; // comma-separated ok
  if (!key || !to) return;
  const from = process.env.RESEND_FROM || 'A Touch of Blessings <onboarding@resend.dev>';
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: to.split(',').map((s) => s.trim()).filter(Boolean),
        reply_to: b.parentEmail,
        subject: `Family Contact Form — ${b.studentName} (${locLabel})`,
        html: intakeHtml(b, locLabel, brandName || 'A Touch of Blessings'),
        // Plain-text alternative kept: some clients and every screen reader use it.
        text: summaryText(b, locLabel),
      }),
    });
  } catch (err) { console.error('notifyEmail failed', err); }
}

// A first name safe to merge into an SMS: letters (any script), apostrophe,
// hyphen; 2-20 chars. Anything else → "there".
function safeFirstName(full) {
  const first = String(full || '').trim().split(/\s+/)[0] || '';
  return /^[\p{L}][\p{L}'’-]{1,19}$/u.test(first) ? first : 'there';
}

// Arm the confirmation text (GHL workflow "Family Form Confirmation SMS" sends it).
// Mirrors armSpeedToLeadSms in website/api/enroll.js: every compliance gate sits
// here, above the trigger tag, because applying the tag IS the send. Never throws;
// a failure here must not fail a family's submission. Returns a short status.
async function armConfirmation(contactId, contact, b, brand, token, children = []) {
  if (b.smsConsent !== 'yes') return 'no-consent';
  if (process.env.FAMILY_CONFIRM_SMS_ENABLED === 'false') return 'disabled';
  const tags = (contact?.tags || []).map((t) => String(t).toLowerCase());
  if (tags.includes(TAG.confirmed)) return 'already-confirmed';
  // GHL dedupes on phone OR email. When the email matched a family stored under a
  // different phone, the text would go to a number this parent never typed.
  if (String(contact.phone || '') !== toE164(b.parentPhone)) {
    console.log(`[confirm] ${contactId} not armed: stored phone differs from the submitted one`);
    return 'phone-mismatch';
  }
  // Do Not Disturb (staff-set or a past STOP) always wins.
  const dndSms = contact?.dndSettings?.SMS?.status;
  if (contact.dnd === true || dndSms === 'active') return 'dnd';
  // One confirmation text per family, ever. A second child, or the same family
  // resubmitting, keeps the pending state but never gets a second text.
  if (fieldOf(contact, F2.confirmSent)) {
    if (!tags.includes(TAG.pending)) await ghl(`/contacts/${contactId}/tags`, 'POST', token, { tags: [TAG.pending] });
    return 'already-sent';
  }
  // Workflow inputs first, tag last: a workflow that starts before its fields
  // exist sends a message full of blanks. PUT, not upsert (upsert replaces tags).
  // This value is merged into a text sent FROM the business number, and the form
  // is public: anything but a plain name (a link, a phone number, a sentence) is
  // dropped so the form cannot be used to put words in the daycare's mouth.
  let parentFirst = safeFirstName(b.parentName);
  // A parent who typed the child's name as their own would be greeted as the child.
  if (children.some((c) => String(c.name || '').split(' ')[0].toLowerCase() === parentFirst.toLowerCase())) parentFirst = 'there';
  const fr = await ghl(`/contacts/${contactId}`, 'PUT', token, {
    customFields: [{ id: F2.parentFirst, value: parentFirst }, { id: F2.smsBrand, value: brand }],
  });
  if (!fr.ok) { console.error('[confirm] field write failed — NOT arming', fr.status, JSON.stringify(fr.data)); return 'field-write-failed'; }
  // The workflow waits 3 minutes, so judge the window at the moment it sends.
  const queued = !inWindow(new Date(Date.now() + 3 * 60 * 1000));
  const tag = queued ? TAG.queued : triggerForBrand(brand);
  const tr = await ghl(`/contacts/${contactId}/tags`, 'POST', token, { tags: [tag, TAG.pending] });
  if (!tr.ok) { console.error('[confirm] trigger tag failed — no text', tr.status, JSON.stringify(tr.data)); return 'tag-failed'; }
  // Marker only once the tag is on, so any earlier failure retries cleanly.
  const mr = await ghl(`/contacts/${contactId}`, 'PUT', token, {
    customFields: [{ id: F2.confirmSent, value: new Date().toISOString() }],
  });
  if (!mr.ok) console.error('[confirm] MARKER WRITE FAILED — a resubmit could re-text', mr.status, JSON.stringify(mr.data));
  console.log(`[confirm] ${contactId} ${queued ? 'queued for 8am' : 'armed'} (${tag})`);
  return queued ? 'queued' : 'armed';
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  let b;
  try { b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})); }
  catch { return res.status(400).send('Invalid request'); }

  // Honeypot: bots fill the hidden "company" field. Pretend success.
  if (b.company) return res.status(200).json({ ok: true });

  const required = {
    studentName: b.studentName, location: b.location,
    parentName: b.parentName, parentPhone: b.parentPhone, parentEmail: b.parentEmail,
    emergencyName: b.emergencyName, emergencyPhone: b.emergencyPhone, emergencyRelationship: b.emergencyRelationship,
  };
  for (const [k, v] of Object.entries(required)) {
    if (!v || !String(v).trim()) return res.status(400).send(`Missing required field: ${k}`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.parentEmail)) return res.status(400).send('Invalid email address');
  if (b.smsConsent !== 'yes') return res.status(400).send('SMS consent is required');
  // Every free-text field is bounded before any processing: this endpoint is
  // public, and names go through matching loops in _family.js.
  const LIMITS = { studentName: 80, parentName: 80, parentRelationship: 40, emergencyName: 80, emergencyPhone: 30,
    emergencyRelationship: 40, parentEmail: 120, parentPhone: 30, studentAge: 30, studentDob: 10, notes: 2000, location: 20 };
  for (const [k, n] of Object.entries(LIMITS)) if (String(b[k] || '').length > n) return res.status(400).send(`That ${k} is too long.`);
  b.people = (Array.isArray(b.people) ? b.people : []).slice(0, 10).map((p) => ({
    name: String(p?.name || '').slice(0, 80), relationship: String(p?.relationship || '').slice(0, 40), phone: String(p?.phone || '').slice(0, 30) }));
  if (String(b.attr || '').length > 4000) b.attr = '';
  // A US mobile or nothing: the confirmation text goes to this number.
  if (!/^\+1[2-9]\d{9}$/.test(toE164(b.parentPhone))) return res.status(400).send('Please enter a 10-digit US mobile number.');
  // Free-text bounds: sizes come from a fixed select, anything long is not a size.
  for (const k of ['shirtSize', 'pantsSize']) b[k] = String(b[k] || '').slice(0, 40);

  const token = process.env.GHL_PIT_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) {
    console.error('GHL not configured (GHL_PIT_TOKEN / GHL_LOCATION_ID missing)');
    return res.status(500).send('Our system is not fully set up yet. Please call (215) 236-5439.');
  }
  const fail = () => res.status(500).send('Unable to save right now. Please call (215) 236-5439 or try again in a moment.');

  const loc = LOCATIONS[b.location] || { name: b.location, address: '', tag: 'loc-unknown' };
  const locLabel = loc.address ? `${loc.name} — ${loc.address}` : loc.name;
  // Commas are the legacy child-list separator ("Maria Lopez, Juan Lopez").
  const childName = String(b.studentName).replace(/,/g, ' ').trim().replace(/\s+/g, ' ');
  // No classroom guess when the DOB and typed age disagree (tagged child-age-review).
  const classroom = ageConflict({ dob: b.studentDob, age: b.studentAge }) ? '' : classroomFor(ageYears(b.studentAge, b.studentDob));

  // ── 1. Find-or-create the FAMILY, with no child identity in the write ──────
  // GHL dedupes the upsert on the parent's phone/email, so a parent already in
  // GHL (website lead, earlier form, staff-made) is updated, never duplicated.
  // Child fields are left out on purpose: writing them here would overwrite the
  // first child the moment a parent submits for a second one. They are merged
  // in step 3 after reading what the contact already holds.
  const familyFields = [
    { id: F.parentName, value: b.parentName },
    { id: F.preferredLocation, value: locLabel },
    { id: F.enrollStatus, value: 'Enrolled' },
    { id: F.emergencyName, value: b.emergencyName },
    { id: F.emergencyPhone, value: b.emergencyPhone },
    { id: F.emergencyRelationship, value: b.emergencyRelationship },
    { id: F.smsConsent, value: new Date().toISOString().slice(0, 10) },
  ];
  if (b.parentRelationship) familyFields.push({ id: F.parentRelationship, value: b.parentRelationship });

  // Durable ad attribution, written the same way the enrollment form writes it.
  const a = parseAttr(b.attr) || {};
  const adSource = [a.utm_source, a.utm_medium].filter(Boolean).join(' / ') ||
    (a.fbclid ? 'facebook / paid' : a.gclid ? 'google / paid' : '');
  const adContent = [a.utm_content, a.utm_term].filter(Boolean).join(' | ');
  for (const [id, value] of [
    [F.adCampaign, a.utm_campaign], [F.adSource, adSource], [F.adContent, adContent], [F.adClickId, a.fbclid || a.gclid],
  ]) if (value) familyFields.push({ id, value });

  const upsert = await ghl('/contacts/upsert', 'POST', token, {
    locationId,
    email: b.parentEmail,
    phone: toE164(b.parentPhone),
    source: 'Family Contact Form',
    customFields: familyFields,
  });
  if (!upsert.ok) {
    console.error('GHL upsert failed', upsert.status, JSON.stringify(upsert.data));
    return fail();
  }
  const contactId = upsert.data?.contact?.id;
  if (!contactId) { console.error('GHL upsert returned no contact id'); return fail(); }

  // ── 2. Read the contact back. GET by id is immediately consistent (search
  // endpoints lag minutes), so a parent submitting two kids back to back still
  // sees child 1 here.
  const got = await ghl(`/contacts/${contactId}`, 'GET', token);
  if (!got.ok) { console.error('GHL contact read failed', got.status, JSON.stringify(got.data)); return fail(); }
  const contact = got.data?.contact || {};

  // ── 3. Merge this child into the family ──────────────────────────────────────
  const entry = {
    name: childName, dob: b.studentDob || '', age: b.studentAge || '', group: classroom,
    loc: loc.tag, shirt: b.shirtSize, pants: b.pantsSize, updatedAt: new Date().toISOString(),
  };
  const { children, index, added, review } = mergeChildren(parseChildren(contact, F), entry, b.parentName);
  if (review) console.log(`[family] ${contactId} child name needs review: "${childName}" (parent's name or near an existing child)`);
  const first = children[0];
  const [cFirst, ...cRest] = String(first.name).split(' ');
  const childFields = [
    { id: F2.childrenJson, value: JSON.stringify(children) },
    // Legacy comma list — the dashboard and every older reader still use it.
    { id: F.childName, value: children.map((c) => c.name).join(', ') },
    // Contact-level child fields describe child 0 (the contact's identity).
    { id: F.childDob, value: first.dob || '' },
    { id: F.childAge, value: first.age || '' },
    { id: F2.shirtSize, value: first.shirt || '' },
    { id: F2.pantsSize, value: first.pants || '' },
  ];
  if (first.group) childFields.push({ id: F.classroom, value: first.group });
  const put = await ghl(`/contacts/${contactId}`, 'PUT', token, {
    // Identity = the CHILD (staff look families up by kid). Child 0 always.
    firstName: cFirst, lastName: cRest.join(' '), name: first.name,
    customFields: childFields.filter((f) => f.value !== ''),
  });
  if (!put.ok) { console.error('GHL child write failed', put.status, JSON.stringify(put.data)); return fail(); }

  // ── 4. Tags: additive POST (never the upsert — it REPLACES the array) ───────
  const tags = familyTags(children, b);
  if (review) tags.push('child-name-review');
  // GHL matched this family by EMAIL while the stored phone is different (or the
  // phone belongs to another contact). Saved, never texted, flagged for staff.
  const phoneMismatch = String(contact.phone || '') !== toE164(b.parentPhone);
  if (phoneMismatch) tags.push('contact-match-review');
  tags.push(sourceTag(mergedField(contact, F.adSource), mergedField(contact, F.adClickId)));
  let st = await ghl(`/contacts/${contactId}/tags`, 'POST', token, { tags });
  if (!st.ok) { await new Promise((r) => setTimeout(r, 1000)); st = await ghl(`/contacts/${contactId}/tags`, 'POST', token, { tags }); }
  if (!st.ok) {
    // family-contact-form is how the dashboard finds the family — no tag, no card.
    console.error('GHL tags failed', st.status, JSON.stringify(st.data));
    return fail();
  }
  const stale = staleStateTags(contact.tags, tags);
  if (stale.length) {
    const dr = await ghl(`/contacts/${contactId}/tags`, 'DELETE', token, { tags: stale });
    if (!dr.ok) console.error('GHL stale tag removal failed', dr.status, JSON.stringify(dr.data));
  }
  console.log(`[family] ${contactId} child ${index + 1}/${children.length}${added ? ' (sibling added)' : ''} tags ${tags.join(', ')}`);

  // ── 5. Note with the full intake (best-effort) ───────────────────────────────
  const note = await ghl(`/contacts/${contactId}/notes`, 'POST', token, {
    body: summaryText(b, locLabel)
      + (phoneMismatch ? `\n\nREVIEW: this form was submitted with phone ${toE164(b.parentPhone)} but matched this contact (stored phone ${contact.phone || 'none'}) by email. No confirmation text was sent. Check whether this is the same family.` : '')
      + (review ? `\n\nREVIEW: "${childName}" was NOT added as a new child — it matches the parent's name or is one letter off an existing child. Fix the child list by hand if this really is another child.` : '')
      + (children.length > 1 ? `\n\nCHILDREN ON THIS FAMILY: ${children.map((c) => c.name).join(', ')}` : ''),
  });
  if (!note.ok) console.error('GHL note failed', note.status, JSON.stringify(note.data));

  // example.com is reserved (RFC 2606) — never a real parent; it is what the health
  // check submits, so it must not email staff a fake new family every run.
  if (!/@example\.com$/i.test(b.parentEmail)) await notifyEmail(b, locLabel, loc.name);

  // ── 6. Confirmation text (never fails the submission) ────────────────────────
  let confirm = 'skipped';
  try {
    contact.tags = [...new Set([...(contact.tags || []), ...tags])];
    confirm = await armConfirmation(contactId, contact, b, brandForLoc(loc.tag), token, children);
  } catch (err) { console.error('[confirm] arm crashed', err && err.message); confirm = 'error'; }

  // The response says nothing about the family: this endpoint is public, and
  // echoing a contact id or child count would confirm that a phone number belongs
  // to an enrolled family. Details stay server-side (logs + res.familyResult for
  // the local test harness — never serialized).
  res.familyResult = { contactId, child: index + 1, children: children.length, confirm, review: !!review };
  return res.status(200).json({ ok: true });
}

module.exports = handler;
module.exports.safeFirstName = safeFirstName;
