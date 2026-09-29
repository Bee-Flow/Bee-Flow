/**
 * What the licence routes accept, and what they say when they refuse
 * (routes/license.js).
 *
 * `scope` decides WHOSE licence a request is about, and both routes matched it
 * with `=== 'server'`, letting every other value fall through to "infer from
 * the session". A typo therefore never failed; it picked another licence:
 * `DELETE /deactivate?scope=Server` removed the caller's ORGANISATION licence
 * and said `{ success: true }`, and `scope: 'organization'` from someone with
 * no organisation activated a personal licence. What this file pins:
 *
 *   - an unknown scope is refused in a sentence, before any licence is touched;
 *   - the two scopes the screens send (none, and 'server') still work;
 *   - a refused request never reaches activate/deactivate.
 *
 * Run: cd server && node --test routes/license.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every licence mutation lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../license': {
        COMMUNITY_FALLBACK: 'community',
        tiers: { normalizeTier: (t) => t },
        activateLicense: async (args) => { touched.push({ what: 'activate', args: [args] }); return { tier: 'enterprise', ...args }; },
        deactivateLicenseForScope: async (args) => { touched.push({ what: 'deactivate', args: [args] }); return true; },
        getLicenseStatus: async () => ({ tier: 'enterprise' }),
        store: {
            getActiveLicenseForOrg: async () => null,
            getActiveLicenseForUser: async () => null,
        },
    },
    '../auth/permissions': {
        SystemRoles: { SUPER_ADMIN: 'admin' },
        Permissions: { ADMIN_SUBSCRIPTIONS: 'admin_subscriptions' },
        isOrgAdminRole: (role) => role === 'org_admin',
        hasPermission: async () => false,
        resolveUserOrgIds: async () => new Set(),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:license-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]license\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./license');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

// A super-admin who is also in an organisation: the caller for whom a
// mistyped `?scope=server` used to land on the org licence.
const SUPER_IN_ORG = {
    isAuthenticated: true, isAdmin: true,
    user: { id: 'u1', role: 'admin', organizationId: 'org1', orgRole: 'org_admin' },
};
const NO_ORG = { isAuthenticated: true, user: { id: 'u2', organizationId: null } };

function dispatch({ method, url, body, query = {}, session = SUPER_IN_ORG }) {
    return new Promise((resolve, reject) => {
        // `ip` and `app` are what express-rate-limit reads to key the limiter.
        const req = {
            method, url, originalUrl: url, path: url.split('?')[0], body, query, headers: {},
            ip: '127.0.0.1', app: { get: () => false }, session, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false, _headers: {},
            status(c) { this.statusCode = c; return this; },
            setHeader(k, v) { this._headers[k] = v; },
            getHeader(k) { return this._headers[k]; },
            append() { return this; },
            set() { return this; },
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

// ── deactivate ──────────────────────────────────────────────────────

test('?scope=Server is refused, instead of removing the organisation licence', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/deactivate', query: { scope: 'Server' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error,
        "scope is 'server' for the server-wide licence — or leave it out to remove your organisation's or your own.");
    assert.ok(res.body.details.some((d) => d.path === 'query.scope'));
    assert.deepStrictEqual(touched, [], 'no licence was deactivated');
});

test('any other scope word is refused too — it used to deactivate the organisation licence', async () => {
    for (const scope of ['sever', 'consumer', 'organization']) {
        const res = await dispatch({ method: 'DELETE', url: '/deactivate', query: { scope } });
        assert.strictEqual(res.statusCode, 400, scope);
        assert.ok(res.body.details.some((d) => d.path === 'query.scope'));
    }
    assert.deepStrictEqual(touched, [], 'no licence was deactivated');
});

test('an unknown query key on deactivate is refused', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/deactivate', query: { scpoe: 'server' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('?scope=server still removes the server-wide licence', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/deactivate', query: { scope: 'server' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'deactivate', args: [{ scope: 'server', deactivatedBy: 'u1' }] }]);
});

test('no scope still removes the organisation licence, as the settings screen expects', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/deactivate' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].args[0].organizationId, 'org1');
});

// ── activate ────────────────────────────────────────────────────────

test('a mistyped server scope is refused, instead of landing on the organisation', async () => {
    const res = await dispatch({ method: 'POST', url: '/activate', body: { token: 'eyJ.x.y', scope: 'servr' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error,
        "scope is 'organization', 'consumer' or 'server' — or leave it out to use your organisation's.");
    assert.deepStrictEqual(touched, []);
});

test('a missing token is refused in words', async () => {
    const res = await dispatch({ method: 'POST', url: '/activate', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Paste the licence token (the long text starting with "ey").');
    assert.deepStrictEqual(touched, []);
});

test('"organization" without an organisation is refused, not made personal', async () => {
    const res = await dispatch({
        method: 'POST', url: '/activate', body: { token: 'eyJ.x.y', scope: 'organization' }, session: NO_ORG,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'no_organization');
    assert.deepStrictEqual(touched, []);
});

test('the token is trimmed once, by the schema, on its way to activation', async () => {
    const res = await dispatch({ method: 'POST', url: '/activate', body: { token: '  eyJ.x.y\n', scope: 'server' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'activate').args[0].token, 'eyJ.x.y');
});

// ── refresh ─────────────────────────────────────────────────────────

test('refresh takes no options — one it would ignore is refused', async () => {
    const res = await dispatch({ method: 'POST', url: '/refresh', body: { licenseId: 'lic-1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/licenseId/.test(res.body.error), res.body.error);
});
