/**
 * What the sitemap ingest accepts, and what it says when it refuses
 * (routes/knowledgeBases/sitemapIngest.js).
 *
 * `maxPages` was read with `Number()` and a fallback: a misspelled key walked
 * the 50-page default, a word walked the 50-page default, and 0 walked nothing
 * and answered "No pages found in sitemap". The walk itself — the SSRF screen
 * on every address and the 500-page clamp — is pinned in
 * routes/knowledgeBases.ssrf.test.js. What this file pins is the door:
 *
 *   - the 400 NAMES the field (`body.url`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - nothing is looked up or fetched for a refused request.
 *
 * Run: cd server && node --test routes/knowledgeBases/sitemapIngest.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every lookup lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    // No base by that id: a request the schema lets through ends at the 404,
    // before anything is fetched.
    '../../stores/knowledgeBases': { getKB: async (id) => { touched.push({ what: 'getKB', args: [id] }); return null; } },
    '../../auth': { requireAuth: pass, requirePermission: () => pass },
    '../../core/kb/kbIngestionHelpers': { ingestDocument: async () => { throw new Error('not reached'); } },
    './shared': {
        getUserId: () => 'u1',
        guardedFetch: async () => { throw new Error('not reached'); },
        canAccessKB: async () => true,
        blockIfSystemKB: () => false,
        ensureKbSource: async () => null,
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-sitemap-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/]sitemapIngest\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./sitemapIngest');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ body }) {
    const url = '/kb1/ingest/sitemap';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error('fell through'));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const refusedAt = (res, path) => {
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.ok(res.body.details.some((d) => d.path === path), `the refusal names ${path}: ${JSON.stringify(res.body.details)}`);
    assert.notStrictEqual(res.body.error, 'Required');
    assert.deepStrictEqual(touched, [], 'a refused request looks nothing up');
};

test.beforeEach(() => { touched.length = 0; });

test('a sitemap ingest without an address is refused in words', async () => {
    const res = await dispatch({ body: {} });
    refusedAt(res, 'body.url');
    assert.match(res.body.error, /address is required/);
});

test('no body at all is the same sentence, not a TypeError', async () => {
    refusedAt(await dispatch({ body: undefined }), 'body.url');
});

test('a misspelled maxPages is refused instead of walking the 50-page default', async () => {
    const res = await dispatch({ body: { url: 'https://example.com', mxPages: 5 } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('a fractional page count is refused, not truncated', async () => {
    refusedAt(await dispatch({ body: { url: 'https://example.com', maxPages: 2.5 } }), 'body.maxPages');
});

test('a page count sent as digits still passes, as Number() let it', async () => {
    const res = await dispatch({ body: { url: 'https://example.com', maxPages: '10' } });
    assert.strictEqual(res.statusCode, 404, 'past the schema, to the (stubbed) missing base');
    assert.deepStrictEqual(touched, [{ what: 'getKB', args: ['kb1'] }]);
});
