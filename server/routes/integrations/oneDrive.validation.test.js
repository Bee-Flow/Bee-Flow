/**
 * What the OneDrive routes accept, and what they say when they refuse
 * (routes/integrations/oneDrive.js).
 *
 * `folderId` and `fileId` are CONCATENATED into the Graph path this server
 * calls on the caller's behalf (`/me/drive/items/${folderId}/children?$top=…`
 * and `/me/drive/items/${fileId}?$select=…`), so a value carrying a `/` or a
 * `?` appended its own segments and query parameters to that request. Both
 * are now pinned to the opaque id shape Graph mints.
 *
 * Run: cd server && node --test routes/integrations/oneDrive.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every Graph call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../auth/permissions': { requireAuth: pass },
    '../../integrations/msGraphClient': {
        isMicrosoftConnected: () => true,
        graphFetch: async (path) => {
            touched.push({ what: 'graphFetch', args: [path] });
            return { value: [], id: 'item', name: 'Report.txt', size: 10, file: { mimeType: 'text/plain' } };
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:integrations-onedrive-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]oneDrive\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./oneDrive');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session: { user: { id: 'u1' }, accessToken: 'tok', oauthProvider: 'microsoft' },
            get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            setHeader() { return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

test('a folder id carrying its own path or query cannot reach the Graph URL', async () => {
    for (const folderId of ['root/children?$top=999&x=', '../../users/someone/drive/root', 'a b']) {
        const res = await dispatch({ method: 'GET', url: '/files', query: { folderId } });
        assert.strictEqual(res.statusCode, 400, `refused: ${folderId}`);
        assert.strictEqual(res.body.error, 'That is not a OneDrive item id.');
    }
    assert.deepStrictEqual(touched, [], 'Graph was never called');
});

test('a misspelled listing key is refused rather than dropped', async () => {
    const res = await dispatch({ method: 'GET', url: '/files', query: { folderID: '01ABCDEF' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => /folderID/.test(d.message)),
        `the refusal names the key it did not expect: ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, []);
});

test('a non-numeric page size is refused, not silently turned into 25', async () => {
    const res = await dispatch({ method: 'GET', url: '/files', query: { top: 'all' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'top must be a number.');
    assert.deepStrictEqual(touched, []);
});

test('a page size above the ceiling is still clamped, not refused', async () => {
    const res = await dispatch({ method: 'GET', url: '/files', query: { top: '500' } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(/\$top=50&/.test(touched[0].args[0]), touched[0].args[0]);
});

test("the picker's own folder listing still reaches Graph", async () => {
    const res = await dispatch({ method: 'GET', url: '/files', query: { folderId: '01ABCDEF!123', top: '25' } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched[0].args[0].startsWith('/me/drive/items/01ABCDEF!123/children'), touched[0].args[0]);
});

test('a file id that is not one is refused before the export', async () => {
    const res = await dispatch({ method: 'GET', url: `/export/${encodeURIComponent('../root/children')}` });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'That is not a OneDrive item id.');
    assert.deepStrictEqual(touched, []);
});
