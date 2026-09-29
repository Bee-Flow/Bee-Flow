/**
 * What the Google Drive routes accept, and what they say when they refuse
 * (routes/integrations/googleDrive.js).
 *
 * `?query=` is spliced into a Drive search expression. The old escape handled
 * the quote and not the BACKSLASH, so a search text ending in one kept it and
 * the quote this route appends then read as an escaped quote: the literal
 * closed early and the rest of the caller's text became Drive query syntax,
 * outside the `(<workspace mime types>) and trashed=false` prefix the listing
 * is pinned to. `pageSize` had a ceiling but no floor, so `?pageSize=-5` went
 * to the Drive API as a negative page size.
 *
 * Run: cd server && node --test routes/integrations/googleDrive.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every Drive API call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const driveClient = {
    files: {
        list: async (p) => { touched.push({ what: 'list', args: [p] }); return { data: { files: [] } }; },
        get: async (p) => {
            touched.push({ what: 'get', args: [p] });
            return { data: { id: p.fileId, name: 'Doc', mimeType: 'application/vnd.google-apps.document' } };
        },
        export: async (p) => { touched.push({ what: 'export', args: [p] }); return { data: 'text' }; },
    },
};

const MOCKS = {
    '../../auth/permissions': { loadConfig: async () => ({ providers: {} }), requireAuth: pass },
    '../../integrations/googleClient': { createGoogleApiClient: async () => driveClient },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:integrations-googledrive-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]googleDrive\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./googleDrive');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session: { user: { id: 'u1' }, accessToken: 'tok', oauthProvider: 'google' },
            get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
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

test('a search text ending in a backslash cannot close the literal early', async () => {
    // Before the escape was fixed this produced
    //   … and name contains 'x\' or name contains 'anything'
    // with the caller's ` or name contains '…` read as query SYNTAX.
    const res = await dispatch({ method: 'GET', url: '/files', query: { query: "x\\' or name contains 'anything" } });
    assert.strictEqual(res.statusCode, 200);
    const q = touched.find((t) => t.what === 'list').args[0].q;
    assert.ok(q.startsWith("(mimeType='application/vnd.google-apps.document'"), q);
    // The backslash is doubled, so the quote after it is a literal quote and
    // the search text stays one literal.
    assert.ok(q.includes("name contains 'x\\\\\\' or name contains \\'anything'"), q);
});

test('an ordinary apostrophe still searches for itself', async () => {
    const res = await dispatch({ method: 'GET', url: '/files', query: { query: "o'brien" } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched[0].args[0].q.endsWith("name contains 'o\\'brien'"), touched[0].args[0].q);
});

test('a negative page size is refused rather than handed to the Drive API', async () => {
    const res = await dispatch({ method: 'GET', url: '/files', query: { pageSize: '-5' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'pageSize must be at least 1.');
    assert.deepStrictEqual(touched, []);
});

test('a non-numeric page size is refused, not silently turned into 20', async () => {
    const res = await dispatch({ method: 'GET', url: '/files', query: { pageSize: 'all' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'pageSize must be a number.');
    assert.deepStrictEqual(touched, []);
});

test('a misspelled listing key is refused rather than dropped', async () => {
    const res = await dispatch({ method: 'GET', url: '/files', query: { pageSze: '20' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => /pageSze/.test(d.message)),
        `the refusal names the key it did not expect: ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, []);
});

test("the picker's own listing still reaches Drive, clamped at the ceiling", async () => {
    const res = await dispatch({ method: 'GET', url: '/files', query: { query: 'invoice', pageSize: '500' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].args[0].pageSize, 50);
});

test('a file id that is not one is refused before the export', async () => {
    const res = await dispatch({ method: 'GET', url: `/export/${encodeURIComponent('../files')}` });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'That is not a Google Drive file id.');
    assert.deepStrictEqual(touched, []);
});

test('a real file id still exports', async () => {
    const res = await dispatch({ method: 'GET', url: '/export/1AbC_dEf-GhI' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'get').args[0].fileId, '1AbC_dEf-GhI');
});
