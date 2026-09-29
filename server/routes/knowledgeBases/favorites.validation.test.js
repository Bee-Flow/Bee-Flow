/**
 * What the KB favourites bulk route accepts, and what it says when it refuses
 * (routes/knowledgeBases/favorites.js).
 *
 * "kbIds array required" named no field and no reason, and a misspelled key
 * got the same sentence as a wrong type — so the one-time migration of a
 * browser's favourites failed with nothing to act on. What this file pins is
 * the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.kbIds`), not just "invalid request";
 *   - the store is never reached, so a refused request changes nothing;
 *   - a blank entry is still DROPPED rather than refused: this is a migration
 *     of whatever a browser had, and the other favourites must still arrive.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases/favorites.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../../stores/knowledgeBases': {
        listFavorites: async () => ['kb1'],
        addFavorite: async (...a) => { touched.push({ what: 'addFavorite', args: a }); return true; },
        removeFavorite: async (...a) => { touched.push({ what: 'removeFavorite', args: a }); return true; },
    },
    '../../auth': { requireAuth: (req, res, next) => next() },
    './shared': { getUserId: (req) => req.session?.user?.id || null },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-favorites-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/]favorites\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./favorites');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
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
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

test('a list that is not a list is refused by name, and nothing is favourited', async () => {
    const res = await dispatch({ method: 'POST', url: '/favorites/bulk', body: { kbIds: 'kb1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'kbIds is a list of knowledge base ids.');
    assert.ok(res.body.details.some((d) => d.path === 'body.kbIds'));
    assert.deepStrictEqual(touched, []);
});

test('leaving the list out gets the same sentence, not the word "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/favorites/bulk', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'kbIds is a list of knowledge base ids.');
});

test('an entry that is not text is named by its index', async () => {
    const res = await dispatch({ method: 'POST', url: '/favorites/bulk', body: { kbIds: ['kb1', 7] } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.kbIds.1'));
    assert.deepStrictEqual(touched, []);
});

test('a blank entry is dropped, and the rest of the migration still lands', async () => {
    const res = await dispatch({ method: 'POST', url: '/favorites/bulk', body: { kbIds: ['kb1', '', 'kb2'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.map((t) => t.args[1]), ['kb1', 'kb2']);
});
