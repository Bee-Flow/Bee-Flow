// Public certificate verification — unauthenticated /verify/:token.
//
// Mounted before the SPA catch-all in index.js. Resolves a Bee Flow AI certificate
// from the public lookup index (only PUBLIC certs are indexed) and renders a small
// server-side page with og: meta so LinkedIn shows a rich preview. Also serves the
// certificate image (og:image) and a print PDF at the same token. Modeled on
// publicViewer.js: per-IP rate limiting, strict CSP, no React/LicenseProvider, and
// it NEVER exposes the recipient's email.
//
// NO zod schema, deliberately. These are pages a browser or a link-preview
// crawler NAVIGATES to, not calls an app makes:
//   - the query belongs to whoever shared the link — LinkedIn and mail clients
//     append their own tracking parameters — so a `.strict()` query would turn
//     a shared certificate into an error page;
//   - a refusal has to be the HTML not-found page (or a bare 404 for the image
//     and PDF), and validate() answers with a JSON 400 from the terminal
//     handler, which a visitor would see as raw JSON.
// The one input, the token on the path, is checked in resolve(): not a string
// or shorter than 16 characters is the same not-found as an unknown token.

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const certStore = require('../stores/certificateStore');
const { tokenHash } = require('../auth/certificateToken');
const { getPublicBaseUrl } = require('../learning/certificates');
const { renderCertificatePng, renderCertificatePdf } = require('../services/certificateRenderer');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

const limiter = perUserRateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => req.ip });

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); }
    catch (_) { return ''; }
}

function setSecurityHeaders(res) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
}

async function resolve(token) {
    if (!token || typeof token !== 'string' || token.length < 16) return null;
    try { return await certStore.resolveByTokenHash(tokenHash(token)); }
    catch (_) { return null; }
}

