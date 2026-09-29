/**
 * What the webpage usage route accepts, and what it says when it refuses
 * (routes/webpagesUsage.js).
 *
 * The route reads the page id from the path and nothing else. A query key
 * used to fall away: `?kind=agent` was answered with every kind under a 200,
 * as if that filter existed. What this file pins:
 *
 *   - a query key is refused with a 400 that names `query`, in a sentence;
 *   - neither the store nor the scan is reached for a refused request;
 *   - the request `hooks/useUsage.ts` makes still answers.
 *
 * Run: cd server && node --test routes/webpagesUsage.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and scan call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../stores/webpageStore': {
        getWebpage: async (id, userId) => { touched.push({ what: 'getWebpage', args: [id, userId] }); return { id, userId, projectId: null }; },
    },
    '../core/webpages/webpageUsage': {
        usageForWebpage: async (wp) => { touched.push({ what: 'usageForWebpage', args: [wp.id] }); return { rows: [], partial: ['agent'], sources: {}, complete: false }; },
        redactForeign: (rows) => rows,
    },
    '../auth/permissions': { requireAuth: pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:webpages-usage-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]webpagesUsage\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./webpagesUsage');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, headers: {},
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

test('a kind filter the route never had is refused, not answered with every kind', async () => {
    const res = await dispatch({ method: 'GET', url: '/wp1/usage?kind=agent' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.strictEqual(res.body.error, 'This usage list takes no parameters; it always covers every kind.');
    assert.ok(res.body.details.some((d) => d.path === 'query'));
    assert.deepStrictEqual(touched, [], 'a refused request reads neither the page nor its usage');
});

test('the request the Used-by tab makes still answers', async () => {
    const res = await dispatch({ method: 'GET', url: '/wp1/usage' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.unchecked, ['agent']);
    assert.deepStrictEqual(touched.map((t) => t.what), ['getWebpage', 'usageForWebpage']);
});
