/**
 * What GET /usage-counts accepts, and what it says when it refuses
 * (routes/studioAppUsage.js).
 *
 * The route already refused an unknown window VALUE — `?window=week` is a 400
 * with `code: 'invalid_window'` and the supported list, and studioAppUsage.test.js
 * pins that. What slipped through was an unknown KEY: `?windw=week` was
 * dropped, and the answer was this month's counts, labelled `window: 'month'`,
 * to a caller who had asked for a week. What this file pins:
 *
 *   - the 400 NAMES the query as the problem, not just "invalid request";
 *   - the usage store is never reached, so a refused request reads nothing;
 *   - the value check keeps its own code and list.
 *
 * Run: cd server && node --test routes/studioAppUsage.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store read lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../stores/studioAppStore': {
        getAccessibleStudioApps: async () => { touched.push('getAccessibleStudioApps'); return [{ id: 'app1' }]; },
    },
    '../stores/usageStore': {
        RUN_COUNT_WINDOWS: { month: "date_trunc('month', NOW())" },
        getStudioAppRunCounts: async (ids) => { touched.push('getStudioAppRunCounts'); return new Map(ids.map((id) => [id, 3])); },
    },
    '../auth/permissions': { requireAuth: pass },
    '../auth/audience': { resolveAudienceContext: async () => ({ userId: 'u1', orgIds: new Set(['org1']), userGroups: [] }) },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:studio-app-usage-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]studioAppUsage\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./studioAppUsage');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch(url) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname, query, body: undefined, headers: {},
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
            if (!err) return reject(new Error(`fell through: GET ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

test('a misspelled window key is refused, not answered with this month under "month"', async () => {
    const res = await dispatch('/usage-counts?windw=week');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === 'query'), JSON.stringify(res.body.details));
    assert.deepStrictEqual(touched, []);
});

test('an unknown window value keeps its own code and the supported list', async () => {
    const res = await dispatch('/usage-counts?window=week');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_window');
    assert.deepStrictEqual(res.body.supported, ['month']);
    assert.deepStrictEqual(touched, []);
});

test('the bare request and the documented one still count', async () => {
    for (const url of ['/usage-counts', '/usage-counts?window=month']) {
        const res = await dispatch(url);
        assert.strictEqual(res.statusCode, 200, url);
        assert.deepStrictEqual(res.body, { window: 'month', unit: 'action_runs', counts: { app1: 3 } });
    }
});
