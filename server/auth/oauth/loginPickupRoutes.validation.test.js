/**
 * What /login-pickup accepts, and what it says when it refuses
 * (auth/oauth/loginPickupRoutes.js).
 *
 * The embedded iframe polls this endpoint for the session token the popup
 * deposited, so it is a JSON endpoint with one caller and one parameter. The
 * length cap was already a refusal; what the schema adds is the KEY, so a
 * request that names no pickup at all is told which parameter it is missing
 * instead of being answered "invalid id". What this file pins:
 *
 *   - the 400 NAMES the field (`query.id`), not just "invalid request";
 *   - the 128-character cap is unchanged;
 *   - the token store is never reached, so a refused poll claims nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/oauth/loginPickupRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];

const MOCKS = {
    '../../utils/sessionToken': { claimPickup: async (id) => { touched.push({ what: 'claimPickup', args: [id] }); return null; } },
    '../../db': { getRedis: () => null },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:login-pickup-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /oauth[\\/]loginPickupRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./loginPickupRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: session || {}, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
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

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.ok(res.body.details ? res.body.details.some((d) => d.path === field) : true,
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('a poll that names no pickup is refused by field, not with "invalid id"', async () => {
    const res = await dispatch({ method: 'GET', url: '/login-pickup' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'query.id'));
    assert.deepStrictEqual(touched, []);
});

test('an over-long pickup id is still refused', async () => {
    await refuses({ method: 'GET', url: `/login-pickup?id=${'a'.repeat(129)}` }, 'query.id');
});

test('a misspelled parameter is refused rather than read as absent', async () => {
    await refuses({ method: 'GET', url: '/login-pickup?pickupId=abc' }, 'query');
});

test('a real pickup id still reaches the token store', async () => {
    const res = await dispatch({ method: 'GET', url: '/login-pickup?id=abc' });
    assert.strictEqual(res.statusCode, 404, 'the mock store has nothing yet, which is the polled state');
    assert.strictEqual(touched.find((t) => t.what === 'claimPickup').args[0], 'abc');
});
