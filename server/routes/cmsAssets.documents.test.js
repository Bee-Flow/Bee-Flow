/**
 * CMS documents (PDF, DOCX, XLSX, PPTX) on the admin uploader and the public asset stream
 * (routes/cmsAssets.js): checked on their bytes, stored under the extension of their type, and
 * always served as a download (Content-Disposition: attachment) with nosniff. Images and video
 * stay inline. The storage store is stubbed with mock.method, the handlers run on real HTTP.
 *
 * Run: node --test routes/cmsAssets.documents.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mock } = require('node:test');
const { Readable } = require('node:stream');
const express = require('express');
const JSZip = require('jszip');

const storageStore = require('../stores/storageStore');
const { uploadFile, handleUpload, serveAsset } = require('./cmsAssets');

const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** @type {Map<string, { buf: Buffer, contentType: string }>} */
const objects = new Map();

mock.method(storageStore, 'isAvailable', () => true);
mock.method(storageStore, 'uploadFile', async (/** @type {string} */ key, /** @type {Buffer} */ buf, /** @type {string} */ contentType) => {
    objects.set(key, { buf: Buffer.from(buf), contentType });
    return { key };
});
mock.method(storageStore, 'headFile', async (/** @type {string} */ key) => {
    const o = objects.get(key);
    if (!o) throw Object.assign(new Error('nope'), { name: 'NoSuchKey' });
    return { contentLength: o.buf.length, contentType: o.contentType, etag: 'e' };
});
mock.method(storageStore, 'streamFile', async (/** @type {string} */ key) => {
    const o = objects.get(key);
    if (!o) throw Object.assign(new Error('nope'), { name: 'NoSuchKey' });
    return { stream: Readable.from([o.buf]), contentType: o.contentType, contentLength: o.buf.length, metadata: {} };
});

/** @type {http.Server} */
let server;
let base = '';

test.before(async () => {
    const app = express();
    app.post('/upload', uploadFile, handleUpload);
    app.get(/^\/asset\/(.+)$/, serveAsset);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
    base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});
test.after(() => new Promise((resolve) => server.close(() => resolve(null))));
test.beforeEach(() => objects.clear());

/** @param {Buffer} buf @param {string} filename @param {string} type */
async function upload(buf, filename, type) {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type }), filename);
    const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
    return { status: res.status, body: await res.json() };
}

test('a PDF uploads under a .pdf key, whatever the file was called', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n');
    const { status, body } = await upload(pdf, 'policy.vtt', PDF);
    assert.equal(status, 200);
    assert.match(body.key, /^cms\/\d+-\d+-policy\.pdf$/);
    assert.equal(objects.get(body.key)?.contentType, PDF);
});

test('a document whose bytes are something else is refused and nothing is stored', async () => {
    const { status, body } = await upload(Buffer.from('<html><script>alert(1)</script></html>'), 'x.pdf', PDF);
    assert.equal(status, 400);
    assert.match(body.error, /not a valid PDF, Word, Excel or PowerPoint file/);
    assert.equal(objects.size, 0);
});

test('a document is served as a download with nosniff; an image stays inline', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('xl/workbook.xml', '<workbook/>');
    const xlsx = await zip.generateAsync({ type: 'nodebuffer' });
    const up = await upload(xlsx, 'Budget 2026.xlsx', XLSX);
    assert.equal(up.status, 200);

    const doc = await fetch(`${base}/asset/${up.body.key}`);
    assert.equal(doc.status, 200);
    assert.equal(doc.headers.get('content-type'), XLSX);
    assert.equal(doc.headers.get('content-disposition'), 'attachment; filename="Budget_2026.xlsx"');
    assert.equal(doc.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await doc.arrayBuffer()), xlsx);

    objects.set('cms/logo.png', { buf: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' });
    const img = await fetch(`${base}/asset/cms/logo.png`);
    assert.equal(img.headers.get('content-disposition'), null);
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    await img.arrayBuffer();
});

test('any stored type that is not an image, a video or captions downloads, even one stored before this check', async () => {
    objects.set('cms/legacy.bin', { buf: Buffer.from('<html>hi</html>'), contentType: 'application/x-unknown' });
    const res = await fetch(`${base}/asset/cms/legacy.bin`);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="legacy.bin"');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    await res.arrayBuffer();
});
