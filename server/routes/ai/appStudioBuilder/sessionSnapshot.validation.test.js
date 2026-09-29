/**
 * What GET /builder/session/:appId accepts (routes/ai/appStudioBuilder/
 * sessionSnapshot.js): nothing from the query. There is one snapshot per app
 * and it comes back whole, so a `?version=` that looks like it asks for an
 * older one is refused by name rather than answered with the latest.
 *
 * Run: cd server && node --test routes/ai/appStudioBuilder/sessionSnapshot.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every read lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../../stores/studioAppStore': {
        getBuilderSession: async (appId, userId) => {
            touched.push({ appId, userId });
            return appId === 'app1' ? { sessionId: 's1', messages: [] } : null;
        },
    },
    '../../../auth/permissions': { requireAuth: pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:app-builder-snapshot-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /appStudioBuilder[\\/]sessionSnapshot\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./sessionSnapshot');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function dispatch({ method, url }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = url.split('?');
        const query = Object.fromEntries(new URLSearchParams(search));
        const req = {
            method, url, originalUrl: url, path: pathname, body: undefined, query, headers: {},
            session: { isAuthenticated: true, user: { id: 'u1' } }, get() { return undefined; },
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

test('a version the route cannot serve is refused by name, not answered with the latest', async () => {
    const res = await dispatch({ method: 'GET', url: '/session/app1?version=3' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.match(res.body.error, /version/);
    assert.deepStrictEqual(touched, []);
});

test('the plain request the builder sends on mount still rehydrates, scoped to the caller', async () => {
    const res = await dispatch({ method: 'GET', url: '/session/app1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { snapshot: { sessionId: 's1', messages: [] } });
    assert.deepStrictEqual(touched, [{ appId: 'app1', userId: 'u1' }]);
});
