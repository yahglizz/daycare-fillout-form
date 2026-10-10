// Read-only window onto the private Blob store of Family Contact Form PDFs, for the
// FORGE REI OS dashboard (which lives on a tailnet-only box and cannot read Blob itself).
//
//   GET /api/family-forms                 -> { ok, forms: [{ path, brand, submittedAt, ... }] }
//   GET /api/family-forms?path=<pathname> -> the PDF bytes
//
// Bearer-key gated (FAMILY_FORMS_READ_KEY); every failure is a bare 401/404 so the
// endpoint says nothing to a stranger. The path is matched against the exact shape
// submit.js writes, so it can never read anything else in the store.
const { timingSafeEqual } = require('node:crypto');
const { parsePath } = require('./_pdf');

function authed(req) {
  const key = process.env.FAMILY_FORMS_READ_KEY || '';
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (key.length < 32 || got.length !== key.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(key));
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
  if (!authed(req)) return res.status(401).json({ ok: false });

  const { list, get } = require('@vercel/blob');
  try {
    const wanted = req.query && req.query.path;
    if (wanted) {
      if (!parsePath(wanted)) return res.status(404).json({ ok: false });
      const hit = await get(wanted, { access: 'private' });
      if (!hit || hit.statusCode !== 200) return res.status(404).json({ ok: false });
      const buf = Buffer.from(await new Response(hit.stream).arrayBuffer());
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(buf);
    }

    const forms = [];
    let cursor;
    do {
      const page = await list({ prefix: 'family-forms/', limit: 1000, cursor });
      for (const blob of page.blobs) {
        const f = parsePath(blob.pathname);
        if (f) forms.push({ ...f, size: blob.size });
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor && forms.length < 5000); // ponytail: 5000 forms is years of intake; paginate the dashboard past that
    forms.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
    return res.status(200).json({ ok: true, forms });
  } catch (err) {
    console.error('[family-forms] read failed', err && err.message);
    return res.status(502).json({ ok: false });
  }
}

module.exports = handler;
