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

Email notification is **OFF** unless both `RESEND_API_KEY` and `NOTIFY_EMAIL` are set.
