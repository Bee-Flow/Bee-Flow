/**
 * What GET /agents/:id/tool-lending accepts (routes/agents/toolLending.js):
 * nothing from the query.
 *
 * The route exists so that the answer is about the agent's OWNER and the
 * editor cannot choose whose connections it describes. A `?ownerId=` that
 * looked like it chose anyway was ignored and answered about the real owner
 * under a 200. What this file pins:
 *
 *   - a query parameter is refused with a 400 that names it;
 *   - a refused request reads no agent and no connection;
 *   - the plain request the Tools card sends still gets its answer.
 *
 * Run: cd server && node --test routes/agents/toolLending.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every read lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../../stores/agentStore': {
        getAgent: async (id) => { touched.push('getAgent'); return id === 'a1' ? { id: 'a1', owner_id: 'owner' } : null; },
        getForRuntime: async () => { touched.push('getForRuntime'); return { config: {} }; },
    },
    '../../utils/routeHelpers': { getEffectiveUserId: () => 'editor' },
    './crud': { canReadAgent: async () => true, canModifyAgent: async () => true },
    '../../core/integrations/connectionResolution': { isLendingEnabled: () => { touched.push('isLendingEnabled'); return false; } },
    '../../core/agentRuntime/toolPolicy': { hasCuratedGrants: () => false, toolsConfigOf: () => null },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-tool-lending-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]toolLending\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./toolLending');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = url.split('?');
        const query = Object.fromEntries(new URLSearchParams(search));
        const req = {
            method, url, originalUrl: url, path: pathname, body: undefined, query, headers: {},
            session: { user: { id: 'editor' } }, get() { return undefined; },
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

test('an ownerId in the query is refused by name, not answered about somebody else', async () => {
    const res = await dispatch({ method: 'GET', url: '/a1/tool-lending?ownerId=u2' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.match(res.body.error, /ownerId/);
    assert.ok(res.body.details.some((d) => d.path === 'query'));
    assert.deepStrictEqual(touched, [], 'no agent and no connection is read');
});

test('the plain request the Tools card sends still gets its answer', async () => {
    const res = await dispatch({ method: 'GET', url: '/a1/tool-lending' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { apps: [], readable: true, runtimeCurated: false });
});
