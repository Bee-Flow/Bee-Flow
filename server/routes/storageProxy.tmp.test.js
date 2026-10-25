/**
 * Temp-download URL tests for routes/storageProxy.js — the HMAC-signed
 * unauthenticated download path, extended with the studio-app attachment
 * prefix for app_trigger file inputs.
 *
 * Run: node routes/storageProxy.tmp.test.js
 *
 * storageStore is mocked via the require cache; a real express app is
 * exercised over http (same pattern as integrations/connections.test.js).
 */

const assert = require('assert');
const Module = require('module');
const express = require('express');
const { Readable } = require('stream');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-session-secret-0123456789abcdef';

function mock(id, exports) {
    const p = require.resolve(id);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const served = [];
mock('../stores/storageStore', {
    isAvailable: () => true,
    streamFile: async (key) => {
        served.push(key);
        return { stream: Readable.from(['file-bytes']), contentType: 'application/pdf', contentLength: 10 };
    },
});

const router = require('./storageProxy');
const { generateTempDownloadUrl, resolveTempDownloadKey } = require('../utils/tempDownloadUrl');

const SHA = 'a'.repeat(64);
const ATTACHMENT_KEY = `studio-apps/owner-1/app-1/attachments/${SHA}`;

(async () => {
    // ── Generator: accepted prefixes ─────────────────────────────────
    {
        const url = generateTempDownloadUrl(ATTACHMENT_KEY, 60);
        assert.ok(url.includes('/api/storage/tmp/'), 'absolute tmp URL');
        assert.ok(url.includes(encodeURIComponent(ATTACHMENT_KEY)), 'key embedded');
        // Existing prefixes keep working.
        generateTempDownloadUrl('transcription-tmp/whatever.wav', 60);
        generateTempDownloadUrl('users/u1/attachments/img.png', 60);
        generateTempDownloadUrl('users/u1/uploads/img.png', 60);
    }

    // ── Generator: near-misses rejected ──────────────────────────────
    {
        const bad = [
            'studio-apps/owner-1/app-1/data.db',                                  // the app DB, never
            `studio-apps/owner-1/app-1/attachments/${'A'.repeat(64)}`,           // uppercase ≠ sha256 hex
            'studio-apps/owner-1/app-1/attachments/deadbeef',                     // too short
            `studio-apps/owner-1/app-1/attachments/${SHA}/extra`,                // extra segment
            `studio-apps/owner-1/attachments/${SHA}`,                             // missing app segment
            `webpages/owner-1/app-1/attachments/${SHA}`,                          // wrong root
        ];
        for (const key of bad) {
            assert.throws(() => generateTempDownloadUrl(key, 60), new RegExp('Temp download URLs only allowed'), `must reject: ${key}`);
        }
    }

    // ── resolveTempDownloadKey: the same checks, without HTTP ────────
    // core/imageInline.js reads these objects straight out of storage, so this
    // is the authorization boundary for that path — it must reject everything
    // the route rejects.
    {
        const url = generateTempDownloadUrl(ATTACHMENT_KEY, 60);
        assert.strictEqual(resolveTempDownloadKey(url), ATTACHMENT_KEY, 'valid URL → key');

        const swapped = url.replace(encodeURIComponent(ATTACHMENT_KEY), encodeURIComponent('users/victim/uploads/x.png'));
        assert.strictEqual(resolveTempDownloadKey(swapped), null, 'key swap breaks the HMAC');

        const tampered = url.replace(/\/tmp\/[a-f0-9]{10}/, `/tmp/${'0'.repeat(10)}`);
        assert.strictEqual(resolveTempDownloadKey(tampered), null, 'tampered token rejected');

        assert.strictEqual(resolveTempDownloadKey(generateTempDownloadUrl(ATTACHMENT_KEY, -10)), null, 'expired rejected');
        assert.strictEqual(resolveTempDownloadKey('https://beeflow.nl/api/storage/file/users/u1/uploads/x.png'), null, 'session-auth proxy URL is not a temp URL');
        assert.strictEqual(resolveTempDownloadKey('https://example.com/cat.png'), null, 'external URL');
        assert.strictEqual(resolveTempDownloadKey('not a url'), null);
        assert.strictEqual(resolveTempDownloadKey(null), null);
        // Relative form (never generated, but must not resolve by accident).
        assert.strictEqual(resolveTempDownloadKey('/api/storage/tmp/abc?key=users/u1/uploads/x.png&expires=9999999999'), null);
    }

    // ── Route: serves a valid token, enforces prefix/expiry/HMAC ─────
    const app = express();
    app.use('/api/storage', router);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => {
        const res = await fetch(`${base}${path}`);
        return { status: res.status, text: await res.text() };
    };
    const tmpPath = (url) => url.slice(url.indexOf('/api/storage'));

    try {
        {
            const url = generateTempDownloadUrl(ATTACHMENT_KEY, 60);
            const r = await get(tmpPath(url));
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.text, 'file-bytes');
            assert.deepStrictEqual(served, [ATTACHMENT_KEY], 'streamed the attachment key');
        }
        {
            // Forged token for a non-allowed key → 403 before any HMAC math.
            const url = generateTempDownloadUrl(ATTACHMENT_KEY, 60);
            const [path, qs] = tmpPath(url).split('?');
            const params = new URLSearchParams(qs);
            params.set('key', 'studio-apps/owner-1/app-1/data.db');
            const r = await get(`${path}?${params.toString()}`);
            assert.strictEqual(r.status, 403, 'non-allowed key must 403');
        }
        {
            // Expired URL → 410.
            const url = generateTempDownloadUrl(ATTACHMENT_KEY, -10);
            const r = await get(tmpPath(url));
            assert.strictEqual(r.status, 410, 'expired URL must 410');
        }
        {
            // Tampered token → 403.
            const url = generateTempDownloadUrl(ATTACHMENT_KEY, 60);
            const p = tmpPath(url).replace(/\/tmp\/[a-f0-9]{10}/, (_m) => `/tmp/${'0'.repeat(10)}`);
            const r = await get(p);
            assert.strictEqual(r.status, 403, 'tampered token must 403');
        }
    } finally {
        server.close();
    }

    console.log('storageProxy.tmp.test.js: all assertions passed');
    // No process.exit(0): a force-exit races libuv handle teardown on Windows
    // (async.c assertion) under `node --test`; the server is closed above, so
    // the process drains on its own.
})().catch((e) => { console.error(e); process.exitCode = 1; });
