/**
 * What a module asset answer may be cached as (routes/moduleAssets.js).
 *
 * Assets are content-addressed per version, so a file is served with a
 * year-long `immutable` header. The header used to be set BEFORE sendFile
 * looked at the disk, so a miss went out as a 404 carrying the same header:
 * a chunk this replica had not unpacked yet was then remembered as missing,
 * by the browser and any shared cache, for a year. What this file pins:
 *
 *   - a served file carries `public, max-age=31536000, immutable`;
 *   - a miss, an inactive version and a path that climbs out of the version's
 *     frontend directory are 404s WITHOUT that header;
 *   - the route takes a query string without refusing it (bundles append their
 *     own), and still serves the file;
 *   - a module state that cannot be read is a 500, not a 404: the 404 said the
 *     file did not exist and left no trace of the outage in any log.
 *
 * A real Express app (sendFile needs a real response) over a temp directory.
 *
 * Run: cd server && node --test routes/moduleAssets.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const express = require('express');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'module-assets-test-'));
const versionDir = (id, version) => path.join(DATA, id, 'versions', version);
fs.mkdirSync(path.join(versionDir('uptime', '1.2.0'), 'frontend'), { recursive: true });
fs.writeFileSync(path.join(versionDir('uptime', '1.2.0'), 'frontend', 'entry.js'), 'export default 1;\n');
fs.writeFileSync(path.join(DATA, 'uptime', 'secret.txt'), 'not an asset\n');

const pass = (req, res, next) => next();
let storeDown = false; // the database is unreachable
const MOCKS = {
    '../auth/permissions': { requireAuth: pass },
    '../modules': { isModuleActive: async (id) => id === 'uptime' },
    '../modules/packageLoader': { versionDir },
    '../stores/platformModulePackageStore': {
        getActive: async (id) => {
            if (storeDown) throw new Error('connection terminated unexpectedly');
            return id === 'uptime' ? { version: '1.2.0' } : null;
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:module-assets:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]moduleAssets\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./moduleAssets');

let base;
let server;

test.before(async () => {
    const app = express();
    app.use('/api/module-assets', router);
    // As index.js mounts it; quiet, because one case is a deliberate 500.
    const { createTerminalErrorHandler } = require('../core/http/terminalErrorHandler');
    app.use(createTerminalErrorHandler({ log: { warn() {}, error() {} } }));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}/api/module-assets`;
});

test.after(() => {
    Module._resolveFilename = originalResolve;
    server.closeAllConnections();
    server.close();
    fs.rmSync(DATA, { recursive: true, force: true });
});

const IMMUTABLE = 'public, max-age=31536000, immutable';

async function get(pathname) {
    const res = await fetch(`${base}${pathname}`);
    await res.arrayBuffer();
    return res;
}

test('a file of the active version is served, cacheable for a year', async () => {
    const res = await get('/uptime/1.2.0/frontend/entry.js');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), IMMUTABLE);
});

test('a miss is a 404 that no cache may keep for a year', async () => {
    const res = await get('/uptime/1.2.0/frontend/chunk-not-unpacked-yet.js');
    assert.strictEqual(res.status, 404);
    assert.notStrictEqual(res.headers.get('cache-control'), IMMUTABLE,
        'an immutable 404 is never asked for again, not even after the file arrives');
    assert.doesNotMatch(String(res.headers.get('cache-control')), /immutable|max-age=31536000/);
});

test('a version that is not the active one is a 404 without the header', async () => {
    const res = await get('/uptime/1.1.0/frontend/entry.js');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.headers.get('cache-control'), null);
});

test('a path that climbs out of the frontend directory is a 404, not the file', async () => {
    const res = await get('/uptime/1.2.0/frontend/..%2F..%2F..%2Fsecret.txt');
    assert.strictEqual(res.status, 404);
    assert.doesNotMatch(String(res.headers.get('cache-control')), /immutable/);
});

test('a query string a bundle appends is not refused', async () => {
    const res = await get('/uptime/1.2.0/frontend/entry.js?v=4.7.0');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), IMMUTABLE);
});

test('a store that does not answer is a 500, not a "no such file" 404', async () => {
    storeDown = true;
    try {
        const res = await get('/uptime/1.2.0/frontend/entry.js');
        assert.strictEqual(res.status, 500);
        assert.strictEqual(res.headers.get('cache-control'), null);
    } finally {
        storeDown = false;
    }
});
