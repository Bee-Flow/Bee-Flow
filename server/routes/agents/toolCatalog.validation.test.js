/**
 * What GET /agents/tool-catalog accepts (routes/agents/toolCatalog.js).
 *
 * Nothing: the catalog is per caller and complete. A query string used to be
 * ignored, so `?app=gmail` came back with every app under a 200 that read as
 * if it had narrowed. What this file pins:
 *
 *   - the 400 NAMES what was wrong (`query`), in a sentence;
 *   - the availability gate is never asked for a refused request;
 *   - the one real caller (useToolCatalog, no query) still gets its catalog.
 *
 * Run: cd server && node --test routes/agents/toolCatalog.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../auth': { requireAuth: pass },
    '../../automation/toolRegistry': {
        ALL_TOOL_APPS: [{ app: 'gmail', label: 'Gmail' }],
        loadToolsResult: () => ({ ok: true, tools: [{ function: { name: 'gmail_search', description: 'Search' } }] }),
    },
    '../../automation/sideEffectMap': { effectOf: () => 'reads' },
    '../../core/integrations/integrationTools': {
        getIntegrationTools: async () => { touched.push('getIntegrationTools'); return { tools: [{ function: { name: 'gmail_search' } }] }; },
    },
    '../../core/integrations/connectionResolution': { providerForTool: () => 'google', isLendingEnabled: () => false },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agents-tool-catalog-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]toolCatalog\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./toolCatalog');
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

test('a filter the catalog does not have is refused instead of answering with every app', async () => {
    const res = await dispatch('/tool-catalog?app=gmail');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === 'query'));
    assert.deepStrictEqual(touched, [], 'the availability gate is not asked');
});

test('the picker\'s own request, without a query, still gets the catalog', async () => {
    const res = await dispatch('/tool-catalog');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.apps[0].id, 'gmail');
    assert.strictEqual(res.body.apps[0].available, true);
});
