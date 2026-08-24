// Family Contact Form -> GHL CRM (existing-student intake).
// Upserts a contact into the daycare GHL location, tags + organizes by location,
// fills custom fields, and writes a Note with the full intake. No opportunity card
// (these are current students, not sales leads). Dependency-free (Node 18+ fetch).

const GHL_BASE = 'https://services.leadconnectorhq.com';

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

const GROUP_TAG = { Infants: 'group-infants', Toddlers: 'group-toddlers', 'Pre-K': 'group-prek', 'School-Age': 'group-schoolage' };

function toE164(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return d ? `+${d}` : '';
}

// Best-effort classroom from age text ("3 years") or DOB. Returns '' if unknown.
function deriveClassroom(ageText, dob) {
  let years = NaN;
  const m = String(ageText || '').match(/\d+(\.\d+)?/);
  if (m) years = parseFloat(m[0]);
  if (isNaN(years) && dob) {
    const b = new Date(dob), now = new Date();
    if (!isNaN(b.getTime())) years = (now - b) / (365.25 * 24 * 3600 * 1000);
  }
  if (isNaN(years)) return '';
  if (years < 1) return 'Infants';
  if (years < 3) return 'Toddlers';
  if (years < 5) return 'Pre-K';
  return 'School-Age';
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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));

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

  const token = process.env.GHL_PIT_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) {
    console.error('GHL not configured (GHL_PIT_TOKEN / GHL_LOCATION_ID missing)');
    return res.status(500).send('Our system is not fully set up yet. Please call (215) 236-5439.');
  }

  const loc = LOCATIONS[b.location] || { name: b.location, address: '', tag: 'loc-unknown' };
  const locLabel = loc.address ? `${loc.name} — ${loc.address}` : loc.name;
  const classroom = deriveClassroom(b.studentAge, b.studentDob);

  // Contact identity is the CHILD's name (staff look records up by kid name, not
  // parent name); the parent's name is preserved in its own custom field below.
  const parts = String(b.studentName || '').trim().split(/\s+/);
  const firstName = parts[0] || String(b.studentName || '');
  const lastName = parts.slice(1).join(' ');

  // form-type tag is the explicit, self-describing marker: this form is filled out
  // by families ALREADY at one of the centers, updating their info into the system —
  // never a brand-new inquiry. (New inquiries only ever come from the marketing
  // site's Website Enrollment Form, tagged form-type-new-inquiry in enroll.js.)
  const tags = ['existing-student', 'enrolled', 'family-contact-form', 'form-type-existing-family', loc.tag];
  if (classroom && GROUP_TAG[classroom]) tags.push(GROUP_TAG[classroom]);

  const customFields = [
    { id: F.childName, value: b.studentName },
    { id: F.parentName, value: b.parentName },
    { id: F.preferredLocation, value: locLabel },
    { id: F.enrollStatus, value: 'Enrolled' },
    { id: F.emergencyName, value: b.emergencyName },
    { id: F.emergencyPhone, value: b.emergencyPhone },
    { id: F.emergencyRelationship, value: b.emergencyRelationship },
  ];
  if (b.studentDob) customFields.push({ id: F.childDob, value: b.studentDob });
  if (b.studentAge) customFields.push({ id: F.childAge, value: b.studentAge });
  if (b.parentRelationship) customFields.push({ id: F.parentRelationship, value: b.parentRelationship });
  if (classroom) customFields.push({ id: F.classroom, value: classroom });
  if (b.smsConsent === 'yes') customFields.push({ id: F.smsConsent, value: new Date().toISOString().slice(0, 10) });

  // Durable ad attribution, written the same way the enrollment form writes it.
  const a = parseAttr(b.attr) || {};
  const adSource = [a.utm_source, a.utm_medium].filter(Boolean).join(' / ') ||
    (a.fbclid ? 'facebook / paid' : a.gclid ? 'google / paid' : '');
  const adContent = [a.utm_content, a.utm_term].filter(Boolean).join(' | ');
  for (const [id, value] of [
    [F.adCampaign, a.utm_campaign],
    [F.adSource, adSource],
    [F.adContent, adContent],
    [F.adClickId, a.fbclid || a.gclid],
  ]) if (value) customFields.push({ id, value });

  const upsert = await ghl('/contacts/upsert', 'POST', token, {
    locationId,
    name: b.studentName,
    firstName,
    lastName,
    email: b.parentEmail,
    phone: toE164(b.parentPhone),
    source: 'Family Contact Form',
    tags,
    customFields,
  });

  if (!upsert.ok) {
    console.error('GHL upsert failed', upsert.status, JSON.stringify(upsert.data));
    return res.status(500).send('Unable to save right now. Please call (215) 236-5439 or try again in a moment.');
  }

  const contactId = upsert.data && upsert.data.contact && upsert.data.contact.id;

  // Source tag, applied AFTER the upsert and derived from the MERGED fields on
  // its response. /contacts/upsert replaces the tags array but merges
  // customFields, so a tag written on an earlier submission is already gone while
  // the ad fields still hold first touch. Deriving it from the merged fields is
  // what stops a family who first arrived from an ad being downgraded to
  // source-organic when they update their details later. POST /tags adds without
  // replacing, so it leaves the tags above alone.
  if (contactId) {
    const tag = sourceTag(
      mergedField(upsert.data.contact, F.adSource),
      mergedField(upsert.data.contact, F.adClickId),
    );
    const st = await ghl(`/contacts/${contactId}/tags`, 'POST', token, { tags: [tag] });
    // Not fatal — the family's record is already saved; only the reporting tag is missing.
    if (!st.ok) console.error('GHL source tag failed', st.status, JSON.stringify(st.data));
    else console.log(`[source] ${contactId} tagged ${tag}`);
  }

  // Note with the full intake (best-effort — never blocks success).
  if (contactId) {
    const note = await ghl(`/contacts/${contactId}/notes`, 'POST', token, { body: summaryText(b, locLabel) });
    if (!note.ok) console.error('GHL note failed', note.status, JSON.stringify(note.data));
  }

  await notifyEmail(b, locLabel, loc.name);

  return res.status(200).json({ ok: true, contactId: contactId || null });
};
