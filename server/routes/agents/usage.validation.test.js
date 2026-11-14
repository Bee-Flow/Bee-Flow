/**
 * What GET /agents/:id/usage accepts (routes/agents/usage.js).
 *
 * Nothing but the id: every kind is scanned on every call. A query string used
 * to be ignored, so `?kind=automation` answered with every kind under a 200
 * that read as a narrowed list — and the delete guard reads the same gathering.
 * What this file pins:
 *
 *   - the 400 NAMES what was wrong (`query`), in a sentence;
 *   - the access gate runs before the schema: an agent the caller cannot
 *     reach answers 404 whatever the query says, and a refused request reads
 *     nothing past the gate's lookup;
 *   - the editor's own request (BuilderSplit, no query) still gets through.
 *
 * Run: cd server && node --test routes/agents/usage.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const { fakeAgentGates } = require('./agentGate.testkit');

const touched = [];

const MOCKS = {
    '../../stores/agentStore': {
        // 'a1' is the caller's own agent; any other id does not exist.
        getAgent: async (id) => { touched.push({ what: 'getAgent', args: [id] }); return id === 'a1' ? { id: 'a1', owner_id: 'u1' } : null; },
    },
    '../../utils/routeHelpers': { getEffectiveUserId: () => 'u1' },
    './crud': null,
};

MOCKS['./crud'] = fakeAgentGates({ agentStore: MOCKS['../../stores/agentStore'], userId: () => 'u1' });

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agents-usage-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]usage\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./usage');
test.after(() => { Module._resolveFilename = originalResolve; });

const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch(url) {
    const [pathname, search = ''] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(search));
    return new Promise((resolve, reject) => {
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname, body: undefined, query, headers: {},
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
            if (!err) return reject(new Error(`fell through: ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

test('a filter the usage scan does not have is refused instead of answering with every kind', async () => {
    const res = await dispatch('/a1/usage?kind=automation');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === 'query'));
    assert.deepStrictEqual(touched, [{ what: 'getAgent', args: ['a1'] }], 'nothing past the access gate is read');
});

test('an agent the caller cannot reach is a 404 before its query is read', async () => {
    const res = await dispatch('/missing/usage?kind=automation');
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(touched, [{ what: 'getAgent', args: ['missing'] }]);
});

test('a request without a query reaches the agent lookup', async () => {
    const res = await dispatch('/missing/usage');
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(touched, [{ what: 'getAgent', args: ['missing'] }]);
});
