/**
 * What /users/me/leave-org accepts, and what it says when it refuses
 * (auth/admin/leaveOrgRoutes.js).
 *
 * This route detaches the caller from their organisation and re-parents every
 * agent they own to somebody else, so the body naming that somebody is the
 * whole request. The existing check was already a refusal rather than a silent
 * default; what the schema adds is the key. `transferToo` used to be read as
 * "no target named" and answered with a message about a field the caller
 * believed they had sent. What this file pins:
 *
 *   - the 400 NAMES the field (`body.transferTo`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request moves nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/admin/leaveOrgRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
const pass = (req, res, next) => next();
const hit = (what) => (...args) => { touched.push({ what, args }); };

const MOCKS = {
    '../permissions': {
        requireAuth: pass, invalidatePermissionCache: async () => {}, isOrgAdminRole: () => false,
    },
    './orgAdminGuards': { wouldOrphanOrg: async () => false },
    '../../stores/userStore': {
        getUser: async (id) => ({ id, organizationId: 'orgA', orgRole: 'member' }),
        updateUser: hit('updateUser'),
        logAccessAudit: async () => {},
    },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:leave-org-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /admin[\\/]leaveOrgRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./leaveOrgRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: session || { user: { id: 'u1' } }, get() { return undefined; },
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
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('a leave-org with no target is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/users/me/leave-org', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'transferTo (user id) is required');
    assert.ok(res.body.details.some((d) => d.path === 'body.transferTo'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled target key is refused rather than read as absent', async () => {
    await refuses({ method: 'POST', url: '/users/me/leave-org', body: { transferToo: 'u2' } }, 'body');
});

test('a numeric target is refused by name instead of being looked up', async () => {
    await refuses({ method: 'POST', url: '/users/me/leave-org', body: { transferTo: 42 } }, 'body.transferTo');
});
