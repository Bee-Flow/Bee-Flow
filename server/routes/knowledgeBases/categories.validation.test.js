/**
 * What the KB category routes accept, and what they say when they refuse
 * (routes/knowledgeBases/categories.js).
 *
 * "Name is required" was the answer to a category named `42` — the name was
 * there, it just was not text — and a misspelled `colour` was answered with a
 * 201, so the category arrived in the default colour with nothing on screen
 * to explain it. What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.name`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases/categories.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../stores/knowledgeBases': {
        listKBCategories: async () => [],
        createKBCategory: async (p) => { touched.push({ what: 'createKBCategory', args: [p] }); return { ...p }; },
        deleteKBCategory: async (id) => { touched.push({ what: 'deleteKBCategory', args: [id] }); return true; },
    },
    '../../auth': {
        requireAuth: pass,
        requirePermission: () => pass,
        resolveUserOrgIds: async () => new Set(['orgA']),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-categories-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/]categories\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./categories');
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

test('a category with no name is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/categories', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A category needs a name.', 'the caller reads this sentence');
    assert.ok(res.body.details.some((d) => d.path === 'body.name'));
    assert.deepStrictEqual(touched, []);
});

test('a numeric name is refused by name, instead of being called missing', async () => {
    const res = await dispatch({ method: 'POST', url: '/categories', body: { name: 42 } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.name'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled colour is refused rather than answered with a 201 in the default', async () => {
    const res = await dispatch({ method: 'POST', url: '/categories', body: { name: 'Sales', colour: '#fff' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('a name is trimmed once, by the schema, on its way to the store', async () => {
    const res = await dispatch({ method: 'POST', url: '/categories', body: { name: '  Sales  ' } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'createKBCategory').args[0].name, 'Sales');
});
