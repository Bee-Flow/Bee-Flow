/**
 * Route tests for the CMS asset surface, over real HTTP against the cms
 * router (heavy siblings mocked through the Module._resolveFilename harness of
 * routes/cms.public.test.js; no Postgres):
 *
 *   GET  /api/cms/admin/assets        the admin asset library: admin gating,
 *                                     image/video/vtt filtering, newest-first,
 *                                     URL building, the 500 cap, local-fs mode
 *   POST /api/cms/admin/upload-clip   mp4/webm up to 500 MB, disk-backed, then
 *                                     streamed into storage in parts
 *   POST /api/cms/admin/upload        .vtt accepted by extension + content
 *   GET  /api/cms/asset/cms/...       Accept-Ranges / 206 / 416, text/vtt
 *
 * Run: node --test routes/cms.assets.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const Module = require('module');

// Temp files of the clip uploader go here, so the test can prove they are removed.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-media-test-'));
process.env.TMPDIR = TMP;

// ── In-memory storage with the multipart + range surface the routes use ──

const objects = new Map();   // key -> { buf, contentType, metadata }
const uploads = new Map();   // uploadId -> { key, contentType, parts: Map }
const calls = { begin: 0, parts: 0, complete: 0, abort: 0 };
const failures = { complete: false };
let projectLookups = 0;
const storageState = {
    keys: [],           // what listKeys resolves with
    throwError: null,   // when set, listKeys throws (local-fs mode)
    lastPrefix: null,
};

const mockStorageStore = {
    isAvailable: () => true,
    async listKeys(prefix) {
        storageState.lastPrefix = prefix;
        if (storageState.throwError) throw storageState.throwError;
        return [...storageState.keys];
    },
    async uploadFile(key, buffer, contentType, metadata = null) {
        objects.set(key, { buf: Buffer.from(buffer), contentType, metadata: metadata || {} });
        return { key };
    },
    async beginMultipartUpload(key, contentType) {
        calls.begin++;
        const uploadId = `u${uploads.size + 1}`;
        uploads.set(uploadId, { key, contentType, parts: new Map() });
        return { uploadId };
    },
    async uploadPartBuffer(key, uploadId, partNumber, buffer) {
        calls.parts++;
        uploads.get(uploadId).parts.set(partNumber, Buffer.from(buffer));
        return { etag: `etag-${partNumber}` };
    },
    async completeMultipartUpload(key, uploadId, parts) {
        calls.complete++;
        if (failures.complete) throw new Error('complete failed');
        const u = uploads.get(uploadId);
        const buf = Buffer.concat(parts.map((p) => u.parts.get(p.partNumber)));
        objects.set(key, { buf, contentType: u.contentType, metadata: {} });
        return { key };
    },
    async abortMultipartUpload(key, uploadId) {
        calls.abort++;
        uploads.delete(uploadId);
    },
    async headFile(key) {
        const o = objects.get(key);
        if (!o) { const e = new Error('nope'); e.name = 'NoSuchKey'; throw e; }
        return { contentLength: o.buf.length, contentType: o.contentType };
    },
    async streamFile(key, { range = null } = {}) {
        const o = objects.get(key);
        if (!o) { const e = new Error('nope'); e.name = 'NoSuchKey'; throw e; }
        const slice = range ? o.buf.subarray(range.start, range.end + 1) : o.buf;
        return {
            stream: Readable.from([slice]),
            contentType: o.contentType,
            contentLength: slice.length,
            totalLength: o.buf.length,
            metadata: o.metadata,
        };
    },
};

const mockCmsShared = {
    requireAdmin: (req, res, next) => {
        if (req.headers['x-test-admin'] === '1') return next();
        return res.status(403).json({ error: 'Admin access required' });
    },
    attachSiteIdFromParam: (req, res, next) => next(),
    SITE_ID_RE: /^pj_[a-f0-9]{4,}$/,
    KEY_CMS_LIVE_SITE_ID: 'cms_live_site_id',
    KEY_CMS_ENABLED: 'cms_enabled',
    getLiveSiteId: async () => null,
    setLiveSiteId: async (id) => id,
};

const MOCKS = {
    './configStore': {},
    '../stores/configStore': {},
    '../db': { getAll: async () => [] },
    '../stores/cmsStore': {
        // /admin/upload sits behind attachSiteId (resolves the default project);
        // /admin/upload-clip is registered before it and must never get here.
        listProjects: async () => { projectLookups++; return [{ id: 'pj_abcd1234', name: 'Default' }]; },
        createProject: async () => { projectLookups++; return { id: 'pj_abcd1234', name: 'Default' }; },
    },
    '../core/cms/cmsTranslate': {},
    '../stores/languageStore': { getAvailableLocales: async () => ['en'] },
    '../stores/storageStore': mockStorageStore,
    '../core/umamiClient': {
        KEY_URL: 'cms_analytics_url',
        isConfigured: async () => false,
        ensureWebsite: async () => { throw new Error('not used in tests'); },
        METRIC_TYPES: [],
    },
    '../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
    './cmsShared': mockCmsShared,
    './cmsAnalytics': {
        router: require('express').Router(),
        getAnalyticsSettings: async () => ({}),
        getAnalyticsSiteMap: async () => ({}),
        getRecorderMap: async () => ({}),
        provisionAnalyticsForSite: async () => null,
    },
    '../utils/svgSanitizer': { sanitizeSvg: () => null },
    '../license': { serverLicenseGovernsOrgs: () => false },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
const router = require('./cms');

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/cms', router);
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/cms`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(TMP, { recursive: true, force: true });
});

test.beforeEach(() => {
    objects.clear();
    uploads.clear();
    failures.complete = false;
    projectLookups = 0;
    Object.assign(calls, { begin: 0, parts: 0, complete: 0, abort: 0 });
    storageState.keys = [];
    storageState.throwError = null;
    storageState.lastPrefix = null;
});

function tmpEntries() {
    const out = [];
    for (const d of fs.readdirSync(TMP)) {
        const full = path.join(TMP, d);
        if (fs.statSync(full).isDirectory()) out.push(...fs.readdirSync(full));
    }
    return out;
}

const mp4Bytes = (size) => {
    const b = Buffer.alloc(size, 7);
    b.writeUInt32BE(32, 0);
    b.write('ftypisom', 4, 'latin1');
    return b;
};
const webmBytes = (size) => {
    const b = Buffer.alloc(size, 7);
    b.writeUInt32BE(0x1a45dfa3, 0);
    return b;
};

async function post(route, buf, filename, type, { admin = true } = {}) {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type }), filename);
    const res = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: admin ? { 'x-test-admin': '1' } : {},
        body: fd,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

// ── upload-clip ──────────────────────────────────────────────────────

test('upload-clip without admin → 403', async () => {
    const { status } = await post('/admin/upload-clip', mp4Bytes(64), 'a.mp4', 'video/mp4', { admin: false });
    assert.strictEqual(status, 403);
    assert.strictEqual(objects.size, 0);
});

test('upload-clip stores an mp4 under a cms/ key and returns the asset url', async () => {
    const src = mp4Bytes(4096);
    const { status, body } = await post('/admin/upload-clip', src, 'My Demo (v2).mp4', 'video/mp4');
    assert.strictEqual(status, 200);
    assert.match(body.key, /^cms\/\d+-[0-9a-f]{12}-My_Demo__v2_\.mp4$/);
    assert.strictEqual(body.url, `/api/cms/asset/${body.key.split('/').map(encodeURIComponent).join('/')}`);
    const stored = objects.get(body.key);
    assert.strictEqual(stored.contentType, 'video/mp4');
    assert.ok(stored.buf.equals(src));
    assert.deepStrictEqual(tmpEntries(), [], 'temp file removed after success');
    assert.strictEqual(projectLookups, 0, 'a clip upload must not auto-provision a site');
});

test('upload-clip streams a larger file in several bounded parts, bytes intact', async () => {
    const src = mp4Bytes(17 * 1024 * 1024);
    const { status, body } = await post('/admin/upload-clip', src, 'big.mp4', 'video/mp4');
    assert.strictEqual(status, 200);
    assert.strictEqual(calls.parts, 2);
    assert.ok(objects.get(body.key).buf.equals(src));
    assert.deepStrictEqual(tmpEntries(), []);
});

test('upload-clip accepts webm', async () => {
    const { status, body } = await post('/admin/upload-clip', webmBytes(2048), 'clip.webm', 'video/webm');
    assert.strictEqual(status, 200);
    assert.strictEqual(objects.get(body.key).contentType, 'video/webm');
});

test('upload-clip rejects a wrong MIME type with 400', async () => {
    const { status, body } = await post('/admin/upload-clip', Buffer.from('hello'), 'x.txt', 'text/plain');
    assert.strictEqual(status, 400);
    assert.match(body.error, /MP4 or WebM/);
    assert.strictEqual(objects.size, 0);
    assert.deepStrictEqual(tmpEntries(), []);
});

test('upload-clip rejects an image, even one labelled video/mp4 with a wrong extension', async () => {
    const png = await post('/admin/upload-clip', Buffer.from('x'), 'a.png', 'image/png');
    assert.strictEqual(png.status, 400);
    const wrongExt = await post('/admin/upload-clip', mp4Bytes(64), 'a.exe', 'video/mp4');
    assert.strictEqual(wrongExt.status, 400);
    assert.strictEqual(objects.size, 0);
});

test('upload-clip rejects a file that is not really a video, and still removes the temp file', async () => {
    const { status, body } = await post('/admin/upload-clip', Buffer.from('<html>not a video at all</html>'), 'fake.mp4', 'video/mp4');
    assert.strictEqual(status, 400);
    assert.match(body.error, /not a valid MP4 or WebM/);
    assert.strictEqual(objects.size, 0);
    assert.deepStrictEqual(tmpEntries(), [], 'temp file removed after a rejected upload');
});

test('upload-clip aborts the multipart upload and cleans up when storage fails', async () => {
    failures.complete = true;
    const { status } = await post('/admin/upload-clip', mp4Bytes(2048), 'a.mp4', 'video/mp4');
    assert.strictEqual(status, 500);
    assert.strictEqual(calls.abort, 1);
    assert.strictEqual(objects.size, 0);
    assert.deepStrictEqual(tmpEntries(), [], 'temp file removed after a storage error');
});

// ── captions ─────────────────────────────────────────────────────────

const VTT = 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n';

test('upload accepts .vtt whatever MIME the browser sends, stores it as text/vtt', async () => {
    for (const type of ['text/vtt', 'text/plain', 'application/octet-stream']) {
        const { status, body } = await post('/admin/upload', Buffer.from(VTT), 'captions.en.vtt', type);
        assert.strictEqual(status, 200, type);
        assert.strictEqual(objects.get(body.key).contentType, 'text/vtt');
    }
});

test('upload accepts a .vtt with a BOM', async () => {
    const { status } = await post('/admin/upload', Buffer.from(`﻿${VTT}`), 'c.vtt', 'text/vtt');
    assert.strictEqual(status, 200);
});

test('upload rejects a .vtt that does not start with WEBVTT', async () => {
    const { status, body } = await post('/admin/upload', Buffer.from('<script>alert(1)</script>'), 'c.vtt', 'text/vtt');
    assert.strictEqual(status, 400);
    assert.match(body.error, /WebVTT/);
    assert.strictEqual(objects.size, 0);
});

test('upload rejects a .vtt over 1 MB', async () => {
    const big = Buffer.from(VTT + 'x'.repeat(1024 * 1024));
    const { status } = await post('/admin/upload', big, 'c.vtt', 'text/vtt');
    assert.strictEqual(status, 400);
});

test('upload still rejects text/plain with another extension', async () => {
    const { status } = await post('/admin/upload', Buffer.from(VTT), 'notes.txt', 'text/plain');
    assert.strictEqual(status, 400);
});

test('upload lists .vtt in the asset library', async () => {
    objects.set('cms/1712000000000-c.vtt', { buf: Buffer.from(VTT), contentType: 'text/vtt', metadata: {} });
    storageState.keys = ['cms/1712000000000-c.vtt', 'cms/1712000000001-a.txt'];
    const { body } = await getAssets();
    assert.deepStrictEqual(body.assets.map((a) => a.key), ['cms/1712000000000-c.vtt']);
});

// ── asset route: ranges + vtt headers ────────────────────────────────

function seed(key, buf, contentType, metadata = {}) {
    objects.set(key, { buf, contentType, metadata });
}

test('asset GET without Range → 200, full body, advertises Accept-Ranges', async () => {
    seed('cms/1-a.mp4', Buffer.from('0123456789'), 'video/mp4');
    const res = await fetch(`${baseUrl}/asset/cms/1-a.mp4`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('accept-ranges'), 'bytes');
    assert.strictEqual(res.headers.get('content-type'), 'video/mp4');
    assert.strictEqual(await res.text(), '0123456789');
});

test('asset GET with Range → 206 with Content-Range and only those bytes', async () => {
    seed('cms/1-a.mp4', Buffer.from('0123456789'), 'video/mp4');
    const res = await fetch(`${baseUrl}/asset/cms/1-a.mp4`, { headers: { range: 'bytes=2-5' } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-range'), 'bytes 2-5/10');
    assert.strictEqual(res.headers.get('content-length'), '4');
    assert.strictEqual(await res.text(), '2345');
});

test('asset GET with open-ended and suffix ranges', async () => {
    seed('cms/1-a.mp4', Buffer.from('0123456789'), 'video/mp4');
    const open = await fetch(`${baseUrl}/asset/cms/1-a.mp4`, { headers: { range: 'bytes=7-' } });
    assert.strictEqual(open.status, 206);
    assert.strictEqual(await open.text(), '789');
    const suffix = await fetch(`${baseUrl}/asset/cms/1-a.mp4`, { headers: { range: 'bytes=-3' } });
    assert.strictEqual(suffix.headers.get('content-range'), 'bytes 7-9/10');
    assert.strictEqual(await suffix.text(), '789');
});

test('asset GET with an unsatisfiable Range → 416 with bytes */size', async () => {
    seed('cms/1-a.mp4', Buffer.from('0123456789'), 'video/mp4');
    const res = await fetch(`${baseUrl}/asset/cms/1-a.mp4`, { headers: { range: 'bytes=50-60' } });
    assert.strictEqual(res.status, 416);
    assert.strictEqual(res.headers.get('content-range'), 'bytes */10');
});

