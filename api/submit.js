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
};

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

// Optional email notification (OFF unless RESEND_API_KEY + NOTIFY_EMAIL are set).
async function notifyEmail(b, locLabel) {
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
        subject: `Student Intake — ${b.studentName} (${locLabel})`,
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

  const tags = ['existing-student', 'enrolled', 'family-contact-form', loc.tag];
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

  // Note with the full intake (best-effort — never blocks success).
  if (contactId) {
    const note = await ghl(`/contacts/${contactId}/notes`, 'POST', token, { body: summaryText(b, locLabel) });
    if (!note.ok) console.error('GHL note failed', note.status, JSON.stringify(note.data));
  }

  await notifyEmail(b, locLabel);

  return res.status(200).json({ ok: true, contactId: contactId || null });
};
