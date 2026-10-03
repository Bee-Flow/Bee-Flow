/**
 * The wallpaper upload and its public serve (routes/branding.js).
 *
 * The upload believed the part's declared type and kept the CLIENT's file
 * extension, so `image/png` declared with a name of `x.html` was stored as
 * `wallpaper-….html` — and GET /api/branding/wallpaper/:filename, which needs
 * no session, served it as text/html from the app's own origin, under a page
 * CSP that allows inline script. requireAdmin passes on `manage_users`, which
 * every organisation admin holds.
 *
 * Pinned here, through real multipart requests:
 *
 *   - the stored extension is the TYPE's, never the name's;
 *   - only raster types are accepted — not HTML, not SVG — as a 400, and a
 *     file over the cap as a 413, where a filter error used to be a 500;
 *   - every wallpaper is served nosniff and sandboxed, whatever it is.
 *
 * Files this test uploads land in server/data/wallpapers (gitignored) and
 * are removed afterwards.
 *
 * Run: cd server && node --test routes/branding.wallpaper.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Module = require('module');

const stored = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../auth/permissions': { requireAuth: pass, requireAdmin: pass },
    '../stores/brandingStore': {
        getWallpaperFilename: async () => null,
        setWallpaperFilename: async (name) => { stored.push(name); return name; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:branding-wallpaper:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]branding\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./branding');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'wallpapers');
let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use('/api/branding', router);
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    Module._resolveFilename = originalResolve;
    for (const name of stored) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
    await new Promise((resolve) => server.close(resolve));
});

// A PNG signature and a few bytes — enough for multer, which reads no further.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

async function upload(bytes, type, name) {
    const form = new FormData();
    form.append('wallpaper', new Blob([bytes], { type }), name);
    const res = await fetch(`${baseUrl}/api/branding/wallpaper`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
}

test('a PNG named x.html is stored as .png — the extension is the type\'s, never the name\'s', async () => {
    const res = await upload(PNG, 'image/png', 'x.html');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.filename, /^wallpaper-\d+-\d+\.png$/);
    assert.ok(fs.existsSync(path.join(UPLOAD_DIR, res.body.filename)));
});

test('an HTML file is refused as a 400, not stored and not a 500', async () => {
    const before = stored.length;
    const res = await upload(Buffer.from('<script>alert(1)</script>'), 'text/html', 'x.html');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'A wallpaper is a PNG, JPEG, WebP, GIF or AVIF image.');
    assert.strictEqual(res.body.code, 'bad_wallpaper');
    assert.strictEqual(stored.length, before);
});

test('an SVG is refused too — it is an image a browser also runs script in', async () => {
    const res = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', 'w.svg');
    assert.strictEqual(res.status, 400);
});

test('a file over the cap is a 413 that says what the cap is', async () => {
    const before = stored.length;
    const res = await upload(Buffer.alloc(5 * 1024 * 1024 + 1, 1), 'image/png', 'big.png');
    assert.strictEqual(res.status, 413);
    // The route's own HttpError: its message reaches the person (the terminal
    // handler keeps the generic sentence for the body parser's refusal only).
    assert.strictEqual(res.body.error, 'A wallpaper is at most 5 MB.');
    assert.strictEqual(stored.length, before);
});

test('a served wallpaper is nosniff and sandboxed — whatever an older upload turns out to be', async () => {
    const planted = `wallpaper-legacy-${process.pid}.html`;
    fs.writeFileSync(path.join(UPLOAD_DIR, planted), '<script>alert(1)</script>');
    stored.push(planted);
    const res = await fetch(`${baseUrl}/api/branding/wallpaper/${planted}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
    await res.arrayBuffer();
});

test('an uploaded wallpaper is served back as the image it was stored as', async () => {
    const up = await upload(PNG, 'image/png', 'photo.png');
    assert.strictEqual(up.status, 200);
    const res = await fetch(`${baseUrl}${up.body.url}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), PNG);
});