test('asset GET Range on a missing key → 404', async () => {
    const res = await fetch(`${baseUrl}/asset/cms/1-nope.mp4`, { headers: { range: 'bytes=0-1' } });
    assert.strictEqual(res.status, 404);
});

test('SVG protections are unchanged by ranges: legacy SVG still downloads, sanitized one gets the CSP', async () => {
    seed('cms/1-legacy.svg', Buffer.from('<svg/>'), 'image/svg+xml');
    const legacy = await fetch(`${baseUrl}/asset/cms/1-legacy.svg`, { headers: { range: 'bytes=0-2' } });
    assert.strictEqual(legacy.status, 206);
    assert.strictEqual(legacy.headers.get('content-type'), 'application/octet-stream');
    assert.strictEqual(legacy.headers.get('content-disposition'), 'attachment');

    seed('cms/1-clean.svg', Buffer.from('<svg/>'), 'image/svg+xml', { sanitized: '1' });
    const clean = await fetch(`${baseUrl}/asset/cms/1-clean.svg`);
    assert.strictEqual(clean.headers.get('content-type'), 'image/svg+xml');
    assert.match(clean.headers.get('content-security-policy'), /default-src 'none'/);
});

test('asset GET serves .vtt as text/vtt; charset=utf-8 with nosniff', async () => {
    // Stored with a sloppy type on purpose: the extension wins.
    seed('cms/1-c.vtt', Buffer.from(VTT), 'text/plain');
    const res = await fetch(`${baseUrl}/asset/cms/1-c.vtt`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'text/vtt; charset=utf-8');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(await res.text(), VTT);
});

