/**
 * GET /api/storage/file/{key...} serves the key storageStore.buildProxyUrl
 * minted — no more, no less (routes/storageProxy.js).
 *
 * buildProxyUrl percent-encodes each segment of the key, and Express 5's
 * router decodes each wildcard segment once. The route decoded the joined key
 * a SECOND time: the URL minted for `50% off.png` became a URIError and a
 * 500 "Failed to retrieve file", and a file named `a%41.png` was looked up as
 * `aA.png` — another key. What this file pins, over real HTTP:
 *
 *   - every URL buildProxyUrl mints reaches the store as the key it was
 *     minted from;
 *   - a traversal (`..`, encoded or as one segment with an encoded slash) and
 *     another user's prefix are still a 403, checked on the final key.
 *
 * Run: cd server && node --test routes/storageProxy.fileKey.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
// The router also mounts /tmp, whose HMAC helper refuses to load without one.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-session-secret-0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');
const { Readable } = require('node:stream');

// Every key the store is asked for lands in `served`.
const served = [];

const MOCKS = {
    '../stores/storageStore': {
        isAvailable: () => true,
        streamFile: async (key) => {
            served.push(key);
            return { stream: Readable.from(['bytes']), contentType: 'image/png', contentLength: 5 };
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:storage-proxy-file-key:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]storageProxy\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./storageProxy');

/** storageStore.buildProxyUrl, as written there: each segment encoded on its own. */
const buildProxyUrl = (key) => `/api/storage/file/${key.split('/').map(encodeURIComponent).join('/')}`;

let server;
let port;

test.before(async () => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { id: 'me' } }; next(); });
    app.use('/api/storage', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

test.after(async () => {
    Module._resolveFilename = originalResolve;
    await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => { served.length = 0; });

/** A GET with the path sent exactly as written — no client-side normalisation of `..`. */
function get(path) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('the URL minted for a name with a percent sign and a space is served, not a 500', async () => {
    const key = 'users/me/uploads/50% off.png';
    const res = await get(buildProxyUrl(key));
    assert.strictEqual(res.status, 200, res.body);
    assert.deepStrictEqual(served, [key]);
});

test('a name that looks percent-encoded is looked up as itself, not as the character it spells', async () => {
    const key = 'users/me/uploads/a%41.png';
    const res = await get(buildProxyUrl(key));
    assert.strictEqual(res.status, 200, res.body);
    assert.deepStrictEqual(served, [key], 'not users/me/uploads/aA.png');
});

test('plain keys, and keys with characters that need encoding, still arrive whole', async () => {
    for (const key of ['users/me/uploads/photo.png', 'users/me/notebooks/n1/Überschrift (1).png', 'shared/logo.png']) {
        served.length = 0;
        const res = await get(buildProxyUrl(key));
        assert.strictEqual(res.status, 200, key);
        assert.deepStrictEqual(served, [key]);
    }
});

test('traversal is still refused on the final key', async () => {
    for (const path of [
        '/api/storage/file/users/me/%2e%2e/victim/secret.png',
        '/api/storage/file/users/me/..%2Fvictim%2Fsecret.png',
    ]) {
        const res = await get(path);
        assert.strictEqual(res.status, 403, path);
    }
    assert.deepStrictEqual(served, []);
});

test('another user\'s file is still refused', async () => {
    const res = await get(buildProxyUrl('users/victim/uploads/secret.png'));
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(served, []);
});
