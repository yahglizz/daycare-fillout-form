# daycare-fillout-form

Family Contact Form for **A Touch of Blessings** — used to integrate **existing students**
into the GHL CRM, organized by location. Parents fill it out; each submission upserts a
GHL contact (no sales opportunity — these are current students, not leads).

## How it works
- `index.html` — static form (child, location, parent, emergency contact, authorized pickup
  people, notes, SMS consent). Submits JSON to `/api/submit`.
- `api/submit.js` — Vercel serverless function. Upserts the contact into GHL location
  `4JIvZEmkY5EjTsDRnjBN`, tags + organizes by location, fills custom fields, and writes a
  Note with the full intake. Dependency-free (Node 18+ `fetch`).

## CRM mapping
- **Tags:** `existing-student`, `enrolled`, `family-contact-form`, one location tag
  (`loc-921-n-18th` / `loc-2318-cecil-b-moore` / `loc-1923-cecil-b-moore`), classroom group.
- **Custom fields:** Child Name, Child DOB, Child Age, Preferred Location, Parent Relationship,
  Emergency Contact Name/Phone/Relationship, Enrollment Status = `Enrolled`, SMS Consent.
- **Note:** full formatted intake incl. emergency contact + every authorized-pickup person.

## Environment variables (Vercel project)
| Var | Value | Secret |
|-----|-------|--------|
| `GHL_LOCATION_ID` | `4JIvZEmkY5EjTsDRnjBN` | no |
| `GHL_PIT_TOKEN` | daycare GHL Private Integration Token (`pit-…`) | **yes** |
| `NOTIFY_EMAIL` | *(optional)* management@atouchofblessing.com — enables email alerts | no |
| `RESEND_API_KEY` | *(optional)* Resend key, required only if `NOTIFY_EMAIL` set | yes |
| `RESEND_FROM` | *(optional)* verified sender | no |

| `BLOB_READ_WRITE_TOKEN` | auto-added by connecting the private Blob store `atob-family-forms` | yes |
| `FAMILY_FORMS_READ_KEY` | bearer key for `/api/family-forms`; same value as `FAMILY_FORMS_READ_KEY` in the dashboard's `daycare.env` | **yes** |
| `FAMILY_PDF_ENABLED` | *(optional)* set `false` to stop rendering/storing PDFs (email + GHL unaffected) | no |

Email notification is **OFF** unless both `RESEND_API_KEY` and `NOTIFY_EMAIL` are set.

## Stored PDF copy (added 2026-10-09)
Every real submission (not the 555-01xx + example.com health-check pair) is rendered to a PDF by
`api/_pdf.js` (no dependencies), attached to the staff email, and written to the **private** Blob store as
`family-forms/<atob|amt>/<YYYY-MM>/<UTC stamp>__<contactId>__<child>__<parent>.pdf`. One file per submission,
never overwritten, kept indefinitely (no delete code). `api/family-forms.js` is the bearer-key read endpoint
the FORGE REI OS dashboard uses (Daycare -> Family Forms). A Blob outage costs only the dashboard copy;
the email and GHL note still go out. ATOB and A Mother's Touch are separate folders and separate letterheads.
Tests: `node --test test/pdf.test.js test/family.test.js`.