// ── Asset library ───────────────────────────────────────────────────

async function getAssets({ admin = true } = {}) {
    const res = await fetch(`${baseUrl}/admin/assets`, {
        headers: admin ? { 'x-test-admin': '1' } : {},
    });
    return { status: res.status, body: await res.json() };
}

// ── Gating ──────────────────────────────────────────────────────────

test('without admin → 403, storage never touched', async () => {
    storageState.keys = ['cms/1712000000000-a.png'];
    const { status } = await getAssets({ admin: false });
    assert.strictEqual(status, 403);
    assert.strictEqual(storageState.lastPrefix, null);
});

// ── Shape ───────────────────────────────────────────────────────────

test('lists cms/ keys as {key, url}, image/video only, newest-first', async () => {
    storageState.keys = [
        'cms/1712000000001-old-logo.png',
        'cms/1712000000200-notes.txt',            // filtered: not media
        'cms/1712000000300-demo.mp4',
        'cms/1712000000100-photo.JPG',            // case-insensitive ext
        'cms/1712000000400-hero.webp',
    ];
    const { status, body } = await getAssets();
    assert.strictEqual(status, 200);
    assert.strictEqual(storageState.lastPrefix, 'cms/');
    assert.strictEqual(body.unavailable, undefined);
    assert.deepStrictEqual(body.assets, [
        { key: 'cms/1712000000400-hero.webp', url: '/api/cms/asset/cms/1712000000400-hero.webp' },
        { key: 'cms/1712000000300-demo.mp4',  url: '/api/cms/asset/cms/1712000000300-demo.mp4' },
        { key: 'cms/1712000000100-photo.JPG', url: '/api/cms/asset/cms/1712000000100-photo.JPG' },
        { key: 'cms/1712000000001-old-logo.png', url: '/api/cms/asset/cms/1712000000001-old-logo.png' },
    ]);
});

test('URL segments are encoded', async () => {
    storageState.keys = ['cms/1712000000000-a b#c.png'];
    const { body } = await getAssets();
    assert.deepStrictEqual(body.assets, [{
        key: 'cms/1712000000000-a b#c.png',
        url: '/api/cms/asset/cms/1712000000000-a%20b%23c.png',
    }]);
});

test('caps the listing at 500 newest assets', async () => {
    storageState.keys = Array.from({ length: 620 }, (_, i) =>
        `cms/${1712000000000 + i}-img.png`);
    const { body } = await getAssets();
    assert.strictEqual(body.assets.length, 500);
    // Newest survives the cap; the oldest 120 are dropped.
    assert.strictEqual(body.assets[0].key, 'cms/1712000000619-img.png');
    assert.strictEqual(body.assets[499].key, 'cms/1712000000120-img.png');
});

// ── Degradation ─────────────────────────────────────────────────────

test('local-fs mode (listKeys throws) → { assets: [], unavailable: true }', async () => {
    storageState.throwError = new Error('StorageStore not initialized');
    const { status, body } = await getAssets();
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { assets: [], unavailable: true });
});
