/**
 * receiveImage (middleware/uploadedImage.js) and the /uploads mount that
 * serves what it stores (boot/staticAssets.js), through real multipart
 * requests against a bare Express app — no module mocks.
 *
 * Pinned here:
 *
 *   - the stored extension is the TYPE's, read from the bytes, never the name's;
 *   - bytes that do not match the declared type are refused as a 415, not stored;
 *   - a type outside the route's allow-list is refused as a 415;
 *   - an SVG is stored sanitised (no script element survives);
 *   - every file under /uploads is served nosniff and sandboxed; the image
 *     extensions render inline, anything else downloads.
 *
 * Files this test writes land in server/data/uploads (gitignored) and are
 * removed afterwards.
 *
 * Run: cd server && node --test middleware/uploadedImage.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const { receiveImage, UPLOADS_DIR } = require('./uploadedImage');
const { mountStaticAssets } = require('../boot/staticAssets');

const written = [];
let server;
let baseUrl;
let counter = 0;

test.before(async () => {
    const app = express();
    mountStaticAssets(app, { log: { info() {} } });
    app.post('/pic', receiveImage({
        field: 'pic',
        allow: ['image/png', 'image/svg+xml'],
        name: () => `test-pic-${process.pid}-${++counter}`,
    }), (req, res) => {
        written.push(req.file.filename);
        res.json({ filename: req.file.filename, mimetype: req.file.mimetype });
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    for (const name of written) fs.rmSync(path.join(UPLOADS_DIR, name), { force: true });
    await new Promise((resolve) => server.close(resolve));
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const SVG_WITH_SCRIPT = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(1)</script><rect width="8" height="8"/></svg>');

async function upload(bytes, type, name) {
    const form = new FormData();
    form.append('pic', new Blob([bytes], { type }), name);
    const res = await fetch(`${baseUrl}/pic`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
}

test('a PNG named x.html is stored as .png — the extension is the type\'s, never the name\'s', async () => {
    const res = await upload(PNG, 'image/png', 'x.html');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.filename, /^test-pic-\d+-\d+\.png$/);
    assert.deepStrictEqual(fs.readFileSync(path.join(UPLOADS_DIR, res.body.filename)), PNG);
});

test('HTML bytes declared image/png are refused as a 415 and not stored', async () => {
    const before = written.length;
    const res = await upload(Buffer.from('<script>alert(1)</script>'), 'image/png', 'x.png');
    assert.strictEqual(res.status, 415);
    assert.strictEqual(written.length, before);
});

test('a declared type outside the allow-list is refused as a 415', async () => {
    const res = await upload(Buffer.from('GIF89a'), 'image/gif', 'x.gif');
    assert.strictEqual(res.status, 415);
    const html = await upload(Buffer.from('<p>hi</p>'), 'text/html', 'x.html');
    assert.strictEqual(html.status, 415);
});

test('an SVG is stored sanitised: no script element survives', async () => {
    const res = await upload(SVG_WITH_SCRIPT, 'image/svg+xml', 'logo.svg');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.filename, /\.svg$/);
    // What is served back is what was stored: the sanitised document.
    const served = await fetch(`${baseUrl}/uploads/${res.body.filename}`);
    assert.strictEqual(served.status, 200);
    const body = await served.text();
    assert.ok(!body.toLowerCase().includes('<script'), body);
    assert.ok(body.toLowerCase().includes('<svg'));
});

test('a stored image is served back inline, nosniff and sandboxed', async () => {
    const up = await upload(PNG, 'image/png', 'photo.png');
    assert.strictEqual(up.status, 200);
    const res = await fetch(`${baseUrl}/uploads/${up.body.filename}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
    assert.strictEqual(res.headers.get('content-disposition'), 'inline');
    assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), PNG);
});

test('a file under /uploads outside the image extensions downloads instead of rendering', async () => {
    const planted = `test-pic-legacy-${process.pid}.html`;
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, planted), '<script>alert(1)</script>');
    written.push(planted);
    const res = await fetch(`${baseUrl}/uploads/${planted}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
    assert.strictEqual(res.headers.get('content-disposition'), 'attachment');
    await res.arrayBuffer();
});
