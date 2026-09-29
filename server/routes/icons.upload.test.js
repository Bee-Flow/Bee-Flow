/**
 * Icon upload — stored-XSS regression.
 *
 * POST /api/icons/upload used bare multer.diskStorage with
 * `path.extname(file.originalname)` as the stored extension and a fileFilter
 * that only checked the CLIENT-DECLARED `file.mimetype.startsWith('image/')`.
 * `router.use('/data', express.static(uploadDir))` then served those bytes back
 * with a Content-Type derived from that attacker-chosen extension, on the
 * application origin — so `payload.svg` containing `<script>` (or
 * `payload.html` declared as image/png) was stored verbatim and executed in the
 * session of any logged-in user who opened the returned URL.
 *
 * The route now runs through middleware/uploadGuard (magic-byte sniffing +
 * utils/svgSanitizer for SVG), names the file from the VERIFIED mime, and the
 * static mount sends `nosniff` + a sandbox CSP so files written by the old code
 * path are neutralised too.
 *
 * These tests drive a real HTTP server because multipart parsing needs a real
 * request stream; no database is involved (every store is stubbed).
 *
 * Run: cd server && node --test routes/icons.upload.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const path = require('path');

const MOCKS = {
    '../auth/permissions': { requireAuth: (req, res, next) => next() },
    '../stores/iconStore': {},
    '../stores/userStore': {},
    '../stores/configStore': { getSecret: async () => null },
    '../core/providers': { googleAdapter: { generateImage: async () => ({}) } },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:icons-upload:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]icons\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./icons');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'icons');
const created = [];

const app = express();
app.use((req, _res, next) => { req.session = { isAuthenticated: true, user: { id: 'u1' } }; next(); });
app.use('/api/icons', router);

let server;
let base;

test.before(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    if (server) server.close();
    Module._resolveFilename = originalResolve;
    for (const f of created) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch { /* already gone */ } }
});

async function upload(filename, mimetype, body) {
    const fd = new FormData();
    fd.append('icon', new Blob([body], { type: mimetype }), filename);
    const r = await fetch(`${base}/api/icons/upload`, { method: 'POST', body: fd });
    const json = await r.json().catch(() => ({}));
    if (json.url) created.push(json.url.split('/').pop());
    return { status: r.status, json };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const XSS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">'
    + '<script>fetch("/api/agents").then(r=>r.text())</script>'
    + '<a xlink:href="https://evil.example/x"><circle r="5"/></a></svg>';

// ═══ The XSS payloads ════════════════════════════════════════════════

test('an SVG with a <script> and an onload handler is stored sanitized', async () => {
    const { status, json } = await upload('payload.svg', 'image/svg+xml', XSS_SVG);
    assert.strictEqual(status, 200, 'a real SVG is still a legal icon');
    assert.ok(json.url, 'a url is returned');

    const res = await fetch(base + json.url);
    const served = await res.text();
    assert.ok(!served.includes('<script'), 'the script element is gone');
    assert.ok(!/\bonload\s*=/i.test(served), 'the event handler is gone');
    assert.ok(!served.includes('evil.example'), 'the external reference is gone');
    assert.ok(served.includes('<svg'), 'it is still an SVG');
});

test('an HTML file declared as image/png is rejected (415), not stored', async () => {
    const { status, json } = await upload(
        'payload.html', 'image/png',
        '<html><body><script>alert(document.cookie)</script></body></html>',
    );
    assert.strictEqual(status, 415, 'magic bytes do not match the declared type');
    assert.strictEqual(json.url, undefined, 'nothing was stored');
});

test('an HTML file declared as image/svg+xml is rejected too', async () => {
    const { status, json } = await upload(
        'payload.html', 'image/svg+xml',
        '<html><body><script>alert(1)</script></body></html>',
    );
    assert.strictEqual(status, 415);
    assert.strictEqual(json.url, undefined);
});

test('a non-image type is rejected with 415', async () => {
    const { status } = await upload('note.txt', 'text/plain', 'hello');
    assert.strictEqual(status, 415);
});

// ═══ The filename no longer comes from the client ════════════════════

test('the stored extension is derived from the verified mime, not originalname', async () => {
    const { status, json } = await upload('pwn.html', 'image/png', PNG);
    assert.strictEqual(status, 200, 'the bytes really are a PNG');
    assert.ok(json.url.endsWith('.png'), `expected a .png name, got ${json.url}`);
    assert.ok(!json.url.includes('.html'), 'the client-supplied extension is discarded');
});

test('a traversal-shaped originalname cannot escape the upload directory', async () => {
    const { status, json } = await upload('../../pwn.png', 'image/png', PNG);
    assert.strictEqual(status, 200);
    const stored = json.url.split('/').pop();
    assert.ok(/^icon-\d+-[0-9a-f]{16}\.png$/.test(stored), `unexpected stored name: ${stored}`);
    assert.ok(fs.existsSync(path.join(UPLOAD_DIR, stored)), 'it landed inside the icon directory');
});

// ═══ Serving hardening (also covers files the old code already wrote) ═

test('/data responses carry nosniff and a sandbox CSP, and icons stay inline', async () => {
    const { json } = await upload('ok.png', 'image/png', PNG);
    const res = await fetch(base + json.url);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /sandbox/, 'sandbox stops script execution regardless of Content-Type');
    assert.match(csp, /default-src 'none'/);
    assert.strictEqual(res.headers.get('content-disposition'), 'inline',
        'a real icon still renders — the Appearance UI loads these as <img>');
});

test('a hostile file left on disk by the OLD upload path is served neutralised', async () => {
    // Simulate the pre-fix artefacts: files the old diskStorage let through.
    const legacySvg = `icon-legacy-${Date.now()}.svg`;
    const legacyHtml = `icon-legacy-${Date.now()}.html`;
    created.push(legacySvg, legacyHtml);
    fs.writeFileSync(path.join(UPLOAD_DIR, legacySvg), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    fs.writeFileSync(path.join(UPLOAD_DIR, legacyHtml), '<html><script>alert(1)</script></html>');

    const svg = await fetch(`${base}/api/icons/data/${legacySvg}`);
    assert.strictEqual(svg.status, 200, 'still served — existing icons must not 404');
    assert.strictEqual(svg.headers.get('x-content-type-options'), 'nosniff');
    assert.match(svg.headers.get('content-security-policy') || '', /sandbox/);

    const html = await fetch(`${base}/api/icons/data/${legacyHtml}`);
    assert.strictEqual(html.headers.get('content-disposition'), 'attachment',
        'a legacy .html downloads instead of rendering');
    assert.match(html.headers.get('content-security-policy') || '', /sandbox/);
});

test('the size cap is still enforced', async () => {
    const tooBig = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
    const { status } = await upload('big.png', 'image/png', tooBig);
    assert.strictEqual(status, 413);
});

test('a request with no file is a 400', async () => {
    const r = await fetch(`${base}/api/icons/upload`, { method: 'POST', body: new FormData() });
    assert.strictEqual(r.status, 400);
});