function notFoundPage(res) {
    setSecurityHeaders(res);
    return res.status(404).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Certificate not found · Bee Flow</title><style>body{font-family:system-ui,sans-serif;background:#FFFDF7;color:#1A1A1A;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}div{max-width:420px;padding:24px}h1{color:#B45309}</style></head><body><div><h1>🐝 Certificate not found</h1><p>This verification link isn’t valid, or the certificate is no longer shared publicly.</p></div></body></html>`);
}

// ── Image (og:image) ──────────────────────────────────────────────────────────
router.get('/:token/image.png', limiter, async (req, res) => {
    const record = await resolve(req.params.token);
    if (!record || !record.isPublic) { res.status(404).end(); return; }
    try {
        const base = getPublicBaseUrl();
        const verifyUrl = base ? `${base}/verify/${req.params.token}` : null;
        const png = await renderCertificatePng(record, { verifyUrl });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(png);
    } catch (e) {
        log.error('[verify image] failed:', e.message);
        res.status(500).end();
    }
});

// ── PDF ───────────────────────────────────────────────────────────────────────
router.get('/:token/certificate.pdf', limiter, async (req, res) => {
    const record = await resolve(req.params.token);
    if (!record || !record.isPublic) { res.status(404).end(); return; }
    try {
        const base = getPublicBaseUrl();
        const verifyUrl = base ? `${base}/verify/${req.params.token}` : null;
        const pdf = await renderCertificatePdf(record, { verifyUrl });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="beeflow-certificate-${record.serial}.pdf"`);
        res.send(pdf);
    } catch (e) {
        log.error('[verify pdf] failed:', e.message);
        res.status(500).end();
    }
});

// ── Verify page (HTML + og: meta) ───────────────────────────────────────────────
// The public page of the Learning Center handoff (artboard 1e, right half): a
// verification chip with the check time, the certificate card, a holder /
// issuer / requirements grid, and one footnote. It shows ONLY what the holder
// made public — name, certificate, date, organisation, the courses — never the
// serial, never progress. Tokens are inlined because this page carries no
// app CSS; light and dark follow the visitor's colour scheme.
router.get('/:token', limiter, async (req, res) => {
    const record = await resolve(req.params.token);
    if (!record || !record.isPublic) return notFoundPage(res);

    const base = getPublicBaseUrl();
    const imgUrl = base ? `${base}/verify/${req.params.token}/image.png` : `/verify/${req.params.token}/image.png`;
    const pdfUrl = `/verify/${req.params.token}/certificate.pdf`;
    const courseTitles = (record.courses || []).map((c) => esc(c.title));
    const desc = `${esc(record.recipientName)} earned the ${esc(record.title)} certificate from Bee Flow.`;
    const checkedAt = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    const shortToken = String(req.params.token).slice(0, 4) + '…' + String(req.params.token).slice(-4);
    const level = record.level ? esc(record.level) : esc(record.title);
    const issuer = record.orgName ? `${esc(record.orgName)} via Bee Flow` : 'Bee Flow';

    setSecurityHeaders(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(record.title)} · Bee Flow</title>
<meta property="og:title" content="${esc(record.title)}"/>
<meta property="og:description" content="${esc(desc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:image" content="${esc(imgUrl)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<style>
  :root{color-scheme:light dark;--bg-primary:#fafafa;--bg-card:#fff;--bg-secondary:#f3f3f3;--text-primary:#111827;--text-secondary:#4b5563;--text-tertiary:#6b7280;--border:rgba(0,0,0,.12);--accent:#d97706;--accent-ink:#8a5a00;--complete:#15803d;--shadow:0 1px 2px rgba(0,0,0,.06)}
  @media (prefers-color-scheme:dark){:root{--bg-primary:#0f0f13;--bg-card:#1a1a24;--bg-secondary:#16161d;--text-primary:#f8fafc;--text-secondary:#94a3b8;--text-tertiary:#8b9bb0;--border:rgba(255,255,255,.1);--accent:#f59e0b;--accent-ink:#fbbf24;--complete:#4ade80;--shadow:0 1px 2px rgba(0,0,0,.3)}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;font-size:12px;background:var(--bg-primary);color:var(--text-primary)}
  header{height:48px;display:flex;align-items:center;gap:8px;padding:0 20px;border-bottom:1px solid var(--border);background:var(--bg-card)}
  header .brand{font-weight:600;font-size:13px}header .sub{font-size:11px;color:var(--text-tertiary)}
  header code{margin-left:auto;font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;color:var(--text-tertiary)}
  main{flex:1;display:flex;align-items:center;justify-content:center;padding:24px 16px}
  .card{width:100%;max-width:440px;border-radius:12px;background:var(--bg-card);border:1px solid var(--border);box-shadow:var(--shadow);padding:18px 20px;display:flex;flex-direction:column;gap:14px}
  .chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;background:color-mix(in srgb,var(--complete) 12%,transparent);color:var(--complete);font-weight:600;font-size:11px}
  .row{display:flex;align-items:center;gap:8px}.row .when{font-size:11px;color:var(--text-tertiary)}
  .cert{border:1px solid var(--border);border-radius:10px;overflow:hidden;position:relative}
  .cert .bar{height:6px;background:var(--accent)}
  .cert .body{padding:14px 16px;display:flex;flex-direction:column;gap:5px}
  .cert .eyebrow{font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:600;color:var(--text-tertiary)}
  .cert .level{font-size:20px;font-weight:700;line-height:24px}
  .cert .who{font-size:14px;font-weight:600;margin-top:2px}.cert .org{font-size:11px;color:var(--text-tertiary)}
  .cert .seal{position:absolute;right:16px;bottom:14px;width:40px;height:40px;border-radius:50%;border:2px solid var(--accent);color:var(--accent-ink);display:grid;place-items:center;font-size:18px}
  dl{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;margin:0;color:var(--text-secondary)}
  dt{color:var(--text-tertiary)}dd{margin:0}dd.who{color:var(--text-primary);font-weight:500}
  .foot{font-size:11px;color:var(--text-tertiary);border-top:1px solid var(--border);padding-top:10px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
  a.dl{color:var(--accent-ink);font-weight:600;text-decoration:none}
</style></head>
<body>
  <header><span aria-hidden="true">🐝</span><span class="brand">Bee Flow</span><span class="sub">· certificate verification</span><code>/verify/${esc(shortToken)}</code></header>
  <main>
    <div class="card">
      <div class="row"><span class="chip">✓ Verified · valid</span><span class="when">checked ${esc(checkedAt)}</span></div>
      <div class="cert">
        <div class="bar"></div>
        <div class="body">
          <div class="eyebrow">Bee Flow AI Certified</div>
          <div class="level">${level}</div>
          <div class="who">${esc(record.recipientName)}</div>
          <div class="org">${record.orgName ? `${esc(record.orgName)} · ` : ''}${esc(fmtDate(record.issuedAt))}</div>
        </div>
        <div class="seal" aria-hidden="true">🏅</div>
      </div>
      <dl>
        <dt>Holder</dt><dd class="who">${esc(record.recipientName)}</dd>
        <dt>Issued by</dt><dd>${issuer}</dd>
        <dt>Requirements</dt><dd>${courseTitles.length ? `${courseTitles.join(' · ')} — all complete` : esc(record.title)}</dd>
      </dl>
      <div class="foot"><span>No login needed. This page shows only what the holder made public — no serial number, no progress.</span><a class="dl" href="${esc(pdfUrl)}">Download PDF</a></div>
    </div>
  </main>
</body></html>`);
});

module.exports = router;
