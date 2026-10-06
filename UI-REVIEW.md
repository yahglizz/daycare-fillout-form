# Family forms UI review — October 5, 2026

Both forms use `forms.css`, Playfair Display headings and DM Sans controls/body, binding web palette, cream page background, purple form intro and primary action, and gold accent rules. Desktop pairs fields; 375px layouts stack them. Uniform sizes have equal hierarchy with other sections. Existing SVG section drawings remain lightweight; header and thank-you art were generated, documented under `assets/README.md`. All three WebP assets total 48,988 bytes. A Mother's Touch remains a separate branded form with its own single preselected location; no logo was invented. A real AMT mark is still needed.

## Preserved contract

Compared with original sources: all field names, input types, option values, existing IDs, required/checked states, honeypot, SMS consent text and complete submission payload unchanged. `api/submit.js`, CRM mappings, tags, email templates and production CSP untouched. Both scripts passed `node --check`.

Presentation additions: native-validity inline messages, visible keyboard focus, explicit labels and unique IDs for dynamic pickup rows, focus on new pickup rows and success, reduced-motion scroll handling, and reset clears visible errors. Original collection, attribution, endpoint and submission flow retained.

## Browser checks

Chromium, production CSP applied by local preview server:

- Both forms at 375 / 768 / 1280: document width equals viewport width, no horizontal overflow; mobile grids single-column, larger widths two-column.
- Native required-field errors display inline and clear after correction.
- Add three pickup people, remove middle person, verify numbering and payload.
- Shirt `3T` and pants `4T` select and retain correct payload values.
- Intercept `/api/submit` locally: Saving… + disabled state, simulated 500 error + enabled retry, simulated 200 success, Add another child resets fields/people/errors. No real CRM write occurred.
- Keyboard Tab advances from child's name to date of birth; visible focus outline verified.
- Reduced-motion preference respected. No page script errors or CSP violations. Deliberate simulated API 500s produce expected browser resource errors.

Screenshots and interactive review gallery: workspace `output/playwright/index.html`. Includes both forms at all three widths, full phone form, and full thank-you state.

## Release boundary

No commit, push or deployment performed. Handoff §7 requires owner local review and “go” before release. Live CRM contact/note and notification email verification are pending authorized release testing; static preview and mocked responses do not verify backend delivery.
