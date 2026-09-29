/**
 * What the subscription audit-log read accepts, and what it says when it
 * refuses (routes/subscriptions/audit.js).
 *
 * `targetType` / `targetId` are the only narrowing this log has, and the store
 * builds its WHERE from whichever of them it was handed. A misspelled one was
 * therefore not a narrower answer but a WIDER one: `?targetTyp=org_subscription`
 * returned every subscription audit row in the deployment — every org, every
 * consumer — under a 200, to a page that had asked about one org.
 *
 *   - an unrecognised query key is a 400 that NAMES the key;
 *   - a non-numeric or negative limit is refused in words;
 *   - the store is never reached, so a refused request reads nothing.
 *
 * Run: cd server && node --test --test-force-exit routes/subscriptions/audit.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../../stores/userStore': {
        getAuditLog: async (opts) => { touched.push({ what: 'getAuditLog', args: [opts] }); return []; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:subscriptions-audit-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /subscriptions[\\/]audit\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./audit');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session: { user: { id: 'admin' }, isAuthenticated: true, isAdmin: true }, get() { return undefined; },
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

test('a misspelled filter is refused, instead of widening the log to every tenant', async () => {
    const res = await dispatch({ method: 'GET', url: '/audit', query: { targetTyp: 'org_subscription' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/targetTyp/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, [], 'nothing was read');
});

test('a non-numeric limit is refused in words, not silently turned into 50', async () => {
    const res = await dispatch({ method: 'GET', url: '/audit', query: { limit: 'all' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'limit must be a number.');
    assert.ok(res.body.details.some((d) => d.path === 'query.limit'));
    assert.deepStrictEqual(touched, []);
});

test('a negative limit is refused rather than handed to the database', async () => {
    const res = await dispatch({ method: 'GET', url: '/audit', query: { limit: '-5' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'limit cannot be negative.');
    assert.deepStrictEqual(touched, []);
});

test('a filter that is spelled right reaches the store, still clamped to 200 rows', async () => {
    const res = await dispatch({
        method: 'GET', url: '/audit',
        query: { targetType: 'org_subscription', targetId: 'orgA', limit: '500', offset: '10' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args[0], {
        targetType: 'org_subscription', targetId: 'orgA', limit: 200, offset: 10,
    });
});

test('no query at all still reads the default page', async () => {
    const res = await dispatch({ method: 'GET', url: '/audit', query: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args[0], { targetType: undefined, targetId: undefined, limit: 50, offset: 0 });
});
