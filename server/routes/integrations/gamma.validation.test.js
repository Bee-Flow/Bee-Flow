/**
 * What the Gamma generation-status poll accepts, and what it says when it
 * refuses (routes/integrations/gamma.js).
 *
 * The only input is the path id, and it is concatenated into the Gamma API
 * path. It reached `executeGammaTool` unchecked, so a caller could hand the
 * upstream client a path segment rather than an id. Gamma mints the id as an
 * opaque token, so the schema pins its character set.
 *
 * Run: cd server && node --test routes/integrations/gamma.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every upstream call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../integrations/gammaTools': {
        executeGammaTool: async (tool, args, userId) => {
            touched.push({ what: 'executeGammaTool', args: [tool, args, userId] });
            return { status: 'completed' };
        },
    },
    '../../auth/permissions': { requireAuth: pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:integrations-gamma-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]gamma\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./gamma');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

/**
 * The router matches on `url`, so a generation id with a slash in it cannot
 * be posed through the path — the express router would not match. The probe
 * here is therefore the express-level one: whatever Express DID bind to
 * `:generationId` is what the schema sees.
 */
function dispatch({ method, url }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body: {}, query: {}, headers: {},
            session: { user: { id: 'u1' }, isAuthenticated: true }, get() { return undefined; },
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

test('an id that is not a Gamma id is refused before it reaches the API client', async () => {
    const res = await dispatch({ method: 'GET', url: `/generations/${encodeURIComponent('../../v0.2/workspaces')}` });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'That is not a Gamma generation id.');
    assert.ok(res.body.details.some((d) => d.path === 'params.generationId'));
    assert.deepStrictEqual(touched, []);
});

test('an id carrying a query of its own is refused', async () => {
    const res = await dispatch({ method: 'GET', url: `/generations/${encodeURIComponent('g1?expand=all')}` });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test("the preview panel's own poll still reaches Gamma", async () => {
    const res = await dispatch({ method: 'GET', url: '/generations/gen_ABC-123' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args[1], { generationId: 'gen_ABC-123' });
});
